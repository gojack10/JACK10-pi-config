"""Combined OpenAI and local-model gateway for the Codex desktop picker."""
import asyncio

from aiohttp import ClientSession, ClientTimeout, web
from multidict import CIMultiDict

OPENAI_BASE = 'https://chatgpt.com/backend-api/codex'
TIMEOUT = ClientTimeout(total=None, sock_connect=15, sock_read=None)
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'}


def request_headers(request, local_key):
    authorization = request.headers.get('Authorization', '')
    if not authorization.startswith('Bearer ') or authorization == 'Bearer ' + local_key:
        raise web.HTTPUnauthorized(text='The combined gateway requires ChatGPT sign-in')
    excluded = HOP_HEADERS | {'cookie', 'x-gateway-key'}
    excluded.update(value.strip().lower() for value in request.headers.get('Connection', '').split(','))
    return CIMultiDict((key, value) for key, value in request.headers.items()
                      if key.lower() not in excluded and not key.lower().startswith('x-pi-'))


def response_headers(response):
    excluded = HOP_HEADERS | {'set-cookie'}
    excluded.update(value.strip().lower() for value in response.headers.get('Connection', '').split(','))
    return CIMultiDict((key, value) for key, value in response.headers.items()
                      if key.lower() not in excluded)


async def while_connected(request, operation):
    """Cancel cloud I/O on disconnect, including before its first response byte.

    The server keeps handler cancellation off for native GPU cleanup. Cloud
    forwarding has no native lease and must not hold maintenance after its
    downstream client disappears. This is not an inference timeout.
    """
    task = asyncio.create_task(operation)
    try:
        while not task.done():
            if request.transport is None or request.transport.is_closing():
                raise ConnectionResetError('Codex client disconnected')
            await asyncio.wait({task}, timeout=0.1)
        return await task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def catalog(request, local_models, local_key):
    headers = request_headers(request, local_key)
    # The combined body differs from OpenAI's body, so its conditional cache
    # validators cannot be forwarded or reused for this catalog.
    for name in ('If-None-Match', 'If-Modified-Since'):
        headers.popall(name, None)
    headers['Accept-Encoding'] = 'identity'
    async with ClientSession(timeout=TIMEOUT) as session:
        async with session.get(OPENAI_BASE + '/models', params=request.query,
                               headers=headers, allow_redirects=False) as upstream:
            if upstream.status != 200:
                return web.Response(status=upstream.status, text=await upstream.text(),
                                    content_type=upstream.content_type)
            data = await upstream.json()
    models = data['models']
    existing = {model['slug'] for model in models}
    priority = max((model.get('priority', 0) for model in models), default=0) + 1
    for model in local_models['models']:
        if model['slug'] not in existing:
            models.append(dict(model, priority=priority))
            priority += 1
    return web.json_response(data, headers={'Cache-Control': 'private, no-store'})


async def forward(request, local_key, body=None):
    """Forward to the fixed OpenAI origin without retaining credentials or prompts."""
    headers = request_headers(request, local_key)
    tail = request.match_info['tail']
    if body is None and request.can_read_body:
        body = await request.read()
    async with ClientSession(timeout=TIMEOUT, auto_decompress=False) as session:
        async with session.request(request.method, OPENAI_BASE + '/' + tail,
                params=request.query, data=body, headers=headers,
                allow_redirects=False) as upstream:
            response = web.StreamResponse(status=upstream.status, headers=response_headers(upstream))
            await response.prepare(request)
            try:
                async for chunk in upstream.content.iter_any():
                    await response.write(chunk)
                await response.write_eof()
            except ConnectionError:
                # Closing the upstream context cancels only this OpenAI request.
                return response
            return response
