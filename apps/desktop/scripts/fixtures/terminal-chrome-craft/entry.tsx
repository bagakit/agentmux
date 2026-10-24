import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { FullPageLoadingSurface, type FullPageLoadingPhase } from '../../../src/renderer/src/components/FullPageLoadingSurface'
import { SessionConnectingSurface } from '../../../src/renderer/src/components/SessionConnectingSurface'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../../../src/renderer/src/components/settings/settings-modules'
import { invalidateConnectorTarget } from '../../../src/renderer/src/lib/connector-room-intent'
import { groupTarget, type ConnectionDiagnosis, type RoomBinding } from '@agentmux/core/connections'
import { readConnectorService } from '../../../src/renderer/src/lib/connector-service-observation'

const connectorGeometry = new URLSearchParams(location.search).has('connector-geometry')
const connectorReads: string[] = []
let hostingUnavailable = false
let connectorMode: 'unbound' | 'linked' | 'paused' | 'off' = 'unbound'
let routeReady: Promise<void> | null = null, releaseRoute: (() => void) | null = null
function connectorBindings(): RoomBinding[] {
  if (connectorMode === 'unbound') return []
  const session = useAppStore.getState().sessions.find(item => item.id === original.sessionId)!
  return ['feishu', 'discord'].map(adapter => ({ bindingId: 'preview-original-' + adapter, revision: 1, connectionId: 'preview-' + adapter,
    application: adapter === 'feishu' ? { domain: 'open.feishu.cn', appId: 'cli_original_geometry' } : { domain: 'discord.com', appId: '123456789012345678' },
    externalConversationId: adapter === 'feishu' ? 'oc_original_geometry' : '345678901234567890',
    executionHostId: session.control.hostId, agentSessionId: session.id, regionAnchor: { regionId: original.regionId },
    state: connectorMode === 'paused' ? 'paused' : 'active', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' },
    sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }))
}
if (connectorGeometry) {
  api.connections.hostingTarget = async () => {
    await routeReady
    if (hostingUnavailable) throw Error('Controlled original bot hosting observation is unavailable')
    return { hostId: 'preview-bot-host', runtimeId: 'preview-original-runtime' }
  }
  api.connections.onMetadataChanged = (_listener, observation) => { observation?.('ready'); return () => {} }
  api.connections.call = (async (method: string, input: any) => {
    connectorReads.push(method)
    if (method === 'connection.binding.ls') return { bindings: connectorBindings().filter(binding => binding.executionHostId === input.executionHostId && binding.agentSessionId === input.agentSessionId) }
    if (method === 'connection.ls') return { connections: connectorBindings().map(binding => ({ revision: 1,
      config: { connectionId: binding.connectionId, adapterId: binding.application.domain === 'discord.com' ? 'discord' : 'feishu', application: binding.application, label: 'Original geometry bot', enabled: true, credentialRef: 'preview-private-reference' },
      observation: { authentication: { state: 'unknown', reason: 'not-started' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } })) }
    if (method === 'connection.service.get') return input.adapterId ? { adapterId: input.adapterId, enabled: true, revision: 0 } : { enabled: connectorMode !== 'off', revision: 1 }
    const binding = connectorBindings().find(item => item.bindingId === input.bindingId || item.connectionId === input.connectionId)
    if (method === 'connection.metadata.get' && binding) {
      const subject = { kind: 'conversation', externalConversationId: binding.externalConversationId }
      return { connectionId: binding.connectionId, connectionRevision: 1, application: binding.application, entry: { subject, cacheRevision: 'preview-original-profile',
        observation: { subject, state: 'observed', freshness: 'current', profile: { name: 'Research discussion', observedAt: Date.now() }, checkedAt: Date.now() } } }
    }
    if (method === 'connection.diagnose') return { target: input, service: { value: { enabled: connectorMode !== 'off', revision: 1 }, issue: null }, groups: { issue: null,
      value: { nextBindingId: null, items: binding ? [{ target: groupTarget(binding), window: {}, limit: 5,
        adapterService: { value: { adapterId: binding.application.domain === 'discord.com' ? 'discord' : 'feishu', enabled: true, revision: 0 }, issue: null },
        connection: { value: { revision: 1, enabled: true, authentication: { state: 'unknown', reason: 'not-started' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }, issue: null },
        binding: { value: { state: binding.state, currentRevision: binding.revision, scope: binding.scope, activeInputGrants: 1, activeAnswerGrants: 0, activePermissionGrants: 0 }, issue: null },
        outgoing: { issue: null, value: { after: null, afterContent: null, next: null, observation: { state: 'ready' }, sourceObservation: { state: 'ready', code: null, codeRecorded: false, checkpointKey: null }, effectObservation: null, deliveries: [], coverage: { state: 'complete', nextContent: null, originCount: 0, omittedGapCount: 0, gaps: [] } } },
        incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: [] } }
      }] : [] } } } satisfies ConnectionDiagnosis
    throw Error('The geometry scene does not execute ' + method)
  }) as typeof api.connections.call
}

