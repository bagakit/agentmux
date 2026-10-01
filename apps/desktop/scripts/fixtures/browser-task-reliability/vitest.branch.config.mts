import { fileURLToPath } from 'node:url'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const rootUrl = new URL('../../../../../', import.meta.url), root = fileURLToPath(rootUrl)
const loaded = new Set<string>(), record = fileURLToPath(new URL('loaded-source.jsonl', rootUrl))
export default { root, plugins: [{ name: 'actual-loaded-source', enforce: 'pre' as const,
  buildStart() { writeFileSync(record, '') }, transform(_code: string, id: string) {
    const path = id.split('?')[0]!, local = relative(root, path)
    if (local.startsWith('..') || local.includes('node_modules') || loaded.has(path) || !/\.(?:[cm]?ts|tsx|js|mjs)$/.test(path)) return
    const bytes = readFileSync(path); loaded.add(path)
    appendFileSync(record, JSON.stringify({ path: local, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n')
  }
}], resolve: { alias: [
  { find: /^@agentmux\/core\/control$/, replacement: fileURLToPath(new URL('packages/core/src/control.ts', rootUrl)) },
  { find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) },
  { find: /^@agentmux\/client-ui\/pasted-images$/, replacement: fileURLToPath(new URL('packages/client-ui/src/lib/pasted-images.ts', rootUrl)) },
  { find: /^@agentmux\/layout$/, replacement: fileURLToPath(new URL('packages/layout/src/index.ts', rootUrl)) }
] }, test: { include: ['apps/desktop/test/browser-task-reliability-branch.test.ts'], maxWorkers: 1, cache: false } }
