import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

export default function ctrlSPromptStash(pi: ExtensionAPI) {
  let stash: string | undefined;
  let restoreGeneration = 0;
  let slashRestorePending = false;
  let stashWidgetTimer: ReturnType<typeof setTimeout> | undefined;

  function clearStashNotification(ctx: ExtensionContext): void {
    if (stashWidgetTimer) {
      clearTimeout(stashWidgetTimer);
      stashWidgetTimer = undefined;
    }
    ctx.ui.setWidget("prompt-stash", undefined);
  }

  function showStashNotification(ctx: ExtensionContext, message: string): void {
    if (stashWidgetTimer) {
      clearTimeout(stashWidgetTimer);
      stashWidgetTimer = undefined;
    }
    ctx.ui.setWidget("prompt-stash", (tui, thm) => {
      const container = new Container();
      container.addChild(new Spacer(1));
      container.addChild(new Text(thm.fg("text", message), 1, 0));
      return container;
    }, { placement: "aboveEditor" });
    if (message === "Prompt restored") {
      stashWidgetTimer = setTimeout(() => {
        stashWidgetTimer = undefined;
        ctx.ui.setWidget("prompt-stash", undefined);
      }, 3000);
    }
  }

  function clearStash(ctx: ExtensionContext) {
    stash = undefined;
    slashRestorePending = false;
    restoreGeneration += 1;
    clearStashNotification(ctx);
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
          showStashNotification(ctx, "Prompt restored");
        }
        return;
      }

      stash = current;
      slashRestorePending = false;
      restoreGeneration += 1;
      ctx.ui.setEditorText("");
      showStashNotification(ctx, "Prompt stashed");
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
