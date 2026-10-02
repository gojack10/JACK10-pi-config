# Dark Factory

## Sequential dark factory

Runs fresh agents through the canonical tmux subagent transport. The repository owns generic scheduling, locks, route guards, report delivery and continuation. SiftText owns project instructions and completion conditions; no project contract Markdown is shipped or read from this repository.

A local `~/.pi/agent/factory-projects.local.json` maps task names to a `root` instruction-node UUID, explicit `route` (`provider`, `model`, `thinking`) and `ready` disposition. This file is ignored. A prepared `--config` may supply the same `project` object. Non-smoke work refuses to start without an instruction entry; workers read its current authority in SiftText. The default `task` supports read-only smoke without any project identity.

```sh
node extensions/dark-factory/run.mjs smoke task --wait
node extensions/dark-factory/run.mjs start sample --config /private/path/run.json
node extensions/dark-factory/run.mjs status sample
node extensions/dark-factory/run.mjs stop sample
node extensions/dark-factory/run.mjs resume sample
```

Each named task has its own lock and ignored run directory. Planner/worker lanes can coexist with fixed-assignment readers under bounded admission. Reader packets remain separate from aggregate writes. Suite status reports prerequisite, aggregate and reader states with exact assigned/read/excluded/merged counts; exclusions require explicit authority and cannot count as reads.

Advancement requires a structured task outcome, valid JSON report, durable receipt and a closed worker session. Context handoffs retain the role, assignment, report and spent work. Graceful stop admits no successor; interrupted or ambiguous attempts retain their evidence and locks until quiescence is proven. The route guard bounds provider-error retries and never overrides human/policy stops or pending work. Resume never credits an orphan report merely because its file exists. Real attempts have no factory wall-clock deadline, and transport settlement is not project completion.

