import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const product = 'apps/desktop/src/renderer/src/lib/focus-context.ts'
export default defineConfig({ ...original, root, resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  cacheDir: resolve(root, '.tmp/focus-activity-certainty-cache'), plugins: [{
  name: 'actual-loaded-focus-activity-certainty', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (!path.startsWith(resolve(root, 'apps/desktop/src') + '/')) return
    let code = source
    const mutation = process.env.AGENTMUX_ACTIVITY_CERTAINTY_MUTATION
    if (mutation === 'hide-unknown' && path === resolve(root, product)) {
      const anchor = "else if (row.activitySemantic === 'unknown' || row.activitySemantic === 'unsupported' || row.state === 'running') unknown++"
      assert.equal(source.split(anchor).length - 1, 1, 'Actual neutral-count production anchor')
      code = source.replace(anchor, anchor.replace('unknown++', 'idle++'))
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ACTIVITY_CERTAINTY_LOADED) appendFileSync(process.env.AGENTMUX_ACTIVITY_CERTAINTY_LOADED,
      JSON.stringify({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), mutated: code !== source, mutation }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/focus-activity-certainty.test.tsx'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 } })
