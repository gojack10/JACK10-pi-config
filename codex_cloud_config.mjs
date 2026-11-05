/** Host paths live in ignored local configuration, with environment overrides. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
let config;

export function gatewayPath(key, environment, fallback) {
  if (config === undefined) {
    try {
      config = JSON.parse(readFileSync(process.env.CODEX_GATEWAY_CONFIG || join(root, "local/codex-gateway.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      config = {};
    }
  }
  const value = process.env[environment] || config[key] || fallback;
  if (typeof value !== "string" || !value) throw new Error(`Configure ${key} in local/codex-gateway.json or set ${environment}`);
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(root, value);
}
