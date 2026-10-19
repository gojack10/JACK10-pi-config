"""Managed Instant text-only boundary; upstream owns every decision and prompt.

Copied into the pinned upstream package at provisioning. No MLX import here.
"""
import json
import unicodedata

MODEL_ID = 'startlux-4b-instant'
UPSTREAM_ID = 'StartLux-Decision-v1.1-4B-Instant-MLX-4bit'
CONTEXT = 64000
WORK_TOKENS = 256000
MAX_QUESTIONS = 256


def validate_payload(body):
    if not isinstance(body, dict) or body.get('model') not in (MODEL_ID, UPSTREAM_ID):
        raise ValueError('Explicit model startlux-4b-instant required; legacy aliases retired')
    allowed = {'model', 'state', 'questions', 'think_mode', 'allow_none', 'none_check', 'return_details'}
    if body.keys() - allowed:
        raise ValueError('Unsupported decision controls')
    if body.get('state') is None:
        raise ValueError('StartLux requires state and named questions')
    questions = body.get('questions')
    if not isinstance(questions, dict) or not 1 <= len(questions) <= MAX_QUESTIONS:
        raise ValueError('StartLux requires state and named questions (1-256)')
    if body.get('think_mode', 'never') != 'never' or body.get('allow_none', False) is not False:
        raise ValueError('Managed Instant requires think_mode never and allow_none false')
    for key in ('none_check', 'return_details'):
        if key in body and type(body[key]) is not bool:
            raise ValueError(f'{key} must be boolean')
    for name, q in questions.items():
        if not isinstance(name, str) or not name or not isinstance(q, dict):
            raise ValueError('Named questions must be objects')
        if q.keys() - {'type', 'instructions', 'criteria', 'allow_none'}:
            raise ValueError('Unsupported question fields')
        if q.get('allow_none', False) is not False:
            raise ValueError('Per-question allow_none must be false')
        typ, crit = q.get('type', 'choice'), q.get('criteria')
        if typ == 'choice':
            if not isinstance(crit, dict) or not 2 <= len(crit) <= 64:
                raise ValueError('choice requires 2-64 criteria')
        elif typ == 'score':
            if not isinstance(crit, (list, dict)) or not 2 <= len(crit) <= 10:
                raise ValueError('score requires 2-10 levels')
        elif typ != 'noul':
            raise ValueError('Unsupported question type')
    return body


def preflight(decider, state, items):
    """Whole batch, before _share/_question can enqueue work.

    Known prompts are counted exactly. For a logits-dependent tournament final,
    count fixed rendered state/template ONCE, plus the longest possible option
    lines from each group (upstream wide_keep). Every line bounds both bare-id
    hiding and description suppression. Byte-level BPE has at most one token
    per normalized byte. NFD bytes bound NFC bytes, including NFC expansions
    such as U+0344, and remain additive across fragment boundaries. No prompt,
    tournament, attention or probability calculation is changed.
    _read also checks the actual final prompt as defense in depth.
    """
    from .prompt import count_tokens, from_systemone, messages, plain_prompt, value_text
    from .controls import RequestError
    def byte_bound(text):
        return max(len(text.encode('utf-8')), len(unicodedata.normalize('NFD', text).encode('utf-8')))

    work = 0
    for q in items:
        prompts = list(q.group_prompts)
        if q.msgs is not None:
            prompts.append(plain_prompt(decider.tok, q.msgs))
        counts = [count_tokens(decider.tok, p) for p in prompts]
        if any(n > CONTEXT for n in counts):
            raise RequestError(f'Rendered prompt exceeds managed {CONTEXT}-token limit')
        work += sum(counts)
        if q.groups:
            # Use the trained formatter, with a none line even when disabled.
            # The empty slot leaves an extra A) line: conservative by 3 bytes.
            slot = '__managed_final_slot__'
            while True:
                seed = dict(q.spec, criteria={slot: None})
                skeleton = plain_prompt(decider.tok, messages(from_systemone(state, seed, True)))
                if skeleton.count(slot) == 1:
                    break
                slot += '_'
            bound = byte_bound(skeleton.replace(slot, ''))
            line_bounds = {}
            for key, value in q.spec['criteria'].items():
                # Validate even candidates that no group round will select.
                messages(from_systemone(state, dict(q.spec, criteria={key: value}), True))
                line_bounds[key] = byte_bound('\nZ) ' + key + ': ' + (value_text(value) or ''))
            for group in q.groups:
                bound += sum(sorted((line_bounds[k] for k in group), reverse=True)[:decider.folder.wide_keep])
            if bound > CONTEXT:
                raise RequestError(f'Tournament final envelope exceeds managed {CONTEXT}-token limit')
            work += bound
    if work > WORK_TOKENS:
        raise RequestError(f'Whole-request work exceeds managed {WORK_TOKENS}-token limit')
    return work


if __name__ == '__main__':
    # CPU tokenizer/schema preflight only. Never constructs or imports MLXBackend.
    import sys
    from .modelcfg import load_model_folder, load_tokenizer
    from .pipeline import Decider, default_controls
    from .controls import RequestError
    class TextOnly:
        streams = reads_images = caches_prefixes = False
        context_length = CONTEXT
    try:
        body = validate_payload(json.load(sys.stdin))
        backend = TextOnly()
        backend.tokenizer = load_tokenizer(sys.argv[1])
        folder = load_model_folder(sys.argv[1])
        d = Decider(folder, backend, default_controls(folder, none_check=True), context_length=CONTEXT)
        ctl = d.controls(body)
        items = d.prepare(body['state'], body['questions'], allow_none=ctl.allow_none, none_check=ctl.none_check)
        work = preflight(d, body['state'], items)
        print(json.dumps({'valid': True, 'work_upper_bound': work}))
    except (ValueError, TypeError, RequestError):
        print(json.dumps({'valid': False, 'error': 'Invalid or oversized managed StartLux request'}))
        sys.exit(2)
