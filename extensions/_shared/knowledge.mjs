import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = fileURLToPath(new URL('../../', import.meta.url));
export const knowledgeHome = process.env.SIFTTEXT_HOME ?? join(homedir(), 'sifttext');
export const knowledgeNodePath = id => join(knowledgeHome, 'nodes', id, 'node.md');
export const knowledgeGuidePath = name => {
  const path = join(agentDir, 'local', 'knowledge', `${name}.md`);
  return existsSync(path) ? realpathSync(path) : path;
};
export const knowledgeGuideId = name => {
  const path = knowledgeGuidePath(name);
  return existsSync(path) ? basename(dirname(path)) : undefined;
};
