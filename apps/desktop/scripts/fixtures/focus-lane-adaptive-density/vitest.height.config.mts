import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'), cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-lane-height-cache'), plugins: [{ name: 'lane-height-loaded-source', enforce: 'pre', transform(code, id) {
  if (!/\/(?:App|GlobalFocusSurface|FocusLaneGroups|FocusProjectLanes|FocusContextRow|focus-lane-layout)\.(?:tsx|ts)$/.test(id)) return undefined
  const mutation = process.env.AGENTMUX_FOCUS_LANE_HEIGHT_MUTATION
  let loaded = code
  if (mutation === 'capped' && id.endsWith('/focus-lane-layout.ts')) loaded = code.replace('columns = stillOptimal ? previous! : counts.map(count => Math.ceil(count / maxRows))', 'columns = counts.map(count => count ? Math.min(count, 2) : 0)')
  if (mutation === 'unstable' && id.endsWith('/focus-lane-layout.ts')) loaded = code.replace('columns = stillOptimal ? previous! : counts.map(count => Math.ceil(count / maxRows))', 'columns = counts.map(count => Math.ceil(count / maxRows))')
  if (mutation === 'wrong-target' && id.endsWith('/FocusLaneGroups.tsx')) loaded = code.replace('event.detail > 0 && pressed && pressed !==', 'false && pressed !==')
  if (mutation === 'covered' && id.endsWith('/GlobalFocusSurface.tsx')) loaded = code.replace('const visible = hostVisible && surfaceVisible', 'const visible = surfaceVisible')
  const log = process.env.AGENTMUX_FOCUS_LANE_HEIGHT_LOADED_LOG
  if (log) appendFileSync(log, JSON.stringify({ id, sourceSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), changed: loaded !== code, mutation: loaded !== code ? mutation : null }) + '\n')
  return loaded !== code ? { code: loaded, map: null } : undefined
} }], test: { ...original.test, include: ['apps/desktop/test/focus-lane-height-balance.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
