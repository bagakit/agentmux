import { parseAgentTakeoverProvenance } from '@agentmux/core/agent-takeover'
import { desktopAgentExecutionFromSpatial } from '../../../src/renderer/src/lib/desktop-agent-presentation'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'

const runtimeId = 'takeover-fixture-runtime'
const sources = [
  { id: 'alpha-working', targets: [['Release investigation', 'codex', 'confirmed']] },
  { id: 'alpha-results', targets: [
    ['Compare releases', 'codex', 'confirmed'],
    ['Validate the rebuild', 'claude', 'confirmed'],
    ['Audit policy', 'gemini', 'confirmed'],
    ['Cross-check evidence', 'codex', 'confirmed'],
    ['Archive results', 'claude', 'unconfirmed']
  ] },
  { id: 'alpha-attention', targets: [
    ['Read pending review', 'codex', 'confirmed'],
    ['Review the change', 'claude', 'confirmed'],
    ['Check acceptance', 'codex', 'confirmed']
  ] }
]

/** Feed the actual Focus renderer observations of existing objects through the maintained private Core graph. */
export function prepareTakeoverRecipients(state, topics) {
  const workspace = state.config.workspaces.find(value => value.id === 'beta')
  const layout = state.layouts[workspace.id], group = layout.groups[0]
  const now = Date.now()
  const tabs = { ...state.tabs }, agentNames = { ...state.agentNames }
  const sourceById = new Map(state.sessions.filter(session => sources.some(source => source.id === session.id)).map(session => [session.id, session]))
  if (sourceById.size !== sources.length) throw Error('All original takeover source Sessions are required')
  const targets = sources.flatMap(source => source.targets.map(([name, providerId, initialPrompt], index) => {
    const origin = sourceById.get(source.id)
    const id = 'takeover-proof-' + source.id + '-' + (index + 1)
    const regionId = id + '-region'
    const tab = createWorkbenchTab(id + '-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: id, regionId })
    tabs[tab.id] = tab
    agentNames[id] = name
    const session = { ...origin, id, label: name, workspacePath: workspace.path, providerId, executorId: providerId,
      control: { ...origin.control, agentSessionId: id, run: { runId: id + '-run' } },
      createdAt: now - source.targets.length + index }
    return { session, sourceId: source.id, address: { tabId: tab.id, regionId }, initialPrompt, name }
  }))
  const layouts = { ...state.layouts, [workspace.id]: { ...layout, groups: layout.groups.map(value => value.id === group.id
    ? { ...value, tabOrder: [...value.tabOrder, ...targets.map(target => target.address.tabId)] } : value) } }
  const arranged = { ...state, tabs, layouts, agentNames, sessions: [...state.sessions, ...targets.map(target => target.session)] }
  const locations = spatialCatalog(arranged, topics).locations
  for (const target of targets) {
    const source = sourceById.get(target.sourceId)
    const original = locations.filter(location => location.tabId === target.address.tabId && location.regionId === target.address.regionId)
    if (original.length !== 1) throw Error('Exact original takeover target position is required')
    target.address = original[0]
    const { control } = source
    target.session.creation = {
      createOperationId: target.session.id + '-creation', createdRun: target.session.control.run, initialPrompt: target.initialPrompt,
      takeover: parseAgentTakeoverProvenance({
        source: { hostId: control.hostId, runtimeId, agentSessionId: control.agentSessionId, run: control.run, organization: null },
        destination: { owner: { runtimeId }, address: target.address, organization: null },
        nature: null
      })
    }
  }
  const graph = desktopSpatialGraph(arranged, topics)
  const subjects = [...sourceById.values(), ...targets.map(target => target.session)]
  for (const session of subjects) {
    const matches = graph.regions.filter(region => region.agentSessionId === session.control.agentSessionId)
    if (matches.length !== 1 || !desktopAgentExecutionFromSpatial(matches[0], session)) throw Error('Exact original takeover Session and Run binding is required: ' + session.id)
    matches[0].execution.runtimeId = runtimeId
  }
  return { arranged, graph, targets, accepted: regions => subjects.every(session => regions?.some(region =>
    desktopAgentExecutionFromSpatial(region, session)?.runtimeId === runtimeId)) }
}
