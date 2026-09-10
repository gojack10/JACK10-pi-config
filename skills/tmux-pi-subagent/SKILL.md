---
name: tmux-pi-subagent
description: "Launches task or dialogue Pi leaf agents through the canonical subagent transport. Task leaves require a verified report and structured outcome; dialogue leaves return settled exchanges. Use whenever SHOTGUN or another RLM workflow delegates a probe, implementation, or verification mission."
argument-hint: "[leaf mission]"
---

SHOTGUN tree: `f0000000-0000-4000-8000-62ccd64177ba`
Canonical procedure node: `f0000000-0000-4000-8000-c335ca59c24d`

Before acting, call `sifttext_get_node` on the canonical procedure node and follow its current ceremony with the supplied mission. If the node cannot be read, halt rather than guessing from memory.
