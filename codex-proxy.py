"""Independent Codex gateway; local inference is an optional HTTP upstream."""
import asyncio
import json
import logging
import os
from pathlib import Path

from aiohttp import web

import codex_cloud
import codex_gateway
import codex_provider
from local_model_catalog import DS4_MODEL_METADATA, MLX_MODEL_METADATA, mlx_model_metadata

ROOT = Path(__file__).resolve().parent
LISTEN_PORT = int(os.getenv('CODEX_GATEWAY_PORT', '8005'))
PROXY_API_KEY = os.getenv('LOCAL_LLM_PROXY_API_KEY') or (ROOT / '.proxy-key').read_text().strip()
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('codex-proxy')


def local_catalog():
    # Metadata is available even when local inference is stopped or broken.
    return codex_provider.model_catalog([
        dict(id=model, **DS4_MODEL_METADATA[model])
        for model in codex_provider.MODEL_ALIASES.values()])


async def handle_gateway(request):
    codex_gateway.request_headers(request, PROXY_API_KEY)
    tail = request.match_info['tail']
    if request.method == 'GET' and tail == 'models':
        models = {'models': local_catalog()['models'] + codex_cloud.catalog()}
        return await codex_gateway.while_connected(request,
            codex_gateway.catalog(request, models, PROXY_API_KEY))
    if request.method == 'GET' and tail == 'responses':
        raise web.HTTPUpgradeRequired(text='Use streaming HTTP POST /responses')
    if request.method == 'POST' and (tail == 'responses' or tail.startswith('responses/')):
        if request.headers.get('Content-Encoding', 'identity') != 'identity':
            raise web.HTTPUnsupportedMediaType(text='Disable request compression for this gateway')
        body = await request.read()
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            raise codex_provider.invalid('Expected a JSON Responses request')
        if not isinstance(payload, dict):
            raise codex_provider.invalid('Expected a JSON Responses object')
        model = payload.get('model')
        if not isinstance(model, str):
            raise codex_provider.invalid('A model name is required')
        cloud_model = model in codex_cloud.MODELS
        canonical = codex_provider.MODEL_ALIASES.get(model, model)
        local_model = (model in codex_provider.MODEL_ALIASES or canonical in request.app['local_models']
                       or model.endswith('-local'))
        if (cloud_model or local_model) and 'input' in payload:
            native_replay_prefix = 'pi-openai-api-v1:' if model == 'gpt-6.1-sol-zdr' else None
            payload['input'] = codex_gateway.portable_compaction_input(payload['input'], native_replay_prefix)
        if cloud_model:
            if tail != 'responses':
                raise codex_provider.invalid(f'{model} does not support /{tail}')
            operation = codex_cloud.forward(request, payload)
        elif local_model:
            if tail != 'responses':
                raise codex_provider.invalid(
                    f'Local Codex does not support /{tail}; the request was not sent to OpenAI')
            operation = codex_gateway.forward(request, PROXY_API_KEY,
                json.dumps(payload, separators=(',', ':')).encode(), local=True)
        else:
            operation = codex_gateway.forward(request, PROXY_API_KEY,
                codex_gateway.openai_body(payload, body))
        return await codex_gateway.while_connected(request, operation)
    return await codex_gateway.while_connected(request,
        codex_gateway.forward(request, PROXY_API_KEY))


async def load_cloud_catalogs():
    async def load(model):
        try:
            await codex_cloud.load_catalog(model)
            log.info('Pi cloud model catalog loaded: %s', model)
        except Exception as exc:
            log.warning('Pi cloud catalog unavailable (%s): %s', model, exc)
    await asyncio.gather(*(load(model) for model in codex_cloud.MODELS))


async def cloud_catalogs(app):
    # Optional provider setup cannot hold the OpenAI listener or require a GPU.
    task = asyncio.create_task(load_cloud_catalogs())
    yield
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def application():
    app = web.Application(client_max_size=1024 * 1024 * 1024)
    local_models = set(DS4_MODEL_METADATA) | set(MLX_MODEL_METADATA)
    try:
        local_models.update(mlx_model_metadata())
    except Exception as exc:
        log.warning('Private local model metadata unavailable: %s', exc)
    app['local_models'] = local_models
    app.cleanup_ctx.append(cloud_catalogs)
    app.router.add_route('*', '/backend-api/codex/{tail:.*}', handle_gateway)
    app.router.add_get('/health', lambda request: web.json_response({
        'status': 'ok', 'cloud_models': sorted(codex_cloud.MODELS),
        'loaded_cloud_catalogs': len(codex_cloud.catalog()),
        'local_inference_url': codex_gateway.LOCAL_BASE,
    }))
    return app


if __name__ == '__main__':
    # Native drain belongs to :8002; this process can cancel disconnected I/O.
    web.run_app(application(), host='127.0.0.1', port=LISTEN_PORT,
                handler_cancellation=True, access_log=None)
