import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

type TodoStatus = "open" | "done";

interface Todo {
  id: number;
  text: string;
  status: TodoStatus;
}

interface TreeMutation {
  ts: number;
  tool: string;
  summary: string;
}

// Trigger early compaction relative to the active model's context window.
// Hysteresis prevents immediate re-compaction loops after a compact+rehydrate.
const FIRE_AT_PERCENT = 50;
const REARM_AT_PERCENT = 42;
const MIN_MS_BETWEEN_COMPACTIONS = 30_000;

const UUID_GLOBAL = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const MUTATING_IDEATION_TOOLS = new Set<string>([
  "ideation_create_node",
  "ideation_create_tree",
  "ideation_delete_node",
  "ideation_duplicate_node",
  "ideation_link_by_name",
  "ideation_move_node",
  "ideation_move_cross_tree",
  "ideation_promote_to_root",
  "ideation_rename_node",
  "ideation_reorder_children",
  "ideation_resolve",
  "ideation_mark_stuck",
  "ideation_set_priority",
  "ideation_set_scope",
  "ideation_set_vitals",
  "ideation_edit_crystallization",
  "ideation_edit_scope",
  "ideation_edit_section",
  "ideation_crystallize_append",
  "ideation_crystallize_replace",
  "ideation_add_ruled_out",
  "ideation_add_warning",
  "ideation_defer",
  "ideation_discard",
  "ideation_activate",
]);

const BASE_COMPACT_RULES = [
  "Preserve the exact todo list state: every todo id, todo text, and todo status shown in the conversation.",
  "Add a 'Tree State Mutations' section listing every ideation_* call that created, modified, or deleted state this session, in chronological order, one per line, with the tool name and key arguments.",
].join(" ");

const formatArgsBrief = (input: Record<string, unknown>): string => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (parts.length >= 4) {
      parts.push("...");
      break;
    }
    if (typeof v === "string") {
      const trimmed = v.length > 60 ? `${v.slice(0, 57)}...` : v;
      parts.push(`${k}=${JSON.stringify(trimmed)}`);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      parts.push(`${k}=${v}`);
    } else {
      parts.push(`${k}=...`);
    }
  }
  return parts.join(", ");
};

interface PersistedState {
  todos: Todo[];
  nextTodoId: number;
}

interface PriorSessionTodos {
  sessionId: string;
  sessionFile: string;
  jsonlTimestamp: string;
  openCount: number;
  todos: Todo[];
}

const normalizeTodos = (value: unknown): { todos: Todo[]; migrated: boolean } => {
  if (!Array.isArray(value)) return { todos: [], migrated: false };
  let migrated = false;
  const todos: Todo[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      migrated = true;
      continue;
    }
    const todo = raw as {
      id?: unknown;
      text?: unknown;
      status?: unknown;
      blockedReason?: unknown;
    };
    if (typeof todo.id !== "number" || typeof todo.text !== "string") {
      migrated = true;
      continue;
    }
    const status: TodoStatus = todo.status === "done" ? "done" : "open";
    if (todo.status !== status || todo.blockedReason !== undefined) migrated = true;
    todos.push({
      id: todo.id,
      text: todo.text,
      status,
    });
  }
  return { todos, migrated };
};

const formatRelativeTime = (isoLike: string): string => {
  // Filenames use 2026-04-16T21-48-16-213Z — convert back to real ISO.
  const m = isoLike.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!m) return isoLike;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return isoLike;
  const deltaMs = Date.now() - then;
  const min = Math.round(deltaMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
};

const scanPriorSessions = (sessionDir: string, currentSessionId: string): PriorSessionTodos[] => {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const results: PriorSessionTodos[] = [];
  const todoFiles = entries.filter((f) => f.startsWith(".todo-loop-") && f.endsWith(".json"));
  for (const f of todoFiles) {
    const sid = f.slice(".todo-loop-".length, -".json".length);
    if (sid === currentSessionId) continue;
    try {
      const data = JSON.parse(readFileSync(join(sessionDir, f), "utf-8")) as PersistedState;
      const normalized = normalizeTodos(data.todos);
      const open = normalized.todos.filter((t) => t.status === "open");
      if (open.length === 0) continue;
      const jsonlMatch = entries.find((x) => x.endsWith(`_${sid}.jsonl`));
      if (!jsonlMatch) continue;
      const timestamp = jsonlMatch.split("_")[0];
      results.push({
        sessionId: sid,
        sessionFile: join(sessionDir, jsonlMatch),
        jsonlTimestamp: timestamp,
        openCount: open.length,
        todos: normalized.todos,
      });
    } catch {}
  }
  results.sort((a, b) => b.jsonlTimestamp.localeCompare(a.jsonlTimestamp));
  return results;
};

