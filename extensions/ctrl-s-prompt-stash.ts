import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function ctrlSPromptStash(pi: ExtensionAPI) {
  let stash: string | undefined;
  let restoreGeneration = 0;
  let slashRestorePending = false;

  function clearStash(_ctx: ExtensionContext) {
    stash = undefined;
    slashRestorePending = false;
    restoreGeneration += 1;
  }

  function restoreImmediatelyIfEditorEmpty(ctx: ExtensionContext): boolean {
    if (stash === undefined) return false;
    if (ctx.ui.getEditorText().length !== 0) return false;

    const text = stash;
    clearStash(ctx);
    ctx.ui.setEditorText(text);
    return true;
  }

  function scheduleNormalRestore(ctx: ExtensionContext) {
    const generation = ++restoreGeneration;
    const delays = [0, 25, 100, 250];

    for (const delay of delays) {
      setTimeout(() => {
        if (generation !== restoreGeneration || stash === undefined) return;
        restoreImmediatelyIfEditorEmpty(ctx);
      }, delay);
    }
  }

  function scheduleSlashRestore(ctx: ExtensionContext) {
    const generation = ++restoreGeneration;
    slashRestorePending = true;

    let restoredAtLeastOnce = false;
    const delays = [50, 150, 300, 600, 1000, 1500, 2500, 4000, 6000];

    for (const delay of delays) {
      setTimeout(() => {
        if (generation !== restoreGeneration || stash === undefined) return;

        const current = ctx.ui.getEditorText();

        if (current.length === 0) {
          ctx.ui.setEditorText(stash);
          restoredAtLeastOnce = true;
          return;
        }

        if (restoredAtLeastOnce && current === stash) {
          clearStash(ctx);
        }
      }, delay);
    }
  }

  pi.on("model_select", async (_event, ctx) => {
    if (!slashRestorePending || stash === undefined) return;
    scheduleSlashRestore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!slashRestorePending || stash === undefined) return;
    scheduleSlashRestore(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!slashRestorePending || stash === undefined) return;
    scheduleSlashRestore(ctx);
  });

  pi.registerShortcut("ctrl+s", {
    description: "Stash or restore the current editor prompt",
    handler: async (ctx) => {
      const current = ctx.ui.getEditorText();

      if (current.trim().length === 0) {
        if (stash !== undefined) {
          const text = stash;
          clearStash(ctx);
          ctx.ui.setEditorText(text);
          ctx.ui.notify("Prompt restored", "info");
        }
        return;
      }

      stash = current;
      slashRestorePending = false;
      restoreGeneration += 1;
      ctx.ui.setEditorText("");
      ctx.ui.notify("Prompt stashed", "info");
    },
  });

  pi.on("input", async (event, ctx) => {
    if (stash === undefined) return { action: "continue" as const };
    if (event.source !== "interactive") return { action: "continue" as const };

    const text = event.text.trim();
    if (text.length === 0) return { action: "continue" as const };

    if (text.startsWith("/")) {
      scheduleSlashRestore(ctx);
      return { action: "continue" as const };
    }

    slashRestorePending = false;
    scheduleNormalRestore(ctx);
    return { action: "continue" as const };
  });
}
