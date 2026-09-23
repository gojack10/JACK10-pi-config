import { randomUUID } from "node:crypto";

export function buildRequestHeaders(
  existing: Record<string, string> = {},
  generatedId = randomUUID(),
  defaultOrigin = process.env.PI_REQUEST_ORIGIN || "user",
) {
  const keys = Object.keys(existing).map((key) => key.toLowerCase());
  return {
    ...(keys.includes("x-pi-request-id") ? {} : { "X-Pi-Request-Id": generatedId }),
    ...(keys.includes("x-pi-origin") ? {} : { "X-Pi-Origin": defaultOrigin }),
    ...existing,
  };
}