export default function todoLoop(pi: ExtensionAPI) {
  const todos: Todo[] = [];
  const idsObserved = new Set<string>();
  const treeMutations: TreeMutation[] = [];
  let nextTodoId = 1;
  let todoToolsRegistered = false;
  let unlockArmed = false;
  let compacting = false;
  let compactArmed = true;
  let lastCompactAttemptAt = 0;
  let lastSeenModelKey: string | undefined;

  let statePath: string | undefined;
  let pumpTimer: NodeJS.Timeout | undefined;
  let lastNudgeAt = 0;
  let nudgeCtx: { isIdle: () => boolean; hasPendingMessages: () => boolean } | undefined;
  const MIN_NUDGE_INTERVAL_MS = 1000;
  let setWidget: ((key: string, content: string[] | undefined) => void) | undefined;
  let widgetVisible = false; // Hidden by default — use /todo to show
  // Prior sessions (same cwd) with open todos — populated on session_start and
  // surfaced via widget / `/todos-resume` so the user can pick up after closing a chat.
  let priorSessions: PriorSessionTodos[] = [];
  // Hard-stop flag: set when the user aborts a turn (escape). While true, the
  // loop stops sending SYSTEM nudges. Cleared on the next non-aborted turn_end,
  // so typing any real message resumes the loop.
  let pausedByAbort = false;
  // Loop mode: only active after explicit /todo-loop command. When false,
  // the extension acts as a plain todo list with no auto-nudge.
  let loopActive = false;
  const WIDGET_KEY = "todo-loop";

  const renderWidget = (): string[] => {
    // Pi caps string-array widgets at 10 lines (MAX_WIDGET_LINES). We trim
    // from the TOP (older todos) so the widget always shows the freshest
    // progress — the full list is available via `/todos`.
    const WIDGET_BUDGET = 10;
    const lines: string[] = [];
    if (todos.length === 0) {
      lines.push("todos: (none)");
      if (!todoToolsRegistered) {
        lines.push("run /todo to activate todo tools");
      }
      if (loopActive) {
        lines.push("loop: active — Esc pauses");
      }
      if (priorSessions.length > 0) {
        lines.push("/todo-sessions to browse prior sessions");
      }
      return lines;
    }
    lines.push("todos:");
    const available = WIDGET_BUDGET - 1; // minus header
    const needTruncation = todos.length > available;
    const shown = needTruncation ? todos.slice(-(available - 1)) : todos;
    if (needTruncation) {
      lines.push(`... ${todos.length - shown.length} earlier`);
    }
    for (const t of shown) {
      const box = t.status === "done" ? "[x]" : "[ ]";
      lines.push(`- ${box} ${t.id}. ${t.text}`);
    }
    return lines;
  };

  const refreshWidget = (): void => {
    if (!setWidget) return;
    setWidget(WIDGET_KEY, widgetVisible ? renderWidget() : undefined);
  };

  const loadState = (): void => {
    if (!statePath || !existsSync(statePath)) return;
    try {
      const data = JSON.parse(readFileSync(statePath, "utf-8")) as PersistedState;
      if (typeof data.nextTodoId !== "number") return;
      const normalized = normalizeTodos(data.todos);
      todos.length = 0;
      todos.push(...normalized.todos);
      nextTodoId = data.nextTodoId;
      if (normalized.migrated) saveState();
    } catch {}
  };

  const saveState = (): void => {
    if (!statePath) return;
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      const data: PersistedState = { todos, nextTodoId };
      writeFileSync(statePath, JSON.stringify(data, null, 2));
    } catch {}
  };

  const renumberTodos = (): void => {
    for (let i = 0; i < todos.length; i++) {
      todos[i].id = i + 1;
    }
    nextTodoId = todos.length + 1;
  };

  const openTodos = () => todos.filter((t) => t.status === "open");

  const syncRenameToolAvailability = (): void => {
    const active = new Set(pi.getActiveTools());
    if (unlockArmed) active.add("todo_rename");
    else active.delete("todo_rename");
    pi.setActiveTools([...active]);
  };

  const recordIdsFrom = (text: string): void => {
    const matches = text.match(UUID_GLOBAL);
    if (!matches) return;
    for (const m of matches) idsObserved.add(m.toLowerCase());
  };

  const renderTodoList = (): string => {
    if (todos.length === 0) return "(none)";
    return todos
      .map((t) => {
        const box = t.status === "done" ? "[x]" : "[ ]";
        return `  ${box} ${t.id}. ${t.text}`;
      })
      .join("\n");
  };

  const buildCompactInstructions = (): string => {
    const parts: string[] = [BASE_COMPACT_RULES];
    if (treeMutations.length > 0) {
      const lines = treeMutations
        .map((m) => `  ${new Date(m.ts).toISOString().slice(11, 19)}  ${m.summary}`)
        .join("\n");
      parts.push(
        `\n\nTree state mutations this session (preserve all of these in 'Tree State Mutations'; chronological):\n${lines}`,
      );
    }
    return parts.join("");
  };

  // ============================================================
  // Todo tools — registered dynamically on /todo command
  // ============================================================

  const registerTodoTools = (): void => {
    if (todoToolsRegistered) return;
    todoToolsRegistered = true;

    pi.registerTool({
      name: "todo_create",
      label: "todo_create",
      description:
        "Create a list of todos. The agent will not stop iterating until every todo is checked with todo_check. Once todos exist, further todo_create calls are rejected until the list is empty or the user runs /todo-unlock. Use for multi-step work that must complete in one session.",
      parameters: Type.Object({
        items: Type.Array(Type.String(), {
          minItems: 1,
          description: "Short, imperative descriptions, one per todo (e.g. 'Write failing test for parser').",
        }),
      }),
      async execute(_id, { items }) {
        // Models sometimes JSON-serialize the array before passing it, producing a
        // single-element items array whose only entry is a JSON array string.
        // Unwrap that case so ["a","b","c"] passed as a string still creates 3 todos.
        if (items.length === 1) {
          const only = items[0].trim();
          if (only.startsWith("[")) {
            try {
              const parsed: unknown = JSON.parse(only);
              if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
                items = parsed as string[];
              }
            } catch {}
          }
        }
        const open = openTodos().length;
        if (open > 0 && !unlockArmed) {
          return {
            content: [
              {
                type: "text",
                text: `ERROR: cannot create new todos while ${open} existing todo${open === 1 ? " is" : "s are"} still open. Finish them with todo_check(id) first. Alternatively, ask the user to run /todo-unlock to permit adding more.`,
              },
            ],
            isError: true,
          };
        }
        unlockArmed = false;
        syncRenameToolAvailability();
        const added: Todo[] = items.map((text) => ({
          id: 0,
          text,
          status: "open" as const,
        }));
        todos.push(...added);
        renumberTodos();
        saveState();
        refreshWidget();
        return {
          content: [
            {
              type: "text",
              text: `Created ${added.length} todo${added.length === 1 ? "" : "s"}.\nCurrent list:\n${renderTodoList()}`,
            },
          ],
          details: { todos: todos.map((t) => ({ ...t })) },
        };
      },
    });

    pi.registerTool({
      name: "todo_check",
      label: "todo_check",
      description: "Mark a todo as done. Call this immediately when a todo's work is finished.",
      parameters: Type.Object({
        id: Type.Integer({ description: "Todo id." }),
      }),
      async execute(_id, { id }) {
        const t = todos.find((x) => x.id === id);
        if (!t) {
          return {
            content: [{ type: "text", text: `ERROR: no todo with id ${id}. Call todo_list() to see current state.` }],
            isError: true,
          };
        }
        if (t.status !== "open") {
          return {
            content: [{ type: "text", text: `ERROR: todo ${id} is already ${t.status}.` }],
            isError: true,
          };
        }
        t.status = "done";
        saveState();
        refreshWidget();
        return {
          content: [{ type: "text", text: `Checked #${id}.\nCurrent list:\n${renderTodoList()}` }],
          details: { todos: todos.map((t) => ({ ...t })) },
        };
      },
    });

    pi.registerTool({
      name: "todo_move",
      label: "todo_move",
      description:
        "Reorder an existing todo by moving it to a new 1-based position. After the move, all todo ids are renumbered 1..N in the new order, so `to` names the todo's new id. `to` is clamped to [1, list length]. Does not change text or status.",
      parameters: Type.Object({
        id: Type.Integer({ description: "Todo id to move (references the id as shown in the current list)." }),
        to: Type.Integer({ description: "1-based target position. The moved todo will have id=to after the call. Clamped to [1, list length]." }),
      }),
      async execute(_id, { id, to }) {
        const fromIdx = todos.findIndex((t) => t.id === id);
        if (fromIdx === -1) {
          return {
            content: [{ type: "text", text: `ERROR: no todo with id ${id}. Call todo_list() to see current state.` }],
            isError: true,
          };
        }
        const [moved] = todos.splice(fromIdx, 1);
        const toIdx = Math.max(0, Math.min(to - 1, todos.length));
        todos.splice(toIdx, 0, moved);
        renumberTodos();
        saveState();
        refreshWidget();
        return {
          content: [{ type: "text", text: `Moved #${id} → #${toIdx + 1}. All ids renumbered.\nCurrent list:\n${renderTodoList()}` }],
          details: { todos: todos.map((t) => ({ ...t })) },
        };
      },
    });

    pi.registerTool({
      name: "todo_rename",
      label: "todo_rename",
      description:
        "Rename an existing todo. This tool is only available after the user runs /todo-unlock, and the unlock is consumed by the next successful todo_create or todo_rename call.",
      parameters: Type.Object({
        id: Type.Integer({ description: "Todo id." }),
        text: Type.String({ description: "New short, imperative todo text." }),
      }),
      async execute(_id, { id, text }) {
        if (!unlockArmed) {
          return {
            content: [{ type: "text", text: "ERROR: todo_rename is locked. Ask the user to run /todo-unlock first." }],
            isError: true,
          };
        }
        const t = todos.find((x) => x.id === id);
        if (!t) {
          return {
            content: [{ type: "text", text: `ERROR: no todo with id ${id}. Call todo_list() to see current state.` }],
            isError: true,
          };
        }
        const nextText = text.trim();
        if (nextText.length === 0) {
          return {
            content: [{ type: "text", text: "ERROR: todo text cannot be empty." }],
            isError: true,
          };
        }
        const previousText = t.text;
        t.text = nextText;
        unlockArmed = false;
        syncRenameToolAvailability();
        saveState();
        refreshWidget();
        return {
          content: [{ type: "text", text: `Renamed #${id}: ${JSON.stringify(previousText)} → ${JSON.stringify(nextText)}.\nCurrent list:\n${renderTodoList()}` }],
          details: { todos: todos.map((t) => ({ ...t })) },
        };
      },
    });

    pi.registerTool({
      name: "todo_list",
      label: "todo_list",
      description: "Return the current todo list (all statuses). Use this to re-sync after compaction.",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: renderTodoList() }],
          details: { todos: todos.map((t) => ({ ...t })) },
        };
      },
    });

    refreshWidget();
  };

  // ============================================================
  // Slash commands
  // ============================================================

  pi.registerCommand("todo", {
    description: "Activate todo tools and show the todo widget (no auto-loop).",
    handler: async (_args, ctx) => {
      registerTodoTools();
      widgetVisible = true;
      refreshWidget();
      const open = openTodos().length;
      if (open > 0) {
        ctx.ui.notify(
          `Todo tools activated — ${open} open todo${open === 1 ? "" : "s"} loaded. Run /todos to see them.`,
          "info",
        );
      } else {
        ctx.ui.notify("Todo tools activated. The LLM can now create and manage todos.", "info");
      }
    },
  });

  pi.registerCommand("todo-loop", {
    description: "Activate the todo auto-loop: agent will be nudged until all todos are done.",
    handler: async (_args, ctx) => {
      registerTodoTools();
      widgetVisible = true;
      loopActive = true;
      refreshWidget();
      const open = openTodos().length;
      if (open > 0) {
        ctx.ui.notify(
          `Todo loop activated — ${open} open todo${open === 1 ? "" : "s"}. Agent will be nudged until all done. Esc pauses.`,
          "info",
        );
        // Kick off the loop immediately
        nudgeCtx = { isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages() };
        kickPump();
      } else {
        ctx.ui.notify(
          "Todo loop activated. Agent will be nudged whenever todos are open. Esc pauses.",
          "info",
        );
      }
    },
  });

  pi.registerCommand("todo-sessions", {
    description: "Browse and resume prior sessions that have open todos.",
    handler: async (_args, ctx) => {
      if (priorSessions.length === 0) {
        ctx.ui.notify("No prior sessions with open todos in this cwd.", "info");
        return;
      }

      const items: SelectItem[] = priorSessions.map((p, i) => {
        const short = p.sessionId.slice(0, 8);
        const label = `${i + 1}. ${short}`;
        const desc = `${p.openCount} open todo${p.openCount === 1 ? "" : "s"} (${formatRelativeTime(p.jsonlTimestamp)})`;
        return { value: p.sessionFile, label, description: desc };
      });

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Prior Sessions with Open Todos")), 1, 0));
        container.addChild(new Text(theme.fg("dim", `${priorSessions.length} session${priorSessions.length === 1 ? "" : "s"} in this cwd`), 1, 0));

        const selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter resume • esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
        };
      });

      if (!result) return;

      const switchResult = await ctx.switchSession(result);
      if (switchResult.cancelled) {
        ctx.ui.notify("Resume cancelled.", "info");
      }
    },
  });

  pi.registerCommand("todo-unlock", {
    description: "Allow the model to use one locked todo mutation on its next successful todo_create or todo_rename call.",
    handler: async (_args, ctx) => {
      unlockArmed = true;
      syncRenameToolAvailability();
      ctx.ui.notify("Locked todo mutation unlocked for next successful todo_create or todo_rename", "info");
    },
  });

  pi.registerCommand("todo-reset", {
    description: "Clear all todos and deactivate the todo loop.",
    handler: async (_args, ctx) => {
      const cleared = todos.length;
      todos.length = 0;
      nextTodoId = 1;
      unlockArmed = false;
      loopActive = false;
      syncRenameToolAvailability();
      saveState();
      refreshWidget();
      ctx.ui.notify(`Cleared ${cleared} todo${cleared === 1 ? "" : "s"}`, "info");
    },
  });

  pi.registerCommand("todos-resume", {
    description: "Switch to a prior session in this cwd that still has open todos. Arg: index (1-based) or session id prefix. No arg = list.",
    handler: async (args, ctx) => {
      if (priorSessions.length === 0) {
        ctx.ui.notify("No prior sessions with open todos in this cwd.", "info");
        return;
      }
      const arg = (args ?? "").trim();
      if (!arg) {
        const lines = priorSessions.map((p, i) => {
          const short = p.sessionId.slice(0, 8);
          return `  ${i + 1}. ${short} — ${p.openCount} open (${formatRelativeTime(p.jsonlTimestamp)})`;
        });
        ctx.ui.notify(`Prior sessions with open todos:\n${lines.join("\n")}\n\nRun: /todos-resume <n|id-prefix>`, "info");
        return;
      }
      let target: PriorSessionTodos | undefined;
      const asIndex = Number.parseInt(arg, 10);
      if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= priorSessions.length) {
        target = priorSessions[asIndex - 1];
      } else {
        const lc = arg.toLowerCase();
        target = priorSessions.find((p) => p.sessionId.toLowerCase().startsWith(lc));
      }
      if (!target) {
        ctx.ui.notify(`No match for "${arg}". Run /todos-resume with no args to list.`, "warning");
        return;
      }
      const result = await ctx.switchSession(target.sessionFile);
      if (result.cancelled) {
        ctx.ui.notify("Resume cancelled.", "info");
      }
    },
  });

  pi.registerCommand("todos-toggle", {
    description: "Show or hide the todo list widget above the editor.",
    handler: async (_args, ctx) => {
      widgetVisible = !widgetVisible;
      refreshWidget();
      ctx.ui.notify(`Todo widget ${widgetVisible ? "shown" : "hidden"}`, "info");
    },
  });

  pi.registerCommand("todos", {
    description: "Show current todos and recent tree-state activity.",
    handler: async (_args, ctx) => {
      const recentMutations = treeMutations.slice(-10);
      const mutText =
        recentMutations.length === 0
          ? "(none)"
          : recentMutations
              .map((m) => `  ${new Date(m.ts).toISOString().slice(11, 19)}  ${m.summary}`)
              .join("\n");
      const idsText = idsObserved.size === 0 ? "(none)" : `${idsObserved.size} unique`;
      ctx.ui.notify(
        `Todos:\n${renderTodoList()}\n\nRecent tree mutations (last 10 of ${treeMutations.length}):\n${mutText}\n\nObserved identifiers: ${idsText}`,
        "info",
      );
    },
  });

  // ============================================================
  // Events
  // ============================================================

  pi.on("tool_result", async (event) => {
    const name = event.toolName;
    if (!name.startsWith("ideation_")) return;
    const text = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    recordIdsFrom(text);
    try {
      recordIdsFrom(JSON.stringify(event.input));
    } catch {}
    if (!event.isError && MUTATING_IDEATION_TOOLS.has(name)) {
      treeMutations.push({
        ts: Date.now(),
        tool: name,
        summary: `${name}(${formatArgsBrief(event.input)})`,
      });
    }
  });

  // Single self-pumping nudge loop. Every event (turn_end, session_compact,
  // session_start, /todo-loop) just calls kickPump(); the pump itself decides
  // whether to nudge, wait, or stop. Idempotent — if a timer is already
  // pending, additional kicks are no-ops.
  const pump = (): void => {
    pumpTimer = undefined;
    if (!loopActive || pausedByAbort) return;
    if (!todoToolsRegistered) return;
    if (openTodos().length === 0) return;
    const ctx = nudgeCtx;
    if (!ctx) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      pumpTimer = setTimeout(pump, 150);
      return;
    }
    const elapsed = Date.now() - lastNudgeAt;
    if (elapsed < MIN_NUDGE_INTERVAL_MS) {
      pumpTimer = setTimeout(pump, MIN_NUDGE_INTERVAL_MS - elapsed);
      return;
    }
    lastNudgeAt = Date.now();
    const open = openTodos().length;
    pi.sendUserMessage(
      `SYSTEM (todo-loop): continue — ${open} open todo${open === 1 ? "" : "s"}. Call todo_list() for state. Do not stop until every todo is checked.`,
    );
  };

  const kickPump = (): void => {
    if (pumpTimer) return;
    pumpTimer = setTimeout(pump, 50);
  };

  pi.on("session_start", async (_event, ctx) => {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();
    statePath = join(sessionDir, `.todo-loop-${sessionId}.json`);
    loadState();
    syncRenameToolAvailability();
    priorSessions = scanPriorSessions(sessionDir, sessionId);
    setWidget = (key, content) => ctx.ui.setWidget(key, content);
    refreshWidget();
    nudgeCtx = { isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages() };
    if (todos.length > 0) {
      ctx.ui.notify(
        `${todos.length} todo${todos.length === 1 ? "" : "s"} loaded from previous session (${openTodos().length} open). Run /todo to activate todo tools.`,
        "info",
      );
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    // Hard stop on escape: never nudge on an aborted turn, and drop any
    // already-scheduled nudge so we don't fire after the user bailed.
    if (event.message.stopReason === "aborted") {
      if (pumpTimer) {
        clearTimeout(pumpTimer);
        pumpTimer = undefined;
      }
      if (!pausedByAbort) {
        pausedByAbort = true;
        ctx.ui.notify("Todo loop paused (escape). Send any message to resume.", "warning");
      }
      return;
    }
    // Any non-aborted turn re-enables the loop — typing "continue" (or
    // anything else) picks up where we left off.
    pausedByAbort = false;

    // In `/cc start` mode the claude -p subprocess owns the conversation and
    // its own compaction. Pi's token counter reflects only the ferry buffer,
    // so firing ctx.compact() here would summarize a view, not the real session.
    const inClaudeCodeMode = ctx.model?.provider === "claude-code";
    const usage = ctx.getContextUsage();
    const modelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    if (modelKey !== lastSeenModelKey) {
      lastSeenModelKey = modelKey;
      compactArmed = true;
    }
    if (usage?.percent != null && usage.percent <= REARM_AT_PERCENT) {
      compactArmed = true;
    }
    if (
      loopActive &&
      !inClaudeCodeMode &&
      !compacting &&
      compactArmed &&
      usage?.percent != null &&
      Date.now() - lastCompactAttemptAt >= MIN_MS_BETWEEN_COMPACTIONS &&
      usage.percent >= FIRE_AT_PERCENT
    ) {
      compacting = true;
      compactArmed = false;
      lastCompactAttemptAt = Date.now();
      ctx.compact({
        customInstructions: buildCompactInstructions(),
        onComplete: () => {
          compacting = false;
          lastCompactAttemptAt = Date.now();
        },
        onError: () => {
          compacting = false;
          lastCompactAttemptAt = Date.now();
        },
      });
      return;
    }
    nudgeCtx = { isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages() };
    kickPump();
  });

  pi.on("session_compact", async (_event, ctx) => {
    compacting = false;
    compactArmed = false;
    lastCompactAttemptAt = Date.now();
    nudgeCtx = { isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages() };
    kickPump();
  });

  pi.on("session_shutdown", async () => {
    if (pumpTimer) {
      clearTimeout(pumpTimer);
      pumpTimer = undefined;
    }
  });
}
