# Private factory hosting

`hosting.mjs` is a separate dependency-free loopback ingress, not a new room or
factory controller. It wraps the existing room with a single-owner browser Basic
login (like VEGA), exchanged at `/login` for a 24-hour `__Host-factory` cookie:
Secure, HttpOnly, SameSite=Strict, host-only. No account database, Google Access
policy, shared VEGA secret or public capability URL is needed.

All room/static/bootstrap routes require that cookie. The bootstrap script gives
only an authenticated browser with exact `Sec-Fetch-Site: same-origin` the
existing run capability in sessionStorage; it precedes the unchanged room module.
Browsers without Fetch Metadata cannot bootstrap (fail closed). API requests
still require the exact Bearer header and run. Login Basic is never forwarded to the room. External Host/Origin
and Fetch Metadata are checked before Origin is translated to the loopback room.
User-clicked top-level root/login links can enter from another site; that exception
never covers scripts, iframes or API requests. POST requires exact HTTPS Origin and JSON. No identity, executable, proxy header,
DB path or new API enters the room. The adapter forwards only bounded existing
operations and assets; the room keeps its original validation/owner assignment.

## Private configuration and launch

Keep the JSON and generated owner credential in an owned 0700 directory outside
Git, files 0600. Configuration (substitute privately, never paste secrets in logs):

```json
{
  "origin": "https://factory.10server.net",
  "upstream": "http://127.0.0.1:ROOM_PORT",
  "run": "SAVED_RUN",
  "token": "EXISTING_64_HEX_ROOM_CAPABILITY",
  "basic": "Basic BASE64_OF_FACTORY_OWNER_AND_RANDOM_PASSWORD",
  "port": 16475
}
```

Use the saved room port/token from the current run, read-only. Generate a NEW
256-bit random factory password, not VEGA's credential. Run:

```sh
node /absolute/durable/path/hosting.mjs /absolute/private/config.json
```

Startup checks authenticated read-only room state; missing/wrong configuration
fails closed. Bind is always 127.0.0.1. Do not put credentials in argv/env. There
are no request logs. Restarting the adapter invalidates cookies, not the room
capability or factory state. A room port change requires updating private config
and restarting only the adapter. New run selection is an explicit operator change,
not automatic DB discovery/adoption. The adapter is local-user trusted, not an
agent sandbox.

## Existing 10SERVER infrastructure

Use an independently owned reverse SSH forward, remote bind **127.0.0.1 only**:

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 -R 127.0.0.1:16474:127.0.0.1:16475 10server
```

Supervise adapter and forward as separate Mac LaunchAgents with KeepAlive and
throttled restart. Do not edit/restart the existing private SSH/LLM forwards.
Use a factory-only named cloudflared tunnel/container on 10SERVER, reusing its
installed infrastructure but not restarting the shared transcription tunnel/NPM.
Ingress is exact `factory.10server.net` to `http://127.0.0.1:16474` with a final
404 catch-all. TLS terminates at Cloudflare; the remaining hops are host loopback
and SSH. The adapter validates the public HTTPS origin and requires Cloudflare's
edge-overwritten `X-Forwarded-Proto: https`; plaintext edge hops get no Basic
challenge. It never trusts forwarded identity. Preserve Host. Do not put another
public/untrusted proxy in front of this loopback listener. No direct host port,
NPM Basic-auth collision, firewall opening, paid provisioning or private-service
broadcast. A proxied CNAME points only this hostname to the factory tunnel UUID.
Keep tunnel credential files private and outside source control.

## Deployed configuration custody

`hosting-config/` holds the nonsecret installed Mac LaunchAgent plists and
factory-only cloudflared ingress. Their paths are machine-specific; the private
JSON, password and tunnel credentials are deliberately NOT tracked. The adapter
runs a durable source copy at `~/.local/state/bf2-room-hosting/runtime/hosting.mjs`,
independent of this implementation worktree. Update that copy only after review.
The two Mac labels are `com.jack.factory-room-ingress` and
`com.jack.factory-room-tunnel`. Logs live below the owned private directory.

On 10SERVER, the owned config/credential mount is
`/home/jack/.cloudflared/factory-room` (0700; files 0600). The factory container is
`factory-room-cloudflared`, image `cloudflare/cloudflared:2026.6.0`, host networking
but **no published port**, existing user UID/GID, read-only config mount,
`--restart unless-stopped`, `--log-driver none`. Its command is:

```sh
tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
```

This does not edit the shared `vega-config.yml`, NPM hosts or existing containers.
DNS is one proxied factory CNAME to the UUID in `factory-cloudflared.yml`. The
exact creation, acceptance evidence and credential locator belong to the private
execution report, never a tracked password or capability.

## Checks and recovery

```sh
node --test extensions/bf2-swarm/hosting.test.ts extensions/bf2-swarm/room.test.ts extensions/dark-factory/room/*.test.ts
```

Fixtures qualify authenticated cookie/bearer/run/Origin, wrong credentials,
external Host, plaintext edge refusal, cross-site and sibling-site Fetch Metadata, missing Origin/JSON,
body bounds, cookie expiry/duplicates and unchanged local room reachability.
Fixture messages are not live-owner acceptance. Live proof must use read-only
state; never send synthetic JACK messages or Start/Stop/Close to test hosting.
Verify unauthenticated root redirects to the Basic challenge, static/bootstrap/API
are denied, and authenticated page/state load remotely. Keep secrets/private
transcripts out of evidence. Browser refresh updates frontend assets; no room or
controller/worker restart is needed for this adapter. The shared frontend now
lives in `../dark-factory/room/`; `room/` retains per-file symlinks for the running
room server's old static path. See [safe live integration](../dark-factory/room/README.md)
for the asset-first fast-forward sequence; no hosting runtime/configuration change
or ingress restart is required.

Rollback: remove only factory DNS, stop/remove only the factory cloudflared
container, boot out only the two factory LaunchAgents. Retain owned configuration,
credentials and reports privately for recovery; delete the factory tunnel only
once its DNS/container are retired. Existing local room and unrelated services
remain untouched. Source integration into the parent checkout is a separate
coordinated action, not required to run a durable copy of this standalone adapter.
