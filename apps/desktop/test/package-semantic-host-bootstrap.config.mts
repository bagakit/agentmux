import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const change = process.env.AGENTMUX_SEMANTIC_BOOTSTRAP_SOURCE
const loaded = process.env.AGENTMUX_SEMANTIC_BOOTSTRAP_LOADED
export default defineConfig({ root,
  plugins: [{ name: 'actual-semantic-bootstrap-owner', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('apps/') && !path.startsWith('packages/')) return
    if (id.includes('node_modules/') || !/\.[cm]?[jt]s$/u.test(id)) return
    const raw = readFileSync(file, 'utf8')
    const code = path === 'apps/desktop/scripts/package-semantic-host.mjs' && change ? readFileSync(change, 'utf8') : original
    if (loaded) appendFileSync(loaded, JSON.stringify({ path, moduleId: id,
      rawSHA256: createHash('sha256').update(raw).digest('hex'), receivedSHA256: createHash('sha256').update(original).digest('hex'),
      effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/package-semantic-host-bootstrap.test.ts', 'apps/desktop/test/package-semantic-host-reload.test.ts'],
    environment: 'node', maxWorkers: 1, fileParallelism: false, passWithNoTests: false, globalSetup: [], setupFiles: [], testTimeout: 45000 } })
