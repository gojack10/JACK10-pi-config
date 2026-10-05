"""Bend-checked model-swap policy bridge for proxy-owned local models.

`/Users/jack/research/bend/swap-policy/swap-cpu` (source + proof in that
directory) is the only decision authority for reuse / stop-then-start swap /
fail-closed refuse / idle release across DS4, mlx-lm and the planned
decision-only Winnow. This module encodes host facts and decodes directives;
it keeps no second transition table. The host still owns the foreign
observations named in SWAP_HOST_CONTRACT.md: native GPU quiescence, service
exit, loaded-model identity, chat ownership and backend readiness.

Fail closed: any missing/foreign binary, malformed reply or timeout freezes
the policy; callers must not recreate it and must not issue a physical effect
that the frozen policy did not authorize.
"""
import hashlib
import socket
import subprocess
from pathlib import Path

POLICY_BINARY = Path('/Users/jack/research/bend/swap-policy/swap-cpu')
POLICY_SHA256 = '69b74155c37e9242640d8c35877379658b7176a5f8a8bbe0ab164acba1231320'
MAX_NAT = 281474976410654

# Host-side identity table. Winnow is declared here for the decision-only model
# whose runtime artifacts have not been located; a request only reaches the
# policy after the host has established qualification.
MODEL_TAGS = {
    'qwen3.8-flash-next': 0,          # DS4 :8001
    'deepseek-v4.1-flash': 1,         # DS4 :8001
    'glm-5.3-flash': 2,               # DS4, separate checkout
    'qwen3.8-27b-uncensored': 3,      # mlx-lm :8000
    'gemma-4-31b-mlx': 4,             # mlx-lm :8000
    'winnow-12b': 5,                  # decision-only, planned
}
TAG_MODELS = {tag: model for model, tag in MODEL_TAGS.items()}

ACTION_TAGS = {0: 'no-action', 1: 'wait', 2: 'reuse', 3: 'stop',
               4: 'start', 5: 'keep', 6: 'unload', 7: 'refuse'}
ACTIONS_WITH_MODEL = {'stop', 'start', 'unload'}


class SwapPolicyError(RuntimeError):
    pass


def port_listening(port):
    """Host-side probe: is a TCP listener on a proxy-owned backend port?

    Listening is NOT native-quiescence evidence and does not prove an engine
    identity; it only proves the port is occupied. A listener that is not the
    managed job is a foreign/unproven engine, so callers fail closed rather
    than overlap it.
    """
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


class SwapPolicy:
    def __init__(self):
        self.state = None
        self.blocked = None
        self._qualified = False

    def _check_binary(self):
        if self._qualified:
            return
        digest = hashlib.sha256(POLICY_BINARY.read_bytes()).hexdigest()
        if digest != POLICY_SHA256:
            raise SwapPolicyError('unqualified swap-policy binary')
        self._qualified = True

    def _invoke(self, args):
        if self.blocked:
            raise SwapPolicyError(f'swap policy blocked: {self.blocked}')
        try:
            self._check_binary()
            result = subprocess.run([str(POLICY_BINARY), '--gpu', 'off', *args],
                                    capture_output=True, check=True, timeout=5)
            text = result.stdout.decode('ascii')
            if result.stderr or not text.endswith('\n') or text.count('\n') != 1:
                raise SwapPolicyError('invalid swap-policy framing')
            parts = text[:-1].split(' ')
            if len(parts) != 3 or parts[0] != 'OK':
                raise SwapPolicyError('invalid swap-policy reply')
            state, action = parts[1], parts[2]
            for field in (state, action):
                if len(field) > 4096 or not field or any(
                        not f.isascii() or not f.isdecimal() or int(f) > MAX_NAT
                        for f in field.split('/')):
                    raise SwapPolicyError('invalid swap-policy fields')
            self.state = state
            return self._decode(action)
        except Exception as exc:
            self.blocked = repr(exc)
            raise SwapPolicyError(f'swap policy unavailable: {self.blocked}') from exc

    def _decode(self, action):
        fields = list(map(int, action.split('/')))
        name = ACTION_TAGS.get(fields[0])
        if name is None:
            raise SwapPolicyError('unknown swap-policy action')
        model = None
        if name in ACTIONS_WITH_MODEL:
            if len(fields) != 2 or fields[1] not in TAG_MODELS:
                raise SwapPolicyError('invalid swap-policy action model')
            model = TAG_MODELS[fields[1]]
        elif len(fields) != 1:
            raise SwapPolicyError('invalid swap-policy action arity')
        return name, model

    def _tag(self, model_id):
        tag = MODEL_TAGS.get(model_id)
        if tag is None:
            raise SwapPolicyError(
                f'model not in the checked swap-policy table: {model_id!r}')
        return str(tag)

    def begin(self):
        if self.state is None:
            self._invoke(['begin'])
        return self.state

    def _event(self, event):
        self.begin()
        return self._invoke([self.state, event])

    def admit(self, model_id, qualified, active=False):
        """Decision for an admitted ordinary request under the host gate."""
        return self._event('0/{}/{}/{}'.format(
            self._tag(model_id), int(bool(qualified)), int(bool(active))))

    def stop_done(self):
        """Host proved the resident stopped (service exit + native drain)."""
        return self._event('1')

    def stop_unknown(self):
        return self._event('2')

    def start_ready(self):
        """Host proved the target resident and ready."""
        return self._event('3')

    def start_unknown(self):
        return self._event('4')

    def adopt(self, model_id):
        """Host proved current loaded-model identity."""
        return self._event('5/' + self._tag(model_id))

    def adopt_empty(self):
        """Host proved no proxy-owned engine is resident."""
        return self._event('6')

    def adopt_unknown(self):
        """Host cannot prove identity: the policy will refuse transitions."""
        return self._event('7')

    def release_done(self):
        return self._event('8')

    def release_unknown(self):
        return self._event('9')

    def recover(self):
        """Host proved a clean supervised state (service exit, no resident,
        drained). Only this clears Uncertain; a mere probe cannot."""
        return self._event('11')

    def abort(self):
        """Host refuses an authorized stop before issuing any effect: the
        proven resident is restored. Never use after a physical attempt."""
        return self._event('12')

    def idle_tick(self, elapsed_ms, timeout_ms, active):
        """Host-computed idle elapsed against the existing host clock."""
        return self._event('10/{}/{}/{}'.format(
            int(elapsed_ms), int(timeout_ms), int(bool(active))))


# One process-wide authority. Every caller already serializes under the shared
# admission condition or the switch lock; no second lock is added.
SWAP = SwapPolicy()
