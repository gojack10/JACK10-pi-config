import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyBaseline} from './parallel-baseline.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
test('current decisions can replace and re-pin a stale expectation without changing unrelated inputs', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-baseline-')));
  try {
    const path = join(root, 'expectations.json'), other = join(root, 'retained.txt');
    const old = '{"fields":["warnings","ruled_out"]}\n';
    writeFileSync(path, old); writeFileSync(other, 'retained');
    writeFileSync(join(root, 'inputs.sha256'), `${hash(old)}  ${path}\n${hash('retained')}  ${other}\n`);
    const proposal = {sources:[{node:'source',clause:'Core has no ruled_out field.'}], changes:[{path:'expectations.json', sha256:hash(old),
      replacements:[{old:'"warnings","ruled_out"', new:'"warnings"', source:'source'}]}]};
    const receipt = applyBaseline({root, paths:['expectations.json']}, proposal, join(root, 'receipt'));
    assert.equal(readFileSync(path, 'utf8'), '{"fields":["warnings"]}\n');
    assert.equal(readFileSync(other, 'utf8'), 'retained');
    assert(readFileSync(join(root, 'inputs.sha256'), 'utf8').includes(hash(readFileSync(path))));
    assert.equal(receipt.changes[0].before, hash(old));
    assert.throws(() => applyBaseline({root,paths:['expectations.json']}, proposal, join(root, 'stale')), /changed since proposal/);
    assert.throws(() => applyBaseline({root,paths:[]}, proposal, join(root, 'forbidden')), /not delegated/);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
