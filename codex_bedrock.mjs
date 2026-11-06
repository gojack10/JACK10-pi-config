/** Bedrock entry point for the Pi provider stream adapter. */
import { run } from "./codex_pi_stream.mjs";

const model = "us.anthropic.claude-opus-5-5";
await run({ slug: model, provider: "amazon-bedrock", id: model });
