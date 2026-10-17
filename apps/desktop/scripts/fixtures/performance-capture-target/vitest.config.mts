import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../test/performance-capture.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const capture = 'apps/desktop/src/renderer/src/components/performance/PerformanceCapture.tsx'
const profiler = 'apps/desktop/src/main/renderer-v8-profile.ts'
const windowCheck = 'window.windowId !== renderer.window.windowId || window.webContentsId !== renderer.window.webContentsId || window.generation !== renderer.window.generation'
const mutations: Record<string, [string, string, string]> = {
  hotspots: [capture, `${windowCheck}) return null`, `${windowCheck} || observation.app.state !== 'available' || !observation.app.data?.processes.some(process => process.role === 'renderer' && process.pid === renderer.process.pid && process.creationTime === renderer.process.creationTime)) return null`],
  available: [capture, "source?.state !== 'available' || ", ''],
  window: [capture, windowCheck, 'false'],
  process: [capture, 'renderer.process.pid === null || renderer.process.creationTime === null ||', ''],
  main: [profiler, 'if (!current || !sameRendererV8ProfileTarget(current, input.target)) {', 'if (false) {']
}
const mutant = process.env.AGENTMUX_CAPTURE_TARGET_MUTANT
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export default defineConfig({ ...base, cacheDir: resolve(root, '.local/cache/performance-capture-target', mutant ?? 'candidate'),
  plugins: [...base.plugins ?? [], { name: 'capture-exact-target-consumers', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!), change = mutant ? mutations[mutant] : undefined
    if (!path.startsWith('apps/desktop/src/')) return
    assert.equal(original, readFileSync(id.split('?')[0]!, 'utf8'), 'Loaded source must match the candidate')
    let code = original
    if (mutant) assert.ok(change, 'Unknown capture target mutation')
    if (change?.[0] === path) {
      assert.equal(code.split(change[1]).length - 1, 1, 'Mutation must hit exactly one production anchor')
      code = code.replace(change[1], change[2])
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (process.env.AGENTMUX_CAPTURE_TARGET_LOADED) appendFileSync(process.env.AGENTMUX_CAPTURE_TARGET_LOADED,
      JSON.stringify({ path, sourceSHA256: sha(original), consumedSHA256: sha(code) }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }], test: { ...base.test, include: [process.env.AGENTMUX_CAPTURE_TARGET_SCENE_UI
    ? 'apps/desktop/test/performance-scene-ui.fixture.tsx' : 'apps/desktop/test/performance-capture.test.tsx'], maxWorkers: 1, passWithNoTests: false } })
