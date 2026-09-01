---
name: tmux-pi-subagent
description: "Launches a steerable Pi leaf agent in a named tmux session and wakes the parent when each agent turn fully settles. Use whenever SHOTGUN or another RLM workflow delegates a probe, implementation, or verification mission."
argument-hint: "[leaf mission]"
---

SHOTGUN tree: `ebc1156f-2fcf-424e-bf56-238e910497fc`
Canonical procedure node: `f7bf9107-0f0e-4420-b1cc-b0e55149daca`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current ceremony with the supplied mission. If the node cannot be read, halt rather than guessing from memory.
