import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_SPATIAL_CHECKPOINT_MUTATION
const mutations: Record<string, [string, string]> = {
  'drop-checkpoint-capture': [
    '  spatial.stage(captureSpatialWorkbench(spatial))\n  await spatial.flush()',
    '  await spatial.flush()'
  ],
  'drop-catch-observer': [
    '      observeOwnedSpatial()\n      if (ownedSpatial && coreSpatialPersistence === ownedSpatial)',
    '      if (ownedSpatial && coreSpatialPersistence === ownedSpatial)'
  ],
  'cross-owner-dispose': [
    '      dispose?.()\n      if (disposeCoreSpatial === dispose) disposeCoreSpatial = null',
    '      disposeCoreSpatial?.(); disposeCoreSpatial = null'
  ],
  'omit-owner-fence': [
    "  if (coreSpatialPersistence !== spatial) throw new Error('The Core spatial owner changed while saving. The current workface is retained; retry saving through its current owner.')",
    ''
  ]
}
if (mutation && !mutations[mutation]) throw new Error('Unknown spatial checkpoint mutation')

export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.tmp/spatial-workbench-checkpoint-' + (mutation ?? 'candidate')),
  plugins: [...base.plugins ?? [], { name: 'spatial-workbench-checkpoint-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'apps/desktop/src/renderer/src/store.ts') return
    let code = source
    if (mutation) {
      const [before, after] = mutations[mutation]!
      if (source.split(before).length !== 2) throw new Error('Spatial checkpoint mutation anchor is missing or ambiguous')
      code = source.replace(before, after)
    }
    if (process.env.AGENTMUX_SPATIAL_CHECKPOINT_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_SPATIAL_CHECKPOINT_LOADED, JSON.stringify({ path, mutation: mutation ?? null,
        originalSHA256: hash(source), sha256: hash(code) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/spatial-workbench-checkpoint.test.ts',
    'apps/desktop/test/launcher-spatial-ack.test.ts', 'apps/desktop/test/reusable-shell-disposal.test.tsx'],
    globalSetup: [], passWithNoTests: false, fileParallelism: false }
})
