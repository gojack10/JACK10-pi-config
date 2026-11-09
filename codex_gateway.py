"""Combined OpenAI and local-model gateway for the Codex desktop picker."""
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import re

from aiohttp import ClientConnectorError, ClientSession, ClientTimeout, web
from multidict import CIMultiDict

from codex_provider import invalid

OPENAI_BASE = 'https://chatgpt.com/backend-api/codex'
LOCAL_BASE = 'http://127.0.0.1:8002/v1'
TIMEOUT = ClientTimeout(total=None, sock_connect=15, sock_read=None)
LOCAL_TIMEOUT = ClientTimeout(total=None, sock_connect=2, sock_read=None)
HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'}
FOREIGN_REASONING_IDS = ('rs_local_', 'rs_meta_', 'rs_bedrock_', 'rs_openai_api_', 'rs_openrouter_')
PI_REASONING_ENVELOPES = ('pi-meta-v1:', 'pi-bedrock-v1:', 'pi-openai-api-v1:', 'pi-openrouter-v1:')
LEGACY_LOCAL_REASONING_ID = re.compile(r'rs_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}')
COMPACTION_HANDOFF = re.compile(r'\[Codex handoff for (cmp_[\w-]+)\]\n\S')


def gateway_config():
    default = Path(__file__).resolve().parent / 'local/codex-gateway.json'
    path = Path(os.getenv('CODEX_GATEWAY_CONFIG', str(default))).expanduser()
    return json.loads(path.read_text()) if path.exists() else {}


def portable_compaction_input(items, native_replay_prefix=None):
    """Replay a text handoff in place of opaque compaction state."""
    if not isinstance(items, list):
        return items
    if not any(isinstance(item, dict) and item.get('type') == 'compaction' for item in items):
        return items
    handoffs = set()
    for item in items:
        if not isinstance(item, dict) or item.get('type') != 'message' or item.get('role') not in ('assistant', 'user'):
            continue
        content = item.get('content')
        if isinstance(content, list):
            for part in content:
                if (isinstance(part, dict) and part.get('type') in ('input_text', 'output_text')
                        and isinstance(part.get('text'), str)):
                    match = COMPACTION_HANDOFF.match(part['text'])
                    if match:
                        handoffs.add(match[1])
    replay = []
    for item in items:
        if not isinstance(item, dict) or item.get('type') != 'compaction':
            replay.append(item)
            continue
        identity = item.get('id')
        encrypted = item.get('encrypted_content')
        if native_replay_prefix and isinstance(encrypted, str) and encrypted.startswith(native_replay_prefix):
            replay.append(item)
            continue
        if isinstance(identity, str) and identity in handoffs:
            continue
        digest = sha256(encrypted.encode()).hexdigest() if isinstance(encrypted, str) else ''
        text = gateway_config().get('compaction_handoffs', {}).get(digest)
        if not text:
            raise invalid('This model needs a text handoff for the encrypted compaction in this chat.')
        replay.append({'type': 'message', 'role': 'assistant', 'content': [
            {'type': 'output_text', 'text': text}]})
    return replay


def openai_body(payload, original):
    """Keep visible foreign history without replaying another provider's state."""
    if not isinstance(payload.get('input'), list):
        return original
    items, changed = [], False
    for item in payload['input']:
        if not isinstance(item, dict):
            items.append(item)
            continue
        identity = item.get('id') or ''
        encrypted = item.get('encrypted_content') or ''
        kind = item.get('type')
        foreign_reasoning = kind == 'reasoning' and (
            isinstance(identity, str) and (identity.startswith(FOREIGN_REASONING_IDS) or
                (not encrypted and LEGACY_LOCAL_REASONING_ID.fullmatch(identity))) or
            isinstance(encrypted, str) and encrypted.startswith(PI_REASONING_ENVELOPES))
        if foreign_reasoning:
            text = '\n'.join(part['text'] for part in
                (item.get('summary') or []) + (item.get('content') or [])
                if isinstance(part, dict) and isinstance(part.get('text'), str))
            if text:
                items.append({'type': 'message', 'role': 'assistant', 'content': [
                    {'type': 'output_text', 'text': text}]})
            changed = True
            continue
        if isinstance(identity, str) and kind in ('message', 'function_call', 'custom_tool_call') and (
                identity.startswith(('msg_meta_', 'fc_meta_', 'ctc_meta_')) or len(identity) > 64 or
                (kind != 'message' and identity.startswith('call_'))):
            # Replay IDs are optional here. Tool result pairing uses call_id,
            # which must remain unchanged when switching providers.
            item = {key: value for key, value in item.items() if key != 'id'}
            changed = True
        items.append(item)
    return json.dumps(dict(payload, input=items), separators=(',', ':')).encode() if changed else original


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

    The gateway owns no native GPU lease. Closing its local upstream leaves
    native cancellation and drain with the local inference proxy. This is not
    an inference timeout.
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
    for model in models:
        model['display_name'] = model['slug']
    return web.json_response(data, headers={'Cache-Control': 'private, no-store'})


async def forward(request, local_key, body=None, *, local=False):
    """Forward only to fixed origins; never send ChatGPT credentials locally."""
    headers = request_headers(request, local_key)
    if local:
        headers['Authorization'] = 'Bearer ' + local_key
        headers.popall('ChatGPT-Account-ID', None)
        url, timeout = LOCAL_BASE + '/responses', LOCAL_TIMEOUT
    else:
        url = OPENAI_BASE + '/' + request.match_info['tail']
        timeout = TIMEOUT
    if body is None and request.can_read_body:
        body = await request.read()
    try:
        async with ClientSession(timeout=timeout, auto_decompress=False) as session:
            async with session.request(request.method, url,
                    params=request.query, data=body, headers=headers,
                    allow_redirects=False) as upstream:
                response = web.StreamResponse(status=upstream.status, headers=response_headers(upstream))
                await response.prepare(request)
                try:
                    async for chunk in upstream.content.iter_any():
                        await response.write(chunk)
                    await response.write_eof()
                except ConnectionError:
                    # The local proxy retains responsibility for native drain.
                    return response
                return response
    except (ClientConnectorError, asyncio.TimeoutError) as exc:
        if local:
            raise web.HTTPServiceUnavailable(
                text='Local inference is unavailable. Cloud models remain available.') from exc
        raise
