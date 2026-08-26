---
name: tmux-pi-subagent
description: "Launches a steerable Pi leaf agent in a named tmux session and wakes the parent when each agent turn fully settles. Use whenever SHOTGUN or another RLM workflow delegates a probe, implementation, or verification mission."
argument-hint: "[leaf mission]"
---

SHOTGUN tree: `ebc1156f-2fcf-424e-bf56-238e910497fc`
Canonical procedure node: `f7bf9107-0f0e-4420-b1cc-b0e55149daca`

Call `sifttext_get_node` on the canonical procedure node and follow its current ceremony with the supplied mission before acting; do not skip this even if you think you remember it.
If the tree or node cannot be read, halt and tell the human rather than guessing the procedure from memory.

## Dispatch lifecycle classification

Classify pasted input **before** arming tmux lifecycle waits:

- **Model turn:** ordinary prompts and commands documented to start an agent keep fresh `@pi_start_channel` plus settled-generation waiting.
- **Local-only command:** paste with `tmux paste-buffer -pr` plus Enter, but arm **no** START or generation waiter. Verify a bounded command-specific acknowledgement, then dispatch any continuation separately with fresh agent channels.
- **Unknown command:** inspect its registered command/source contract first. If it may be local, use a bounded wait and fail closed; never call bare, foreground `tmux wait-for`.

Pi currently exposes no post-command extension event: registered commands bypass `input`. Do not fake `@pi_command_done` from agent or session events; local commands need command-specific ACKs until Pi adds a real completion hook.

Use this bounded wrapper for every START or tmux-channel ACK wait:

```bash
wait_tmux_channel() {
  python3 - "$1" "${2:-30}" <<'PY'
import subprocess
import sys

channel, seconds = sys.argv[1], float(sys.argv[2])
try:
    result = subprocess.run(["tmux", "wait-for", channel], timeout=seconds)
except subprocess.TimeoutExpired:
    print(f"TIMEOUT waiting for tmux channel {channel}", file=sys.stderr)
    raise SystemExit(124)
raise SystemExit(result.returncode)
PY
}

wait_tmux_channel "$START_CHANNEL" 30
```

A timeout is a failed dispatch: preserve the session, pane log, prompt, and options; never report the leaf as running. A settled-generation wait cannot acknowledge a local command because `agent_settled` has no producer either.
