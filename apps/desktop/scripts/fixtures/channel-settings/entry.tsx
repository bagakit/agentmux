import { createRoot } from 'react-dom/client'
import { parseConnectionServiceParams, type ConnectionMethod, type ConnectionParamsMap, type ConnectionRecord, type ConnectionResultMap, type ConnectionServiceOperation, type ConnectionServiceState } from '@agentmux/core/connections'
import type { MoteChatMethod, MoteChatParamsMap, MoteChatResultMap } from '@agentmux/core/mote-chat'
import type { MoteConnectionPreferencesReadResult } from '@agentmux/core/mote-preferences'
import type { AppConfig, ConnectionHostingTarget, ScratchTopicSnapshot } from '../../../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../../../src/renderer/src/components/settings/settings-modules'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { moteConnectionTarget } from '../../../src/renderer/src/lib/mote-connection-default'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { applyConfigEdit } from '../../../src/shared/config-edit'
import '../../../src/renderer/src/styles/index.css'

type Scenario = 'normal' | 'empty' | 'host-unavailable' | 'service-unavailable'
type Channel = 'lark' | 'discord'
const controls = new URLSearchParams(location.search).get('mode') === 'platform-controls'
const owner: ConnectionHostingTarget = { hostId: 'local', runtimeId: 'preview-bot-host-runtime' }
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: (new URL('file:///').pathname + "preview/motes"), name: 'Motes', kind: 'folder' as const }
const topics: ScratchTopicSnapshot[] = ['Research companion', 'Writing partner', 'Build assistant', 'Design studio', 'Learning notes', 'Team coordinator'].map((title, index) => {
  const id = index === 0 ? PMO_TEAMS_TOPIC_ID : 'launcher:preview-mote-' + index
  const directoryPath = workspace.path + '/' + scratchTopicDirectoryName(id)
  return { id, title, kind: 'mote', summary: 'A saved collaborator for our shared work.', directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [] }
})
const observed: ConnectionRecord['observation'] = { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'unknown', reason: 'not-started' } }
const records: ConnectionRecord[] = (['feishu', 'discord'] as const).flatMap(adapterId => ['complete', 'incomplete', 'paused'].map((state, index): ConnectionRecord => ({
  config: { connectionId: adapterId + '-' + state, adapterId, application: { domain: adapterId === 'discord' ? 'discord.com' : 'open.feishu.cn', appId: adapterId === 'discord' ? '12345678901234567' + index : 'cli_preview_application_' + index }, label: index < 2 ? 'Research assistant' : 'Release helper', enabled: state !== 'paused', credentialRef: 'preview-private-reference-' + adapterId + '-' + state }, revision: index + 1,
  initialSetup: { state: state === 'incomplete' ? 'incomplete' : 'complete' },
  capabilities: { roomDiscovery: true, roomCreation: adapterId === 'feishu', roomLink: true },
  observation: state === 'paused' ? { authentication: { state: 'disabled' }, transport: { state: 'disabled' }, intake: { state: 'disabled' }, delivery: { state: 'disabled' } }
    : state === 'incomplete' ? { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } : structuredClone(observed),
})))
let scenario: Scenario = 'normal', channel: Channel = 'lark', epoch = 0
const calls: Array<{ method: string; input?: unknown; owner?: ConnectionHostingTarget }> = [], errors: string[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const setup = { phase: 'configuration', errors }
Object.assign(window, { channelSettingsSetup: setup })
const note = (method: string, input?: unknown, target?: ConnectionHostingTarget) => { calls.push({ method, ...(input === undefined ? {} : { input: structuredClone(input) }), ...(target ? { owner: { ...target } } : {}) }) }
const refuseWrite = async () => { note('forbidden-write'); throw Error('This visual preview never submits a platform or credential write.') }
const base = await api.config.get()
let config: AppConfig = { ...base, hosts: [{ id: 'preview-build-host', kind: 'ssh', label: 'Build server', hostname: 'build.invalid' }], workspaces: [workspace], startup: { ...base.startup, skipAgentAvailabilityCheckWait: true } }
const initialConfig = structuredClone(config)
const serviceStates = new Map<string, ConnectionServiceState>(), serviceOperations = new Map<string, ConnectionServiceOperation>()
// Bootstrap the same empty presentation shell as the manual-owner fixture. The
// controlled resource catalog is installed below, after startup has disposed.
api.config.get = async () => ({ ...config, workspaces: [] })
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
setup.phase = 'hydrate'
await useAppStore.persist.rehydrate()
setup.phase = 'initialize'
const stop = await useAppStore.getState().initialize(); stop()
api.config.get = async () => config
setup.phase = 'controlled-resource-catalog'
mountThemeRuntime(window, config.appearance)
const originalDraft = 'Keep this original conversation draft.'
useAppStore.setState({ config, sessions: [], manualConnectionIntents: {}, manualConnectionSelections: {}, botTaskSelections: {}, moteBotRequests: {}, moteConnectionSaveIntents: {}, moteChatIntents: {}, connectorServiceIntents: {}, connectorServiceObservation: {}, agentComposerDrafts: { 'preview-original-session': originalDraft }, scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, reading: false, error: null } } })
api.config.save = async (next, before) => {
  if (!controls) return refuseWrite()
  if (!before) throw Error('The original display baseline is required.')
  const withoutDisplay = (value: AppConfig) => { const copy = structuredClone(value); delete copy.appearance.channelHeaderVisibility; return JSON.stringify(copy) }
  if (withoutDisplay(next) !== withoutDisplay(before)) throw Error('This preview only saves the original App header display choice.')
  note('app-display-save', { before: before.appearance.channelHeaderVisibility ?? {}, after: next.appearance.channelHeaderVisibility ?? {} })
  config = applyConfigEdit(config, before, next)
  return structuredClone(config)
}
api.connections.storeCredential = refuseWrite
api.connections.inspectCredential = async () => null
api.ui.openExternal = async () => { note('external-open'); throw Error('External navigation is not exercised by this preview.') }
api.connections.hostingTarget = async (hostId = 'local') => {
  note('hosting-target', { hostId })
  if (scenario === 'host-unavailable') throw Error('The selected background Host could not be reached. Saved bot requests are kept; check this same Host again.')
  if (hostId !== owner.hostId) throw Error('This preview has only the original local hosting owner.')
  return { ...owner }
}
api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M], target?: ConnectionHostingTarget): Promise<ConnectionResultMap[M]> => {
  note(method, input, target)
  if (!target || target.hostId !== owner.hostId || target.runtimeId !== owner.runtimeId) throw Error('The original preview hosting target is required.')
  const visible = scenario === 'empty' ? [] : records
  const p = input as Record<string, unknown>
  const record = visible.find(item => item.config.connectionId === p.connectionId)
  let result: unknown
  if (method === 'connection.owner.inspect') result = { ownership: 'local' }
  else if (method === 'connection.service.get') {
    const selector = parseConnectionServiceParams('connection.service.get', input)
    if (controls && scenario === 'service-unavailable') throw Error('The original Host automatic-message setting could not be read. Saved bots and App display choices are kept.')
    result = serviceStates.get(selector.adapterId ?? 'global') ?? { enabled: true, revision: 0, ...selector }
  }
  else if (method === 'connection.service.inspect') result = { operation: serviceOperations.get(parseConnectionServiceParams('connection.service.inspect', input).operationId) ?? null }
  else if (method === 'connection.service.configure' && controls) {
    const original = parseConnectionServiceParams('connection.service.configure', input), key = original.adapterId ?? 'global'
    const current = serviceStates.get(key) ?? { enabled: true, revision: 0 }
    if (!original.adapterId || original.expectedRevision !== current.revision) throw Error('The original platform scope and revision are required.')
    const service = { adapterId: original.adapterId, enabled: original.service.enabled, revision: current.revision + 1 }
    const operation = { operationId: original.operationId, expectedRevision: original.expectedRevision, status: 'configured' as const, service } satisfies ConnectionServiceOperation
    result = operation
    serviceStates.set(key, service); serviceOperations.set(original.operationId, operation)
  }
  else if (method === 'connection.ls') result = { connections: visible }
  else if (method === 'connection.inspect') result = { connection: record ?? null, operation: null }
  else if (method === 'connection.enrollment.ls') result = { operations: [], next: null, capabilities: [] }
  else if (method === 'connection.setup.ls') result = { operations: [], next: null, support: null }
  else if (method === 'connection.profile.ls') result = { operations: [], next: null }
  else if (method === 'connection.metadata.ls' && record) result = { connectionId: record.config.connectionId, connectionRevision: record.revision, application: record.config.application, entries: [], next: null }
  else throw Error('The controlled Settings preview does not perform ' + method)
  return structuredClone(result) as ConnectionResultMap[M]
}
api.scratch.listTopics = async () => { note('scratch.listTopics'); return structuredClone(topics) }
api.scratch.readTopic = async (_workspaceId, topicId) => { note('scratch.readTopic', { topicId }); return structuredClone(topics.find(item => item.id === topicId) ?? null) }
const targets = topics.map(topic => moteConnectionTarget({ topic, workspace, rootPath: topic.directoryPath }, {}))
const indexOf = (target: unknown) => targets.findIndex(original => JSON.stringify(original) === JSON.stringify(target))
const ref = (index: number) => index < 4 ? { connectionId: index < 2 ? 'feishu-complete' : 'discord-complete', application: records[index < 2 ? 0 : 3]!.config.application } : null
api.motePreferences.read = async (input, target) => {
  note('mote-preferences.read', input, target)
  const index = indexOf(input.target)
  if (input.kind !== 'connection' || index < 0 || target?.runtimeId !== owner.runtimeId) throw Error('The original Mote resource and hosting owner are required.')
  const path = scratchTopicDirectoryName(topics[index]!.id) + '/MOTE.md'
  return { ...input, status: 'ready', source: { resource: { ...input.target.expectedResource, zoneId: input.target.zoneId, zonePath: topics[index]!.directoryPath, path }, result: { status: 'read', document: { path, content: '# Saved Mote preferences\n', revision: 'sha256:' + 'a'.repeat(64) } } }, values: { connection: index % 2 === 0 ? ref(index) : null }, issue: null } satisfies MoteConnectionPreferencesReadResult
}
api.motePreferences.save = refuseWrite
api.moteChat.call = async <M extends MoteChatMethod>(method: M, input: MoteChatParamsMap[M], target?: ConnectionHostingTarget): Promise<MoteChatResultMap[M]> => {
  note(method, input, target)
  if (method !== 'space.mote.chat.inspect' || !('target' in input) || !input.target) throw Error('The preview only reads original Mote chat configuration.')
  const index = indexOf(input.target)
  if (index < 0 || target?.runtimeId !== owner.runtimeId) throw Error('The original Mote chat target is required.')
  const result: unknown = { operation: null, configuration: { target: input.target, revision: 1, creator: null, values: { enabled: index === 1 || index === 3, connection: index === 1 || index === 3 ? ref(index) : null, conversationIdleMs: 1800000, strangerMessageLimit: 0 } } }
  return result as MoteChatResultMap[M]
}
api.moteConnections.call = async (method, input, target) => {
  note(method, input, target)
  if (method === 'space.mote.connection.ls' && target?.runtimeId === owner.runtimeId) return { operations: [], next: null } as never
  throw Error('The preview never submits a Mote bot task.')
}
const root = createRoot(document.getElementById('root')!)
const sceneKey = () => [channel, scenario, epoch].join(':')
const render = () => root.render(<div data-channel-settings-scene={sceneKey()}><DesktopClientUiProvider><SettingsNavigation.Provider value={{
  channelEntries: settingsCatalog.channelEntries, channelPresentation: settingsCatalog.channelPresentation,
  open(section) { note('settings-navigation', { section }) }, openToolkit() {}, openHost() {}, openChannel() {}, openMoteLark() {}, chooseAgent() {},
}}><SettingsPanel key={epoch} initialSection={channel} visible onClose={() => { note('close-settings') }} /></SettingsNavigation.Provider></DesktopClientUiProvider></div>)
const proof = {
  ready: false, calls, errors, owner, topics: topics.map(topic => ({ id: topic.id, title: topic.title })),
  show(nextChannel: Channel, nextScenario: Scenario) {
    channel = nextChannel; scenario = nextScenario; epoch++
    if (controls) { config = structuredClone(initialConfig); serviceStates.clear(); serviceOperations.clear() }
    useAppStore.setState({ ...(controls ? { config, connectorServiceIntents: {} } : {}), manualConnectionSelections: {}, manualConnectionIntents: {}, connectorServiceObservation: {} })
    render(); return sceneKey()
  },
  facts() { return { channel, scenario, draft: useAppStore.getState().agentComposerDrafts['preview-original-session'], calls: structuredClone(calls), errors: [...errors], display: config.appearance.channelHeaderVisibility ?? {}, services: Object.fromEntries(serviceStates), requests: structuredClone(useAppStore.getState().connectorServiceIntents) } },
}
Object.assign(window, { channelSettingsProof: proof })
render(); proof.ready = true; setup.phase = 'ready'
