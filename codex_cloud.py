"""Catalog and pipe transport for Codex models backed by Pi providers."""
import asyncio
import json
import os
from pathlib import Path
import shutil

from aiohttp import web

import codex_provider
from codex_gateway import gateway_config

ROOT = Path(__file__).resolve().parent
# Slug, helper arguments, and display metadata are shared by startup and dispatch.
MODELS = {
    'muse-wonder-full-1.0': ('codex_meta.mjs', (), 'muse-wonder-full-1.0',
                             'Meta Muse subscription through Pi'),
    'us.anthropic.claude-opus-5-5': ('codex_bedrock.mjs', (), 'us.anthropic.claude-opus-5-5',
                                    'Claude Opus 5.5 through Amazon Bedrock'),
    'gpt-6.1-sol-zdr': ('codex_pi_stream.mjs', ('openai', 'gpt-6.1-sol'), 'GPT-6.1 Sol - ZDR',
                       'OpenAI API through Pi with response storage disabled'),
    'muse-wonder-1.0': ('codex_meta.mjs', (), 'Muse Wonder 1.0',
                       'Meta Muse subscription through Pi'),
    'muse-wonder-openrouter': ('codex_pi_stream.mjs', ('openrouter', 'meta/muse-wonder'),
                              'Meta Muse Wonder - OpenRouter', 'OpenRouter through Pi'),
}
_catalog = {}


def node_command():
    config = gateway_config()
    node = os.getenv('CODEX_PI_NODE') or config.get('node') or shutil.which('node')
    if not node:
        raise RuntimeError('Configure node in local/codex-gateway.json or set CODEX_PI_NODE')
    path = Path(node).expanduser()
    return str(path if path.is_absolute() else ROOT / path)


async def load_catalog(model):
    helper, args, display_name, description = MODELS[model]
    process = await asyncio.create_subprocess_exec(node_command(), str(ROOT / helper), '--catalog', model, *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        stdout, _ = await process.communicate()
    finally:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        await asyncio.shield(process.wait())
    data = json.loads(stdout)
    if process.returncode:
        raise RuntimeError(data.get('error', {}).get('message', 'Pi cloud adapter did not start'))
    entry = codex_provider.model_catalog([dict(data, name=data['id'])])['models'][0]
    entry.update(display_name=display_name, description=description,
        input_modalities=data['input_modalities'],
        default_reasoning_level=data['thinking_levels'][-1],
        supported_reasoning_levels=[dict(effort=level, description=f'{level.capitalize()} reasoning')
                                   for level in data['thinking_levels']])
    _catalog[model] = entry


def catalog():
    return list(_catalog.values())


async def forward(request, payload):
    model = payload['model']
    helper, args, _, _ = MODELS[model]
    process = await asyncio.create_subprocess_exec(node_command(), str(ROOT / helper), model, *args,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL)
    response = None
    try:
        session = request.headers.get('session-id') or request.headers.get('thread-id')
        envelope = json.dumps({'payload': payload, 'session_id': session}, separators=(',', ':'))
        process.stdin.write(envelope.encode() + b'\n')
        await process.stdin.drain()
        line = await process.stdout.readline()
        if not line:
            raise RuntimeError('Pi cloud adapter exited before response headers')
        result = json.loads(line)
        if result['status'] != 200:
            return web.json_response({'error': result['error']}, status=result['status'])
        response = web.StreamResponse(headers={
            'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'})
        await response.prepare(request)
        while chunk := await process.stdout.read(65536):
            await response.write(chunk)
        await process.wait()
        if process.returncode and process.returncode < 0:
            raise RuntimeError('Pi cloud adapter was interrupted')
        await response.write_eof()
        return response
    except (ConnectionError, asyncio.CancelledError):
        raise
    except Exception as exc:
        if response is not None and response.prepared:
            failure = {'type': 'error', 'code': 'cloud_gateway_error', 'message': str(exc)}
            await response.write(('event: error\ndata: ' + json.dumps(failure) + '\n\n').encode())
            await response.write_eof()
            return response
        raise web.HTTPBadGateway(text=str(exc)) from exc
    finally:
        # Closing the pipe aborts cloud inference. Pi's already-started OAuth
        # refresh retains its own lock until the refreshed credential is saved.
        process.stdin.close()
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        await asyncio.shield(process.wait())
