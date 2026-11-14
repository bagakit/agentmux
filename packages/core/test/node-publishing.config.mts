import path from 'node:path';
import { createRequire } from 'node:module';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { candidateAlias } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs';
const root = path.resolve(import.meta.dirname, '../../..'), evidence = process.env.AGENTMUX_NODE_TEST_EVIDENCE!;
if (!evidence)
    throw Error('Explicit private Node evidence directory required');
mkdirSync(evidence, { recursive: true });
const require = createRequire(path.resolve(root, 'package.json'));
export default { root, cacheDir: path.join(evidence, 'cache'), resolve: { alias: [candidateAlias(root, { source: true })] }, plugins: [{ name: 'node-current-source', enforce: 'pre', resolveId(source: string, importer?: string) { if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0') || source.startsWith('@agentmux/') || source.startsWith('node:') || source === 'vitest')
                return; try {
                return require.resolve(source, { paths: importer ? [path.dirname(importer), root] : [root] });
            }
            catch { } }, transform(code: string, id: string) { if (!id.startsWith(root + '/') || id.includes('/node_modules/') || id.includes('?'))
                return; const hash = (s: string) => createHash('sha256').update(s).digest('hex'); const loaded = code; appendFileSync(path.join(evidence, 'consumed.jsonl'), JSON.stringify({ path: path.relative(root, id), source: hash(readFileSync(id, 'utf8')), loaded: hash(loaded), mutated: loaded !== code }) + '\n'); } }], test: { include: ['packages/core/test/node-publishing.test.ts'], setupFiles: [path.join(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 20000 } };
