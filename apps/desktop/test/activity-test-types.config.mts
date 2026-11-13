import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_ACTIVITY_ASSET_MUTATION
assert.ok(mutation === undefined || mutation === 'binary-as-ts', 'Known Activity asset mutation')
export default defineConfig({
  root,
  plugins: [{ name: 'actual-activity-asset-compiler-host', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== resolve(root, 'apps/desktop/scripts/typecheck-activity-tests.mjs')) return
    let consumed = source
    if (mutation) {
      const anchor = '    if (extension === undefined) return undefined'
      assert.equal(source.split(anchor).length - 1, 1, 'Unique actual non-code resolution branch')
      consumed = source.replace(anchor, '    if (extension === undefined) return { resolvedFileName: file, extension: ts.Extension.Ts, isExternalLibraryImport: false }')
    }
    if (process.env.AGENTMUX_ACTIVITY_ASSET_LOADED) {
      mkdirSync(dirname(process.env.AGENTMUX_ACTIVITY_ASSET_LOADED), { recursive: true })
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_ACTIVITY_ASSET_LOADED, JSON.stringify({ path: 'apps/desktop/scripts/typecheck-activity-tests.mjs',
        originalSHA256: sha(source), consumedSHA256: sha(consumed), mutation: mutation ?? null }) + '\n')
    }
    if (consumed !== source) return { code: consumed, map: null }
  } }],
  test: { include: ['apps/desktop/test/activity-test-asset-types.test.ts'], maxWorkers: 1,
    fileParallelism: false, passWithNoTests: false, testTimeout: 60000 }
})
