# Dark Factory room

Shared browser assets; `extensions/bf2-swarm/room/` keeps its eight relative
compatibility symlinks. Existing BF2 room/hosting servers still serve the same
URLs and use the legacy run API. Updating these assets does not adopt a DB,
restart a service, start workers or change production agent instructions.

## Floors

`extensions/dark-factory/floors/room.mjs` exports:

```js
const { server, origin, token, url } = await serveFloors({ root, port: 0 });
```

It consumes `runtime.mjs` and `supervisor.mjs`, not SQLite directly. The returned
loopback URL carries its owner capability in the fragment. Standalone source
entry: `node extensions/dark-factory/floors/room.mjs [root]`. Creating/starting
floors is the CLI/runtime's responsibility. A server restart without an explicitly
supplied token creates a new capability; don't deploy an ephemeral URL as a fixed
hosted configuration.

The browser discovers floors every second, polls every floor's messages, and
keeps transcript/cursor/status, drafts and failed-send retry keys floor-scoped.
Tabs appear without a server restart. Slots configure 0–10 next occupants;
current occupants, advisory warning threshold and unknown context usage are
shown separately. Removing a slot requests runtime drain, not a browser kill.
The owner condition is editable; its electorate and actual yes count are shown
without assuming three workers. Editing invalidates ballots in the runtime.
OSS-floor selection calls the runtime's drain-before-reassignment operation;
configure a local Qwen slot on the destination first. Selection does not start
a stopped floor.

Settings edits slot route/thinking/role/context settings, the owner condition,
and the optional Pathfinder route and continuation. Pathfinder inherits the
floor's goal, project entry, checkout and permissions; review questions go to
`@PATHFINDER` on the board. Both configuration paths use runtime validation and
SQLite; saving does not start a stopped floor. No browser-selected DB, runtime
source root, executable or sender identity is accepted. Discovery/snapshots omit
DB paths, peer bootstrap instructions and credentials.

## Notifications

Sounds and desktop mentions default **enabled per floor**, with persistent mute
controls. The first click unlocks audio; desktop permission is requested only
by clicking **enable alerts**. Blocked/unavailable permission is displayed.
Peer `@JACK` mentions produce real browser `Notification` instances, even on
unselected floors, and clicking selects that floor. Old history is silent.
Web Locks plus origin-scoped storage deduplicate desktop delivery across tabs;
without those browser features deduplication is best effort. The Data handshake
still sounds for new peer batches after audio is unlocked.

The site must remain open. No service worker, closed-browser push, or notification
permission bypass exists. Browsers/OS settings may suppress an otherwise granted
notification. Tests mock permission/notification delivery; they do not approve
permission or notify Jack.

## Hosting compatibility

`serveHosting` in `extensions/bf2-swarm/hosting.mjs` defaults to legacy behavior.
For a floors gateway use explicit `mode: 'floors'`, the matching loopback upstream
and token, and the existing private HTTPS origin/Basic configuration (`run` is
not needed). Cookie login, same-origin capability bootstrap, Host/Origin/Fetch
Metadata checks and bounded operation allowlists remain. Do not change the
durable deployed adapter or private configuration merely to update shared assets.

## Checks

```sh
node --test extensions/dark-factory/room/*.test.ts extensions/dark-factory/floors/room*.test.ts extensions/bf2-swarm/room.test.ts extensions/bf2-swarm/hosting.test.ts
node extensions/dark-factory/room/test/browser-check.mjs
pi --list-models 'openai-codex-personal/gpt-6.1-sol'
```

The browser check uses browser-harness and its own hidden loopback fake-worker
room, closes its target/server, and never navigates a live room. Native tests
exercise isolation/configuration, history/mute/notification behavior, legacy
asset URLs/storage, and local/hosted authentication. The runtime consumer check uses local `runtime.mjs` when present (otherwise
explicitly skips); `FACTORY_RUNTIME_MODULE=/absolute/runtime.mjs` can select a
sibling source without merging. It writes only /tmp fixtures and fakes controller
recovery/worker registration. Parent integration must also check the merged
runtime/supervisor/CLI and fake-worker drain/lease flows.
This support directory has no Pi extension entrypoint; `index.html` is static.
