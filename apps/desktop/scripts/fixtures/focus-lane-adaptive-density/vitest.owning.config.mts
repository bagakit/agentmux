import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
export default defineConfig({ ...original, root: resolve(import.meta.dirname, '../../../../..'), cacheDir: resolve(import.meta.dirname, '../../../../../.tmp/focus-lane-adaptive-density-cache'), plugins: [{ name: 'lane-actual-source', enforce: 'pre', transform(code, id) { const log = process.env.AGENTMUX_FOCUS_LANE_ADAPTIVE_SOURCE_LOG; if (log && /\/(?:GlobalFocusSurface|FocusDisconnectedGroup|FocusDisconnectedProjects|FocusContextRow)\.tsx$/.test(id)) appendFileSync(log, JSON.stringify({ id, sourceSHA256: createHash('sha256').update(code).digest('hex') }) + '\n'); return undefined } }], test: { ...original.test, include: ['apps/desktop/test/focus-lane-adaptive-density.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
