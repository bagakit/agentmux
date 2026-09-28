import type { AgentMuxControlFocusRequest, AgentMuxDesktopFocusResult, AgentMuxDesktopInput } from '../../src/control.js'

export const input: AgentMuxDesktopInput = { provenance: 'observed', scope: 'floating', ownerKind: 'composer',
  tabId: 'mote-tab', regionId: 'mote-region', sessionId: 'mote-session', connected: true, visible: true, inert: false }
/** A mock client reports unknown DOM facts. This proves wire fidelity, never actual Desktop visibility. */
export function focusFacts(request: AgentMuxControlFocusRequest): AgentMuxDesktopFocusResult {
  const target = request.target
  const surface = target.kind === 'goal' ? 'goals' : target.kind === 'surface' ? target.surface : 'space'
  const mainSurface = ({ space: 'workbench', goals: 'board', focus: 'agents', search: 'search' } as const)[surface]
  const space = { spaceId: target.kind === 'space' ? target.spaceId ?? 'space' : 'space',
    zoneId: target.kind === 'space' ? target.zoneId ?? 'zone' : 'zone', workspaceId: 'workspace',
    tabId: target.kind === 'space' ? target.tabId ?? 'tab' : 'tab', groupId: 'group',
    regionId: target.kind === 'space' ? target.regionId ?? 'region' : 'region', topicId: null }
  return { operation: 'focus', navigation: { state: 'applied', requested: target, selection: { surface, mainSurface, space,
    goalId: target.kind === 'goal' ? target.goalId : 'previous-goal' } },
    presentation: { provenance: 'unknown', state: 'unknown', tabId: space.tabId, regionId: space.regionId, blockers: [] },
    input: { policy: request.inputPolicy, outcome: 'unconfirmed', before: input, after: input },
    floating: { provenance: 'unknown', state: 'unknown', topicId: null, tabId: 'mote-tab', regionId: 'mote-region', sessionId: 'mote-session', presentation: 'unknown' },
    overlays: { provenance: 'unknown', settings: null, quickSwitcher: null, shortcutsHelp: null },
    focus: { executionSessionId: 'execution-session', pmoSessionId: 'mote-session' }, partial: true,
    save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null },
    issues: [{ step: 'presentation', code: 'UNKNOWN', message: 'The mock client has no DOM owner.', recovery: 'Inspect the actual Desktop.',
      candidates: [{ spaceId: space.spaceId, zoneId: space.zoneId, tabId: space.tabId, regionId: space.regionId }] }] }
}
