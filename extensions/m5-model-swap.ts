/**
 * M5 Model Swap Extension
 *
 * Detects when a rapid-mlx model is selected in Pi and automatically reloads
 * Rapid-MLX via the M5 dashboard (port 8765) to serve that model.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DASHBOARD_URL = "http://127.0.0.1:8765";
const RAPID_MLX_PROVIDER = "rapid-mlx";
const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 120; // 60 seconds max wait

interface ServedModel {
  id: string;
}

async function fetchStatus(): Promise<{ running: boolean; served_models?: ServedModel[] }> {
  const res = await fetch(`${DASHBOARD_URL}/api/rapid-mlx/status`);
  return res.json() as any;
}

async function startModel(modelId: string): Promise<void> {
  await fetch(`${DASHBOARD_URL}/api/rapid-mlx/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  });
}

export default function (pi: ExtensionAPI) {
  let swapping = false;

  pi.on("model_select", async (event, ctx) => {
    // Ignore non-rapid-mlx models
    if (event.model.provider !== RAPID_MLX_PROVIDER) return;

    // Prevent concurrent swaps
    if (swapping) return;

    const targetId = event.model.id;
    const modelName = event.model.name ?? targetId;

    try {
      swapping = true;

      // Check if already serving the right model
      const status = await fetchStatus();
      const currentIds = status.served_models?.map((m: ServedModel) => m.id) ?? [];
      if (currentIds.includes(targetId)) return;

      ctx.ui.setStatus("m5-swap", `Loading ${modelName}...`);

      // Trigger the swap via dashboard
      await startModel(targetId);

      // Poll until the new model is live
      let attempts = 0;
      while (attempts < MAX_POLL_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        attempts++;

        const s = await fetchStatus();
        const ids = s.served_models?.map((m: ServedModel) => m.id) ?? [];
        if (ids.includes(targetId)) {
          ctx.ui.setStatus("m5-swap", `${modelName} ready`);
          setTimeout(() => ctx.ui.setStatus("m5-swap", ""), 2000);
          return;
        }
      }

      ctx.ui.notify(`Timed out waiting for ${modelName}`, "error");
    } catch (err: any) {
      ctx.ui.notify(`Model swap failed: ${err.message}`, "error");
    } finally {
      swapping = false;
    }
  });
}
