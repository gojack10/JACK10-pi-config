---
name: tmux-pi-subagent
description: "Launches a steerable Pi leaf agent in a named tmux session and wakes the parent when each agent turn fully settles. Use whenever SHOTGUN or another RLM workflow delegates a probe, implementation, or verification mission."
argument-hint: "[leaf mission]"
---

SHOTGUN tree: `f0000000-0000-4000-8000-62ccd64177ba`
Canonical procedure node: `f0000000-0000-4000-8000-c335ca59c24d`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current ceremony with the supplied mission. If the node cannot be read, halt rather than guessing from memory.
