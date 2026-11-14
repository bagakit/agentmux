import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'

const owner = 'apps/desktop/src/renderer/src/lib/use-focus-sources.tsx'
const mutations: Record<string, [string, string]> = {
  'target-gates-name': ['if ((!target && !direct) || !key || !visible) return', 'if (!target || !key || !visible) return'],
  'creation-gates-name': ['if (!original.directName && runtimeId === target.reference.runtimeId) {', 'if (!original.directName && runtimeId === target.reference.runtimeId && observed?.session.creation?.createOperationId) {'],
  'source-runtime-fence': ['if (!original.directName && runtimeId === target.reference.runtimeId) {', 'if (!original.directName && runtimeId) {'],
  'read-grants-rename': ["(member ? member.expectedAdmission.kind === 'creation' : direct?.changeTarget) ? async", "(member ? member.expectedAdmission.kind === 'creation' : direct) ? async"],
  'clear-uses-history': ['current?.name ? current.name.current.override ?? undefined : historyNames.get(candidate.key)', 'current?.name?.current.override ?? historyNames.get(candidate.key)'],
  'failure-loses-name': ['emit({ nameIssue: String(cause instanceof Error ? cause.message : cause) })', 'emit({ name: undefined, nameIssue: String(cause instanceof Error ? cause.message : cause) })']
}
const mutation = process.env.AGENTMUX_FOCUS_NAME_MUTATION
if (mutation) assert.ok(mutations[mutation], 'Known original-name consumer mutation')
const bound = new Set([owner, 'packages/core/src/name-control.ts', 'packages/core/src/name-control-owner.ts', 'packages/core/src/public-rpc-service.ts',
  'apps/desktop/src/main/space-mount-ipc.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx'])
export default defineConfig({ ...source,
  cacheDir: resolve(source.root!, '.tmp/focus-source-names/vite-' + (mutation ?? 'baseline')),
  plugins: [{ name: 'actual-original-name-consumer-mutation', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!bound.has(path)) return
    let code = original
    if (mutation && path === owner) {
      const [from, to] = mutations[mutation]!
      assert.equal(code.split(from).length - 1, 1, 'Unique actual production mutation anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_FOCUS_NAME_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_NAME_LOADED,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutation: original === code ? null : mutation }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-source-name-reading.test.tsx'], setupFiles: [], globalSetup: [], passWithNoTests: false,
    maxWorkers: 1, fileParallelism: false, testTimeout: 15000 }
})
