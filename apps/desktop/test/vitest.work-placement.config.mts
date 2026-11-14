import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { candidateAlias } from '../scripts/candidate-package-resolve.mjs'
import { installedDependency } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.WORK_PLACEMENT_MUTANT
const rendererOwner = mutant === 'renderer-copy' || process.env.WORK_PLACEMENT_OWNER === 'renderer'
const owner = rendererOwner ? 'apps/desktop/src/renderer/src/lib/session-state.ts' : 'apps/desktop/src/main/runtime-controller.ts'
const edits: Record<string, readonly [string, string]> = {
  'renderer-copy': ['...(core.session.workPlacement ? { workPlacement: { ...core.session.workPlacement } } : {}),', '/* missing Renderer placement */'],
  'raw-resource-alias': ['resourceHostId: routes.get(binding.resourceRuntimeId) ?? null', 'resourceHostId: binding.resourceHostId'],
  'ambiguous-last-route': ['conflict || routes.has(runtimeId) && previous !== hostId ? null : hostId', 'hostId'],
  'snapshot-placement': ['...workPlacementFor(subject.hostId, subject.agentSession.toolExecution),', '/* missing snapshot placement */'],
  'event-placement': ['...(event.session.toolExecution ? this.workPlacementProjection()(hostId, event.session.toolExecution) : {})', '...{}'],
  'history-placement': ['.map(source => ({ ...source, ...workPlacementFor(source.hostId, source.history?.toolExecution) }))', '.map(source => ({ ...source }))'],
  'recovery-placement': ['...workPlacementFor(hostId, session.toolExecution),', '/* missing recovery placement */']
}
if (mutant && !edits[mutant]) throw new Error('Unknown work placement mutation')
export default defineConfig({
  root, resolve: { alias: [candidateAlias(root, { source: true })] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'work-placement-consumer', enforce: 'pre', resolveId: installedDependency, transform(source, id) {
    if (id.split('?')[0] !== resolve(root, owner)) return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    if (mutant) {
      const [before, after] = edits[mutant]!
      if (source.split(before).length !== 2) throw new Error('Work placement mutation must match one production owner')
      source = source.replace(before, after)
      process.stderr.write('WORK_PLACEMENT_MUTANT_HIT ' + mutant + '\n')
    }
    const loadedSHA256 = createHash('sha256').update(source).digest('hex')
    if (process.env.WORK_PLACEMENT_LOADED) appendFileSync(process.env.WORK_PLACEMENT_LOADED,
      JSON.stringify({ file: relative(root, id), originalSHA256, loadedSHA256, ...(mutant ? { mutant } : {}) }) + '\n')
    return { code: source, map: null }
  } }],
  test: { include: ['apps/desktop/test/runtime-controller.test.ts'],
    testNamePattern: 'tool execution Desktop boundary|Desktop work placement',
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false },
  cacheDir: resolve(root, '.tmp/work-placement-tests')
})
