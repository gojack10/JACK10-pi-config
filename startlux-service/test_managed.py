"""Real pinned tokenizer + upstream pipeline, fake backend. No MLX import."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

from startlux_decide.managed import validate_payload, preflight, MODEL_ID, CONTEXT, WORK_TOKENS
from unittest.mock import patch
from startlux_decide.modelcfg import load_model_folder, load_tokenizer
from startlux_decide.pipeline import Decider, default_controls
from startlux_decide.controls import RequestError
from startlux_decide.prompt import count_tokens

MODEL = Path.home()/'.local/share/startlux/models/016dd9459af81a1cd62011f849dba7ce52aff795'

class FakeBackend:
    caches_prefixes = streams = reads_images = False
    context_length = CONTEXT
    name = 'fake-no-gpu'
    def __init__(self, tok): self.tokenizer, self.prompts = tok, []
    def lane(self): return self
    async def readout(self, prompt, letters, **kw):
        self.prompts.append(prompt)
        assert count_tokens(self.tokenizer, prompt) <= CONTEXT
        return list(range(len(letters)))

class GuardTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tok = load_tokenizer(str(MODEL))
        cls.folder = load_model_folder(str(MODEL))

    def setUp(self):
        self.backend = FakeBackend(self.tok)
        self.d = Decider(self.folder, self.backend, default_controls(self.folder, none_check=True), context_length=CONTEXT)

    def body(self, n=2, **changes):
        b = {'model': MODEL_ID, 'state': 'test evidence', 'questions': {'q': {'type': 'choice', 'instructions': 'Pick the option', 'criteria': {str(i): 'option '+str(i) for i in range(n)}}}}
        b.update(changes)
        return b

    async def run_body(self, b):
        validate_payload(b)
        return await self.d.decide(b['state'], b['questions'], self.d.controls(b))

    async def test_choice_rounds_and_listed_argmax(self):
        for n, rounds in ((2,1),(25,1),(26,3),(64,4)):
            self.backend.prompts.clear()
            result = await self.run_body(self.body(n))
            a = result.answers['q']
            self.assertEqual(len(self.backend.prompts), rounds)
            self.assertEqual(set(a['probabilities']), set(map(str, range(n))))
            self.assertAlmostEqual(sum(a['probabilities'].values()), 1)
            self.assertIsNotNone(a['choice'])
            self.assertEqual(a['probabilities'][a['choice']], max(a['probabilities'].values()))
            self.assertEqual(result.usage['output_tokens'], 0)

    async def test_score_limits(self):
        for n in (2, 10):
            b=self.body(); b['questions']['q']={'type':'score','instructions':'rate','criteria':['low']*n}
            result=await self.run_body(b)
            self.assertEqual(result.answers['q']['type'], 'score')
        b['questions']['q']['criteria']=['low']*11
        with self.assertRaises(ValueError): validate_payload(b)

    async def test_noul(self):
        b=self.body(); b['questions']['q']={'type':'noul','instructions':'true?'}
        self.assertEqual((await self.run_body(b)).answers['q']['type'], 'noul')

    async def test_second_question_oversize_rejects_before_first_read(self):
        b=self.body(); b['questions']['long']={'type':'choice','instructions':'x '*(CONTEXT+100),'criteria':{'a':None,'b':None}}
        with self.assertRaises(RequestError): await self.run_body(b)
        self.assertEqual(self.backend.prompts, [])

    async def test_wide_envelope_rejects_before_groups(self):
        b=self.body(64,state='long '*(CONTEXT//2))
        with self.assertRaises(RequestError): await self.run_body(b)
        self.assertEqual(self.backend.prompts, [])

    async def test_deduplicated_group_description_cannot_expand_in_final_after_gpu(self):
        from startlux_decide.prompt import from_systemone, messages, plain_prompt
        b = self.body(26)
        criteria = {'named': 'criterion', 'option 1': 'option'+' '*700000+'1',
                    **{str(i):'criterion '+str(i) for i in range(24)}}
        b['questions']['q']['criteria'] = criteria
        q, = self.d.prepare(b['state'], b['questions'], none_check=True)
        self.assertTrue(all(count_tokens(self.tok, p) < CONTEXT for p in q.group_prompts))
        # This is a possible native finalist set; all listed ids are bare.
        finalists = ['option 1','0','1','12','13','14']
        final = plain_prompt(self.tok, messages(from_systemone(b['state'],
            dict(q.spec, criteria={k:criteria[k] for k in finalists}), True)))
        self.assertGreater(count_tokens(self.tok, final), 4096)
        with patch('startlux_decide.managed.CONTEXT', 4096), self.assertRaises(RequestError):
            await self.run_body(b)
        self.assertEqual(self.backend.prompts, [])

    async def test_reserved_none_anywhere_rejects_before_groups(self):
        b=self.body(64); b['questions']['q']['criteria']['None of the above']='reserved'
        # 65 choices is rejected by the public guard, and a 64-wide collision
        # is rejected by exact upstream rendering in whole-request preflight.
        del b['questions']['q']['criteria']['0']
        with self.assertRaises((RequestError,ValueError)): await self.run_body(b)
        self.assertEqual(self.backend.prompts, [])

    async def test_work_budget_rejects_before_first_question(self):
        b=self.body(state='test '*1100); b['questions']={str(i):b['questions']['q'] for i in range(256)}
        with self.assertRaises(RequestError): await self.run_body(b)
        self.assertEqual(self.backend.prompts, [])

    async def test_unsupported_controls_are_not_ignored(self):
        for changes in ({'winnow':{'diagnostics':True}}, {'images':[]}, {'think_mode':'auto'}, {'allow_none':True}, {'unknown':True}):
            with self.assertRaises(ValueError): validate_payload(self.body(**changes))
        b=self.body(); b['questions']['q']['allow_none']=True
        with self.assertRaises(ValueError): validate_payload(b)

    async def test_none_off_retains_upstream(self):
        result=await self.run_body(self.body(none_check=False))
        self.assertNotIn('none_probability',result.answers['q'])

    async def test_byte_level_bound_covers_bare_id_visibility_and_unicode_finalists(self):
        import random
        from startlux_decide.prompt import from_systemone, messages, plain_prompt
        spec = json.loads(self.tok.backend_tokenizer.to_str())
        self.assertEqual(spec['normalizer'], {'type': 'NFC'})
        normalizer = self.tok.backend_tokenizer.normalizer
        self.assertGreater(len(normalizer.normalize_str('\u0344').encode()), len('\u0344'.encode()))
        self.assertEqual(spec['model']['type'], 'BPE')
        self.assertIn('ByteLevel', json.dumps(spec['pre_tokenizer']))
        rng = random.Random(713)
        for none_check in (True, False):
            for n in (26, 64):
                b = self.body(n, none_check=none_check, state={'unicode': 'é 漢字 👩🏽‍💻 \u0344 <|im_start|>'})
                criteria = {str(i) if i % 2 else 'named-'+str(i):
                            ('é 漢字 \u0344' if i % 3 else None) for i in range(n)}
                b['questions']['q']['criteria'] = criteria
                ctl = self.d.controls(b)
                q, = self.d.prepare(b['state'], b['questions'], none_check=ctl.none_check)
                work = preflight(self.d, b['state'], [q])
                if not q.groups:
                    continue
                bound = work - sum(count_tokens(self.tok, p) for p in q.group_prompts)
                for _ in range(40):
                    finalists = [c for group in q.groups for c in rng.sample(group, 3)]
                    row = from_systemone(b['state'], dict(q.spec,
                        criteria={c: criteria[c] for c in finalists}), q.none)
                    final = plain_prompt(self.tok, messages(row))
                    normalized = normalizer.normalize_str(final)
                    self.assertLessEqual(count_tokens(self.tok, final), len(normalized.encode('utf-8')))
                    self.assertLessEqual(max(len(final.encode('utf-8')), len(normalized.encode('utf-8'))), bound)
        self.assertEqual(self.backend.prompts, [])

    async def test_exact_configured_render_and_work_boundary(self):
        from startlux_decide.prompt import plain_prompt
        b = self.body(state='x ')
        q, = self.d.prepare(b['state'], b['questions'], none_check=True)
        overhead = count_tokens(self.tok, plain_prompt(self.tok, q.msgs)) - 1
        b['state'] = 'x ' * (CONTEXT-overhead)
        q, = self.d.prepare(b['state'], b['questions'], none_check=True)
        self.assertEqual(count_tokens(self.tok, plain_prompt(self.tok, q.msgs)), CONTEXT)
        self.assertEqual(preflight(self.d, b['state'], [q]), CONTEXT)
        n = WORK_TOKENS // CONTEXT
        self.assertEqual(preflight(self.d, b['state'], [q]*n), WORK_TOKENS)
        with self.assertRaises(RequestError): preflight(self.d, b['state'], [q]*(n+1))
        b['state'] += 'x '
        q, = self.d.prepare(b['state'], b['questions'], none_check=True)
        with self.assertRaises(RequestError): preflight(self.d, b['state'], [q])
        self.assertEqual(self.backend.prompts, [])

    async def test_shared_state_is_counted_once_in_final_envelope(self):
        b = self.body(64, state='evidence '*7000)
        items = self.d.prepare(b['state'], b['questions'], none_check=True)
        work = preflight(self.d, b['state'], items)
        self.assertLess(work, WORK_TOKENS)
        self.assertGreater(work, 4*7000)

    async def test_no_gpu_import(self):
        await self.run_body(self.body())
        self.assertFalse(any(k=='mlx' or k.startswith('mlx.') for k in sys.modules))

class MetalOnlyTests(unittest.TestCase):
    def test_native_error_is_logged_and_rethrown_without_algorithm_change(self):
        from types import ModuleType
        from unittest.mock import MagicMock, patch
        from startlux_decide.backends.mlx import MLXBackend
        mlx, core = ModuleType('mlx'), ModuleType('mlx.core')
        mlx.core = core; core.float32 = object()
        backend = object.__new__(MLXBackend)
        backend.bidirectional = True
        backend._inputs = lambda *a: ([], None, None, None)
        backend._forward = MagicMock()
        backend._letter_rows = MagicMock()
        h = backend._forward.return_value.__getitem__.return_value
        z = h.astype.return_value.__matmul__.return_value
        z.__getitem__.return_value.tolist.side_effect = RuntimeError('Metal allocation fixture')
        with patch.dict(sys.modules, {'mlx':mlx, 'mlx.core':core}):
            with self.assertLogs('startlux_decide.backends.mlx', level='ERROR') as logs:
                with self.assertRaisesRegex(RuntimeError, 'Metal allocation fixture'):
                    backend._readout('public synthetic fixture', [1,2])
        self.assertIn('Metal allocation fixture', logs.output[0])

    def test_installed_loader_refuses_cpu_and_selects_gpu_before_load(self):
        from types import ModuleType, SimpleNamespace
        from unittest.mock import Mock, patch
        from startlux_decide.backends.mlx import MLXBackend
        mlx, core, vlm, utils = (ModuleType(n) for n in ('mlx', 'mlx.core', 'mlx_vlm', 'mlx_vlm.utils'))
        mlx.core = core
        vlm.utils = utils
        core.metal = SimpleNamespace(is_available=lambda: False)
        core.gpu = object()
        core.set_default_device = Mock()
        core.set_cache_limit = Mock()
        utils.load_model = Mock(side_effect=RuntimeError('stop before weights'))
        utils.load_processor = Mock()
        backend = object.__new__(MLXBackend)
        backend.path = str(MODEL)
        with patch.dict(sys.modules, {'mlx':mlx, 'mlx.core':core, 'mlx_vlm':vlm, 'mlx_vlm.utils':utils}):
            with self.assertRaisesRegex(RuntimeError, 'requires Apple Metal'):
                backend._load()
            utils.load_model.assert_not_called()
            core.set_default_device.assert_not_called()
            core.metal.is_available = lambda: True
            with self.assertRaisesRegex(RuntimeError, 'stop before weights'):
                backend._load()
            core.set_default_device.assert_called_once_with(core.gpu)
        self.assertNotIn('mlx', sys.modules)


if __name__=='__main__': unittest.main()
