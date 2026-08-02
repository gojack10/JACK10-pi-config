import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

// Inline DynamicBorder to avoid importing theme.js (36KB) → chalk/cli-highlight/typebox chain
class InlineBorder {
	constructor(private color: (s: string) => string) {}
	invalidate() {}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function openThinkingPicker(pi: ExtensionAPI, ctx: ExtensionContext) {
  const current = pi.getThinkingLevel() as ThinkingLevel;
  const items: SelectItem[] = LEVELS.map((level) => ({
    value: level,
    label: level === current ? `${level} (current)` : level,
  }));
  const initialIndex = Math.max(0, LEVELS.indexOf(current));

  const selected = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new InlineBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Thinking level")), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.setSelectedIndex(initialIndex);
    selectList.onSelect = (item) => done(item.value as ThinkingLevel);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
    container.addChild(new InlineBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!selected) return;

  pi.setThinkingLevel(selected);

  const actual = pi.getThinkingLevel() as ThinkingLevel;
  ctx.ui.notify(
    actual === selected ? `Thinking: ${actual}` : `Thinking: ${selected} → ${actual}`,
    "info",
  );
}

export default function thinkingPicker(pi: ExtensionAPI) {
  pi.registerShortcut("shift+tab", {
    description: "Pick thinking level",
    handler: async (ctx) => {
      await openThinkingPicker(pi, ctx);
    },
  });

  pi.registerCommand("thinking", {
    description: "Pick or set thinking level",
    getArgumentCompletions: (prefix) => {
      const items = LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({
        value: level,
        label: level,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim() as ThinkingLevel | "";
      if (!requested) {
        await openThinkingPicker(pi, ctx);
        return;
      }

      if (!LEVELS.includes(requested as ThinkingLevel)) {
        ctx.ui.notify(`Invalid thinking level: ${requested}`, "error");
        return;
      }

      pi.setThinkingLevel(requested as ThinkingLevel);
      const actual = pi.getThinkingLevel() as ThinkingLevel;
      ctx.ui.notify(
        actual === requested ? `Thinking: ${actual}` : `Thinking: ${requested} → ${actual}`,
        "info",
      );
    },
  });
}
