import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import source from './vitest.mote-context.config.mts'
const mutations: Record<string, [string, string, string]> = {
  'hide-device-disconnect': ['apps/desktop/src/renderer/src/components/FocusExecutionDevice.tsx', "transport && transport !== 'unopened' ? transport", "transport && transport !== 'unopened' ? (transport === 'disconnected' ? 'connected' : transport)"],
  'borrow-replacement-device': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', ' || (boundRuntime && boundRuntime !== candidate.runtimeId)', ''],
  'source-skills-exclusion': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'loadSkills={completion.loadSkills}', 'loadSkills={source ? async () => { throw new Error("Original Skills excluded by the old Source branch") } : completion.loadSkills}'],
  'wrong-skills-route': ['apps/desktop/src/renderer/src/lib/use-composer-candidates.tsx', 'originalSkills ? await originalSkills() : sessionId && sessionHostId ? await api.ui.listAgentSkills(sessionHostId, sessionId)', 'originalSkills ? await api.ui.listAgentSkills("local", "same-original-sid") : sessionId && sessionHostId ? await api.ui.listAgentSkills(sessionHostId, sessionId)'],
  'source-history-exclusion': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', '...(source?.inputReading ? { originalReading: source.inputReading } : {})', '...{}'],
  'wrong-history-route': ['apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', "(originalReading ? originalReading.readHistory(input, signal) : api.sessions.readHistory(reference, input, { signal }))", "api.sessions.readHistory({ hostId: 'local', agentSessionId: sid }, input, { signal })"],
  'late-history-authority': ['packages/core/src/space-member-runtime.ts', 'const result = await originalPort.call(method, params, callContext)\n      await assertCurrent()', 'const result = await originalPort.call(method, params, callContext)'],
  'runtime-gate-reading': ['apps/desktop/src/renderer/src/components/MountedSpaceAgent.tsx', "enabled: visible && mode === 'activity', readCaptured: true,", "enabled: visible && mode === 'activity' && Boolean(session), readCaptured: true,"],
  'persistent-history-return': ['apps/desktop/src/renderer/src/components/MountedSpaceAgent.tsx', "enabled: visible && mode === 'activity', readCaptured: true,", "enabled: visible && mode === 'activity', opened: true, readCaptured: true,\n            onClose: () => useAppStore.getState().setViewMode(ownerKey, 'terminal', { focus: false }), returnLabel: 'Terminal',"],
  'private-mode': ['apps/desktop/src/renderer/src/components/MountedSpaceAgent.tsx', 'const mode = useAppStore(viewModeSelector)', "const mode = (useAppStore(viewModeSelector), 'terminal' as const)"],
  'full-run-reading': ['apps/desktop/src/renderer/src/components/MountedSpaceAgent.tsx', 'api.spaceMounts.reading(readingTarget, event =>', 'api.spaceMounts.member(target, event =>'],
  'run-owned-reading': ['apps/desktop/src/renderer/src/components/OrdinarySpaceMemberViewport.tsx', '<SpaceMemberWorkface key={witness}', '<SpaceMemberWorkface key={JSON.stringify(currentTarget)}'],
  'creation-gate-reading': ['apps/desktop/src/renderer/src/components/OrdinarySpaceMemberViewport.tsx', 'visible={visible} active={active && activeRegion}', 'visible={visible && !recoverCreation} active={active && activeRegion}'],
  'unconfirmed-name': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', 'fallbackLabel: current?.session?.label ?? `Agent · ${candidate.sid}`', "fallbackLabel: current?.session?.label ?? 'Agent task'"],
  'unconfirmed-position': ['apps/desktop/src/renderer/src/lib/focus-source-model.ts', 'const detail = !runtimeId && access.locations.length === 1 ? `Position ${access.locations[0]!.regionId} · ${observation}` : observation', 'const detail = observation'],
  'unmounted-original-affiliation': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', 'discoveredLocations(mountedCandidates, originalLocations, locationDemands)', 'mountedCandidates'],
  'discovered-group-selection': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', '&&\n    (!requested.originalPosition || Boolean(location.originalPosition && sourcePositionKey(location.originalPosition) === sourcePositionKey(requested.originalPosition)))', ''],
  'discovered-group-refresh': ['apps/desktop/src/renderer/src/lib/original-space-navigation.ts', 'composition.groups.find(group => group.id === selection?.groupId && group.tabOrder.includes(selectedTab.id))\n    ?? composition.groups.find(group => group.tabOrder.includes(selectedTab.id))', 'composition.groups.find(group => group.tabOrder.includes(selectedTab.id))'],
  'borrow-sid': ['apps/desktop/src/renderer/src/lib/focus-source-model.ts', 'runtimeByHost.get(context.control?.hostId ?? context.hostId) === runtimeId', 'true'],
  'disconnect-source': ['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx', 'const executionRows = useMemo(() => [...ordinaryRows, ...sourceFacts.contexts]', 'const executionRows = useMemo(() => [...ordinaryRows]'],
  'all-source-candidates': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', '    const sourceCandidates = new Map<string, SourceCandidates>(), result = new Map<string, Candidate>()', '    previousSources.current.clear()\n    const sourceCandidates = new Map<string, SourceCandidates>(), result = new Map<string, Candidate>()'],
  'all-source-presentations': ['apps/desktop/src/renderer/src/lib/use-focus-sources.tsx', '    const previous = presentations.current, next = new Map<string, CandidatePresentation>()', '    presentations.current = undefined\n    const previous = presentations.current, next = new Map<string, CandidatePresentation>()'],
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
