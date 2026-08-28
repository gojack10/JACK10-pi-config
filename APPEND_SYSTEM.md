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
