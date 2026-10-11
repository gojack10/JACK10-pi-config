# Dark Factory room assets

Canonical frontend: `extensions/dark-factory/room/`. The accepted C layout,
fonts, roles/avatars, spacing and default-off Data handshake are unchanged;
only the document title and heading say **Dark Factory**.

Compatibility: `extensions/bf2-swarm/room/` remains a directory with eight
relative symlinks: `index.html`, `room.js`, `markup.mjs`, `colors_and_type.css`
and `fonts/JetBrainsMono-{Light,Medium,SemiBold,Italic}.woff2`. These resolve to
this directory without duplicating canonical source. Both Node's old markup
import and browser URLs `/`, `/room.js`, `/markup.mjs`, `/colors_and_type.css`
and `/fonts/*.woff2` keep working. No redirect or new public static route exists.

`extensions/bf2-swarm/room.mjs` intentionally still reads the old paths on each
request. The BF2 board/controller/server/hosting remain BF2-specific. Existing
`bf2-room` and `bf2-pending:<run>` sessionStorage, capability, cookie, APIs,
run data and hosted bootstrap are unchanged. This move does **not** implement
the room API for legacy BF2 runs or sequential/parallel dark factories.

## Safe integration into an actively serving checkout

A plain checkout/fast-forward may briefly remove an old regular asset before
writing its symlink. Do not rely on Git's write ordering for uninterrupted serving.
The reviewing parent owns integration; this worker never updates live source.

Starting with a clean serving checkout at the reviewed baseline, set `CANDIDATE`
to the full reviewed commit SHA. Check the branch/baseline and ancestry first:

```sh
git status --short --branch
git rev-parse HEAD # expected reviewed baseline: db3d680735f2217d41bd5a9113192f5d7b3838fd
git merge-base --is-ancestor HEAD "$CANDIDATE"
export CANDIDATE
```

Preinstall only the eight runtime assets from that exact commit, canonical files
first, then atomically replace each old regular file with its reviewed symlink.
Keep the old directory and `fonts/` directory in place. All old requests continue
to see either the old file or the new symlink to an already-complete file:

```sh
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
const commit = process.env.CANDIDATE;
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('full reviewed SHA required');
const files = ['index.html', 'room.js', 'markup.mjs', 'colors_and_type.css',
  ...['Light', 'Medium', 'SemiBold', 'Italic'].map(f => `fonts/JetBrainsMono-${f}.woff2`)];
for (const root of ['extensions/dark-factory/room', 'extensions/bf2-swarm/room']) {
  for (const file of files) {
    const path = `${root}/${file}`, temporary = `${path}.install-${process.pid}`;
    const content = execFileSync('git', ['show', `${commit}:${path}`]);
    mkdirSync(dirname(path), { recursive: true });
    if (root.includes('bf2-swarm')) symlinkSync(content.toString(), temporary);
    else writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, path);
  }
}
NODE
```

Stage **only those eight canonical files and eight compatibility symlinks** (not
the entire room directories). Confirm their staged content/modes match CANDIDATE:

```sh
paths=()
for file in index.html room.js markup.mjs colors_and_type.css \
  fonts/JetBrainsMono-{Light,Medium,SemiBold,Italic}.woff2; do
  paths+=("extensions/dark-factory/room/$file" "extensions/bf2-swarm/room/$file")
done
git add -- "${paths[@]}"
git diff --cached --check
git diff --cached --exit-code "$CANDIDATE" -- "${paths[@]}"
git merge --ff-only "$CANDIDATE"
git status --short --branch
```

The staged assets already equal the target, so fast-forward need not delete and
recreate them. It installs remaining docs/tests normally. Stop on any unexpected
status, baseline, mismatch or merge refusal; do not stash/remove the compatibility
assets to force a merge. An interrupted preinstall retains old readable paths;
inspect/reconcile the partial source changes before continuing. A tiny disposable
Git fixture qualified this staged-target fast-forward behavior, not live serving.

No room/ingress/tunnel/controller/agent restart or configuration change is needed.
After parent read-only checks, the owner can refresh the existing URL (save any
unsent, unpersisted textarea draft first). Stored messages and failed-send retry
keys survive; an ordinary unsent textarea is not automatically persisted. Do not
refresh the owner's live tab from a worker. Safe rollback while serving likewise
requires asset-first atomic replacement from the reviewed old tree, not a blind
Git checkout that removes canonical targets under the compatibility symlinks.

## Checks

```sh
node --test extensions/dark-factory/room/*.test.ts extensions/bf2-swarm/room.test.ts extensions/bf2-swarm/hosting.test.ts
```

Fixtures check old and canonical realpaths/bytes, unchanged static URLs and MIME,
actual module loading/rendering with retained storage/draft keys, owner metadata,
selected sound and existing backend/hosting authorization. They do not prove live
provider behavior or that other factory runtimes implement this API. This support
directory has no Pi extension entrypoint (`index.ts`, `index.js` or extension
package manifest); `index.html` is only a static asset.
