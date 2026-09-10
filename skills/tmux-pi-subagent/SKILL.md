---
name: tmux-pi-subagent
description: "Launches task or dialogue Pi leaf agents through the canonical subagent transport. Task leaves require a verified report and structured outcome; dialogue leaves return settled exchanges. Use whenever SHOTGUN or another RLM workflow delegates a probe, implementation, or verification mission."
argument-hint: "[leaf mission]"
---

SHOTGUN tree: `ebc1156f-2fcf-424e-bf56-238e910497fc`
Canonical procedure node: `f7bf9107-0f0e-4420-b1cc-b0e55149daca`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current ceremony with the supplied mission. If the node cannot be read, halt rather than guessing from memory.
