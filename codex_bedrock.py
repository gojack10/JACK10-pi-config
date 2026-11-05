"""Bedrock model catalog and pipe transport through the installed Pi provider."""
from pathlib import Path

import codex_meta

MODEL = 'us.anthropic.claude-opus-5-5'
HELPER = Path(__file__).with_suffix('.mjs')
_catalog = None


async def load_catalog():
    global _catalog
    _catalog = await codex_meta.read_catalog(HELPER, 'Claude Opus 5.5 through Amazon Bedrock')


def catalog():
    return {'models': [_catalog] if _catalog else []}


async def forward(request, payload):
    return await codex_meta.forward(request, payload, helper=HELPER)