// Actual production presentation; only the preview API and caller-supplied loading facts are controlled.
const element = document.createElement('div')
element.id = 'loading-root'
element.hidden = true
document.body.append(element)
const root = createRoot(element)
const original = (window as any).resultReady
Object.assign(window, { terminalChrome: {
  connectors(pending = false) {
    hostingUnavailable = false
    connectorMode = 'unbound'
    routeReady = pending ? new Promise<void>(resolve => { releaseRoute = resolve }) : null
    flushSync(() => workbenchRoot.render(<SettingsNavigation.Provider value={{
      open() {}, openToolkit() {}, openHost() {}, openChannel() {}, chooseAgent() {}, openMoteLark() {},
      channelPresentation: settingsCatalog.channelPresentation, channelEntries: settingsCatalog.channelEntries
    }}><WorkspaceWorkbench workspaceId={original.workspaceId} /></SettingsNavigation.Provider>))
  },
  connectorReads: () => connectorReads,
  releaseConnectorRead() { releaseRoute?.(); releaseRoute = null; routeReady = null },
  async connectorMode(value: typeof connectorMode) {
    connectorMode = value; hostingUnavailable = false
    await readConnectorService(() => true, { hostId: 'preview-bot-host', runtimeId: 'preview-original-runtime' })
    const session = useAppStore.getState().sessions.find(item => item.id === original.sessionId)!
    invalidateConnectorTarget({ executionHostId: session.control.hostId, agentSessionId: session.id })
  },
  hostingUnavailable() {
    hostingUnavailable = true
    const session = useAppStore.getState().sessions.find(item => item.id === original.sessionId)!
    invalidateConnectorTarget({ executionHostId: session.control.hostId, agentSessionId: session.id })
  },
  reading() {
    const element = document.querySelector(`[data-workbench-region-id="${original.regionId}"] .xterm`)
    const record = (window as any).resultReadyTerminals.find((item: any) => item.terminal.element === element && !item.disposed)
    if (!record) throw Error('The original native xterm is absent')
    return { selection: record.terminal.getSelection(), buffer: record.terminal.buffer.active.type }
  },
  show(phase: FullPageLoadingPhase | 'connecting', scope: 'app' | 'region', theme = 'dark') {
    const terminalRecovery = phase === 'recovering' && scope === 'region'
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    document.documentElement.dataset.appearance = theme
    document.getElementById('root')!.style.display = 'none'
    element.hidden = false
    flushSync(() => root.render(phase === 'connecting' ? <SessionConnectingSurface phase="restore" surfaceKind="agent"
      request={{ executorId: 'private-executor', prompt: 'Keep the complete original prompt readable.\nRestore the same saved work surface.' }} /> :
      <FullPageLoadingSurface phase={phase} scope={scope} eyebrow={terminalRecovery ? 'Terminal recovery' : phase === 'parked' ? 'Session retained' : 'AgentMux'}
        title={terminalRecovery ? 'Restoring terminal' : phase === 'parked' ? 'Ready to restore' : phase === 'failed' ? 'Connection needs attention' : phase === 'recovering' ? 'Restoring your workspace' : 'Starting AgentMux'}
        detail={terminalRecovery ? 'Replaying retained output and confirming the viewport before live bytes return.' : phase === 'parked' ? 'Existing history and your draft are kept. Send your next request or use Resume.' : phase === 'failed'
          ? 'The connection could not be confirmed. Your sessions, layout and unsent drafts are retained. Check the service and try reconnecting when it is available.'
          : 'Reconnecting to your saved sessions. Your layout stays in place.'}
        details={terminalRecovery ? { summary: 'Recovery details', content: <dl>
          <dt>Session</dt><dd>{session.label}</dd>
          <dt>Run</dt><dd>{session.control.run.runId}</dd>
          <dt>Process</dt><dd>{session.processState}</dd>
        </dl> } : undefined}
        actions={phase === 'failed' ? <button className="small-button" onClick={() => { (window as any).recoveryClicks = ((window as any).recoveryClicks ?? 0) + 1 }}>Retry connection</button> : null} />))
  },
  identity() {
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    return { label: session.label, runId: session.control.run.runId }
  },
  workbench() { element.hidden = true; document.getElementById('root')!.style.display = 'flex'; document.documentElement.dataset.appearance = 'dark' },
  async alternate() {
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    await api.sessions.write(session.control, '\x1b[?1049h\x1b[HLive full-screen application\r\nagent > ')
  },
  park() {
    flushSync(() => useAppStore.setState(state => ({ sessions: state.sessions.map(s => s.id === original.sessionId ? { ...s, processState: 'exited' as const } : s) })))
  }
} })
import '../terminal-service-notice-escape/entry'
import { root as workbenchRoot } from '../result-ready-input-continuity/entry'
