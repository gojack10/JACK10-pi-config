# Floors loopback gateway

Run `node extensions/dark-factory/floors/floors-gateway.mjs` from an approved,
immutable source checkout. No deployment paths, credentials, settings or manifests
are shipped with this entrypoint.

Environment inputs:

- `FACTORY_HOSTING_CONFIG` (required): private, current-user-owned regular JSON
  file with mode 0600 (or stricter), containing the 64-character hex `token` used
  by the existing hosting ingress. Never commit this file.
- `FACTORY_ROOT`: existing floors directory; defaults to the runtime's standard
  `~/.local/state/dark-factory/floors` root.
- `FACTORY_GATEWAY_PORT`: loopback port, default 64375; 0 selects a disposable port.
- `FACTORY_READER_CODE`: absolute source/pin root for reader runtime exports.
  Unset means this checkout. Its board reader must accept the additive floor
  schema (`factory_jobs`, `floor_retirement_input`, `floor_pathfinder`); the tracked reader does.
- `FACTORY_CONTROLLER_CODE`: absolute approved source/pin root for the selected
  floor's `openFloor` and native `ensureFloorController`. Unset means this checkout.
- `FACTORY_CONTROLLER_FLOOR`: selected floor ID, default `core`.
- `FACTORY_ROOM_CODE`: optional separate source/pin root for room server/assets;
  defaults to `FACTORY_READER_CODE`, or this checkout when both are unset.
- `FACTORY_SOURCE_MANIFEST`: optional deployment manifest file; its SHA-256 is
  logged for provenance. The gateway does not generate or change manifests.

Source roots are read once when `wiring.mjs` loads. Reader exports are preserved;
only the selected floor's `openFloor` comes from its approved runtime. The recovery
hook is that runtime's native supervisor export, not a wrapper or alternate policy.
Existing floor launch configuration still determines the controller/worker code
root; changing gateway environment does not rewrite live floor configuration.

Stopped reads do not launch capacity. Start retains native ownership/health checks:
reuse a healthy owned controller, respawn a proven-dead pane without `-k`, refuse
foreign/uncertain ownership, and create a missing parent only without undrained
workers. The gateway binds only `127.0.0.1`; the existing authenticated ingress
remains a separate deployment concern.

Future deployment: build/pin the approved source closure including these entrypoints
and their existing imports/assets; set the environment inputs in the private service
configuration and point its command at the pinned `floors-gateway.mjs`. Reuse the
existing hosting token/port and authorized controller/reader pins, then restart only
the gateway under separate deployment authorization. Do not press Start as a deploy
check: authenticated stopped-state reads suffice. This source change does not deploy
or restart any service.
