import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'
const mutations: Record<string, [string, string, string]> = {
  'unconfirmed-name': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', 'fallbackLabel: current?.session?.label ?? `Agent · ${candidate.sid}`', "fallbackLabel: current?.session?.label ?? 'Agent task'"],
  'unconfirmed-position': ['apps/desktop/src/renderer/src/lib/focus-source-model.ts', 'const detail = !runtimeId && access.locations.length === 1 ? `Position ${access.locations[0]!.regionId} · ${observation}` : observation', 'const detail = observation'],
  'borrow-sid': ['apps/desktop/src/renderer/src/lib/focus-source-model.ts', 'runtimeByHost.get(context.control?.hostId ?? context.hostId) === runtimeId', 'true'],
  'disconnect-source': ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'const executionRows = useMemo(() => [...ordinaryRows, ...sourceFacts.contexts]', 'const executionRows = useMemo(() => [...ordinaryRows]'],
  'qualified-projection': ['apps/desktop/src/renderer/src/store.ts', '    if (reference) {', '    if (selected && reference) {'],
  'source-parent': ['apps/desktop/src/renderer/src/store.ts',
    '        const choice = tab.source ? { ...resolved, spaceId: target.reference.spaceId, zoneId: target.zoneId } : resolved', '        const choice = resolved']
}
const mutation = process.env.AGENTMUX_FOCUS_SOURCE_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known source-consumer mutation')
export default defineConfig({
  ...source,
  cacheDir: resolve(source.root!, '.tmp/focus-source-unification-vitest-' + (mutation ?? 'baseline')),
  plugins: [{ name: 'actual-source-consumer-semantic-mutation', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!Object.values(mutations).some(([target]) => target === path)) return
    let code = original
    if (mutation) {
      const [target, from, to] = mutations[mutation]!
      if (path === target) { assert.equal(code.split(from).length - 1, 1, 'Unique actual production anchor'); code = code.replace(from, to) }
    }
    if (process.env.AGENTMUX_FOCUS_SOURCE_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_SOURCE_LOADED, JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: code !== original ? mutation : null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-source-unification.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30000 }
})
