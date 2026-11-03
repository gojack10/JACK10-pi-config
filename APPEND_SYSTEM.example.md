## SiftText

SiftText is persistent memory across chats.

At the start of every new chat, unless told not to use SiftText, before any other tool call:
1. Run `sifttext instructions`.
2. Read its returned entry and follow any `agent-instructions`.
3. Before retrieving knowledge, read the retrieval guide named by its help index.

Keep machine-specific instruction paths and knowledge identities in the ignored `APPEND_SYSTEM.md`, not this template.

## Tooling policy

- Never directly invoke `python`, `python3`, `pip`, or `pip3` unless explicitly instructed by the human.
- Use `uv` for agent-initiated Python execution, scripts, CLI tools and dependencies; preserve project lockfiles.
- For an unavailable non-Python tool, use `nix run nixpkgs#<package> -- <args>` or a temporary `nix shell`.
- Suggest recurring tools as durable configuration changes; do not install them durably without permission.
