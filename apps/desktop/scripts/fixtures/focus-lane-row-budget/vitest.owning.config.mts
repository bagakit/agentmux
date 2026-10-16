import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'),
  cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-lane-row-budget-cache', process.env.FOCUS_ROW_MUTATION ?? 'positive'),
  plugins: [{ name: 'focus-row-budget-source', enforce: 'pre', transform(code, id) {
    if (!/\/(?:focus-lane-layout|FocusLaneGroups|GlobalFocusSurface|FocusContextCards|FocusContextRow)\.(?:tsx|ts)$/.test(id)) return undefined
    const mutation = process.env.FOCUS_ROW_MUTATION
    let loaded = code
    if (mutation === 'first-fit' && id.endsWith('/focus-lane-layout.ts')) loaded = code.replace('cost < best.cost', 'false')
    if (mutation === 'single-column' && id.endsWith('/focus-lane-layout.ts')) loaded = code.replace('columns[index] = stillOptimal ? previous!.columns[index]! : Math.ceil(counts[index]! / low)', 'columns[index] = 1')
    if (mutation === 'wrong-placement' && id.endsWith('/GlobalFocusSurface.tsx')) loaded = code.replace('gridRow: layout.rowByBucket[index]! + 1', 'gridRow: 1')
    const log = process.env.FOCUS_ROW_LOADED
    if (log) appendFileSync(log, JSON.stringify({ id, sourceSha256: createHash('sha256').update(code).digest('hex'), loadedSha256: createHash('sha256').update(loaded).digest('hex'), changed: loaded !== code }) + '\n')
    return loaded === code ? undefined : { code: loaded, map: null }
  } }],
  test: { ...original.test, include: [
    'apps/desktop/test/focus-lane-row-budget.test.ts',
    'apps/desktop/test/focus-lane-height-balance.test.tsx',
    'apps/desktop/test/focus-lane-wrapped-width.test.tsx',
    'apps/desktop/test/focus-lane-measurement.test.tsx'
  ], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
