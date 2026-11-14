import { resolve, relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from '../../../vitest.config'
import owning from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'
import { assertWorkspaceDistBuiltFromCurrentSource, staleDistComplaint } from '../../../vitest.dist-freshness'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'label-collisions': { file: 'apps/desktop/src/renderer/src/lib/quick-switch.ts', before: "if (!others.length || item.target.kind !== 'session-location') return item", after: 'if (true) return item' },
  'first-item': { file: 'apps/desktop/src/renderer/src/store.ts', before: 'reference })\n  },\n  selectSession(id, preferredTabGroupId, options)', after: 'reference: sessionWorkbenchReferences(get().tabs, workbenchSelectionCatalog(get()), request.sessionId)[0] ?? reference })\n  },\n  selectSession(id, preferredTabGroupId, options)' },
  'lose-focus': { file: 'apps/desktop/src/renderer/src/store.ts', before: "const navigation = options?.keepSurface ? {} : { mainSurface: 'workbench' as const }", after: "const navigation = { mainSurface: 'workbench' as const }" },
  'unqualified-details': { file: 'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts', before: 'if (!subject || bound?.hostId !== subject.hostId)', after: 'if (false && (!subject || bound?.hostId !== subject.hostId))' },
  'persistent-card-action': { file: 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx', before: '<div className="focus-context-card">{main}', after: '<div className="focus-context-card">{main}<button className="agent-locations">3 locations</button>' },
  'missing-details-action': { file: 'apps/desktop/src/renderer/src/components/AgentLocationsButton.tsx', before: 'return <><button', after: 'return null; return <><button' },
  'admission-bypass': { file: 'apps/desktop/src/renderer/src/store.ts', before: "if (options?.subject === null || options?.subject && (original?.control.kind !== 'agent' ||\n      original.control.hostId !== options.subject.hostId || original.control.agentSessionId !== options.subject.agentSessionId)) return false", after: 'if (false) return false' },
  'drop-membership': { file: 'apps/desktop/src/renderer/src/store.ts', before: 'if (request.subject && (execution?.hostId !== request.subject.hostId || request.subject.runtimeId !== undefined && execution?.runtimeId !== request.subject.runtimeId))', after: 'if (false && request.subject && (execution?.hostId !== request.subject.hostId || request.subject.runtimeId !== undefined && execution?.runtimeId !== request.subject.runtimeId))' }
} as const
const mutation = process.env.AGENT_LOCATIONS_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw new Error('Unknown Agent location mutation')
const files = new Set(['store.ts', 'components/AgentLocationsButton.tsx', 'components/AgentInformationPreview.tsx', 'components/AgentInformationReader.tsx', 'components/AgentInformationDetails.tsx', 'components/AgentRoster.tsx', 'components/FocusContextRow.tsx', 'components/WorkspaceAgentRow.tsx', 'components/QuickSwitcher.tsx', 'components/GlobalFocusSurface.tsx', 'components/SurfaceToolDock.tsx', 'lib/desktop-spatial-state.ts', 'lib/workbench-navigation-catalog.ts', 'lib/desktop-focus-navigation.ts', 'lib/focus-context-identity.ts', 'lib/quick-switch.ts'].map(file => 'apps/desktop/src/renderer/src/' + file))
files.add('packages/core/src/spatial-state.ts')
export default {
  ...base, root: resolve(root, 'apps/desktop'), define: owning.define,
  resolve: { alias: [ { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(root, 'packages/identity/dist/runtime-source.js') }, ...(owning.resolve!.alias as Array<{find: RegExp; replacement: string}>) ] },
  plugins: [{ name: 'agent-locations-build-qualified', async configResolved() {
    await assertWorkspaceDistBuiltFromCurrentSource(root)
    const complaint = await staleDistComplaint(resolve(root, 'packages/identity'), 'dist/runtime-source.js')
    if (complaint) throw new Error(complaint)
  } }, { name: 'agent-locations-evaluated-owner', enforce: 'pre' as const, transform(code: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!files.has(file)) return
    let loaded = code
    const variant = mutation && variants[mutation]
    if (variant && file === variant.file) {
      if (loaded.split(variant.before).length !== 2) throw new Error('Expected exactly one original navigation fence')
      loaded = loaded.replace(variant.before, variant.after)
    }
    if (!process.env.AGENT_LOCATIONS_LOADED) return loaded === code ? undefined : loaded
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const entry = { file, mutation: mutation ?? null, originalSHA256: sha(readFileSync(resolve(root, file), 'utf8')), loadedSHA256: sha(loaded), mutated: loaded !== code }
    return `import { appendFileSync as __agentLocationLoaded } from 'node:fs'; __agentLocationLoaded(${JSON.stringify(process.env.AGENT_LOCATIONS_LOADED)}, ${JSON.stringify(JSON.stringify(entry) + '\n')});\n` + loaded
  } }],
  test: { ...base.test, include: ['test/agent-locations.test.tsx', 'test/quick-switch-demand.test.tsx', 'test/quick-switch.test.ts'], maxWorkers: 2, fileParallelism: false, passWithNoTests: false }
}
