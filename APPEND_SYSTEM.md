## Tooling policy

- Never directly invoke `python`, `python3`, `pip`, or `pip3` unless explicitly instructed by the human.
- Use `uv` for all agent-initiated Python work:
  - Python execution: `uv run python ...`
  - Scripts and tests: `uv run ...`
  - Throwaway dependencies: `uv run --with <package> ...`
  - Python CLI tools: `uvx <tool>`
  - Durable project dependencies: use the project's appropriate `uv` command and preserve its lockfile.
- For non-Python probing or testing with unavailable tools:
  - One executable: `nix run nixpkgs#<package> -- <args>`
  - Temporary environment: `nix shell nixpkgs#<package> ... --command <command>`
- Nix environments are temporary, but downloaded store paths may remain cached until garbage collection.
- If a Nix dependency becomes useful for recurring or future work, tell the human and suggest adding it to the appropriate durable Nix configuration (such as a project flake/dev shell, Home Manager, or nix-darwin configuration). Do not make that durable change unless asked.

## SiftText

SiftText stores evolving memory so you and your agents can save and recover understanding across chats.

SiftText terms
- A tree groups related nodes.
- A node holds knowledge about a question or topic.
- Scope states what a node covers.
- A crystallization records a node’s current understanding.
- SiftText Read recovers relevant knowledge.
- SiftText Commit saves knowledge changes.

At the start of every chat, read and follow the onboarding node below unless you are explicitly told not to use SiftText.

```text
/Users/jack/sifttext/nodes/5e565245-14fe-406c-977c-cf94a9be246b/node.md
```
