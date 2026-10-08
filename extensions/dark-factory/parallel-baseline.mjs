import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileScope} from './parallel-code.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const replaceFile = (path, bytes) => { writeFileSync(path + '.tmp', bytes); renameSync(path + '.tmp', path); };

// Only the controller writes this explicitly delegated acceptance area. Product meaning stays in the tree.
export function applyBaseline(authority, proposal, directory) {
  if (!authority?.root || !Array.isArray(authority.paths)) throw Error('baseline reconciliation is not delegated');
  const root = realpathSync(authority.root);
  const manifestPath = join(root, 'inputs.sha256');
  const manifest = readFileSync(manifestPath, 'utf8');
  const changes = new Map();
  for (const change of proposal.changes) {
    fileScope([change.path], 'baseline change path');
    if (!authority.paths.includes(change.path) || changes.has(change.path)) throw Error('baseline path not delegated or duplicated: ' + change.path);
    const path = resolve(root, change.path);
    if (!path.startsWith(root + '/') || realpathSync(path) !== path) throw Error('baseline path escapes the delegated root');
    const before = readFileSync(path);
    if (hash(before) !== change.sha256) throw Error('baseline bytes changed since proposal: ' + change.path);
    let after = before.toString('utf8');
    if (!Array.isArray(change.replacements) || !change.replacements.length) throw Error('baseline change needs literal replacements');
    for (const edit of change.replacements) {
      if (typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string' || edit.old === edit.new ||
          !proposal.sources.some(source => source.node === edit.source)) throw Error('each replacement needs changed text and a cited source');
      const at = after.indexOf(edit.old);
      if (at < 0 || after.indexOf(edit.old, at + edit.old.length) >= 0) throw Error('baseline replacement is not unique: ' + change.path);
      after = after.slice(0, at) + edit.new + after.slice(at + edit.old.length);
    }
    changes.set(change.path, {path, before, after: Buffer.from(after)});
  }
  const pinned = new Set();
  const updated = manifest.trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw Error('invalid input manifest');
    const [, expected, path] = match;
    if (hash(readFileSync(path)) !== expected) throw Error('input changed outside this proposal: ' + path);
    const change = [...changes.values()].find(item => item.path === path);
    if (!change) return line;
    pinned.add(path);
    return hash(change.after) + '  ' + path;
  }).join('\n') + '\n';
  if (pinned.size !== changes.size) throw Error('every baseline change must name an existing pinned input');
  mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, 'baseline-before.json'), JSON.stringify({manifest, files: [...changes.values()].map(item => ({path:item.path, bytes:item.before.toString('base64')}))}, null, 2));
  try {
    for (const change of changes.values()) replaceFile(change.path, change.after);
    replaceFile(manifestPath, updated);
  } catch (error) {
    // Keep every original byte and restore the batch if any write fails. Never publish a partial re-pin.
    for (const change of changes.values()) replaceFile(change.path, change.before);
    replaceFile(manifestPath, manifest);
    throw error;
  }
  const receipt = {sources:proposal.sources, manifest_hash:hash(updated), changes:[...changes.values()].map(item => ({path:item.path, before:hash(item.before), after:hash(item.after)}))};
  writeFileSync(join(directory, 'baseline-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
