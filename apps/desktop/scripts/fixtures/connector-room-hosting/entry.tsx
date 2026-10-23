import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { AgentConnectorDialog } from '../../../src/renderer/src/components/AgentConnectorDialog'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
const hostingTarget = { hostId: 'research-host', runtimeId: 'research-runtime' }, target = { executionHostId: 'agent-host', agentSessionId: 'research-agent' }
const connection = { config: { connectionId: 'research-bot', adapterId: 'preview', application: { domain: 'chat.example', appId: 'research-application' }, label: 'Research group bot', enabled: true, credentialRef: 'preview-reference' }, revision: 1, observation: { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }, capabilities: { roomDiscovery: true, roomCreation: true, roomLink: true } }
const config = { ...await api.config.get(), hosts: [], workspaces: [], startup: { skipAgentAvailabilityCheckWait: true } }
api.config.get = async () => config; api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
await useAppStore.persist.rehydrate(); const stop = await useAppStore.getState().initialize(); stop(); useAppStore.setState({ config, sessions: [] }); mountThemeRuntime(window, config.appearance)
api.connections.hostingTarget = async () => ({ ...hostingTarget })
api.connections.onMetadataChanged = () => () => {}
api.connections.call = async method => {
  if (method === 'connection.ls') return { connections: [connection] } as never
  if (method === 'connection.binding.ls') return { bindings: [] } as never
  if (method === 'connection.service.get') return { enabled: true, revision: 1 } as never
  if (method === 'connection.room.ls') return { rooms: [], next: null, observation: { state: 'ready' } } as never
  if (method === 'connection.profile.get') return { bot: null, creator: null, reason: 'not-observed' } as never
  throw Error('Visual preview never dispatches ' + method)
}
let mode: 'fresh' | 'unknown' = 'fresh'
function select(value: typeof mode) {
  mode = value
  const operationId = 'original-room-request'
  useAppStore.setState({ connectorRoomDrafts: {}, connectorRoomIntents: value === 'unknown' ? { [operationId]: { target, method: 'connection.room.create', phase: 'may-have-dispatched', input: { ...target, operationId, connectionId: connection.config.connectionId, expectedConnectionRevision: 1, name: 'Original discussion group', members: [] } } } : {} })
}
const proof = { ready: false, errors: [] as string[], select: (_value: typeof mode) => {} }; Object.assign(window, { roomHostingProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message)); window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
const session = { id: target.agentSessionId, control: { hostId: target.executionHostId, agentSessionId: target.agentSessionId, run: { runId: 'preview-run' } }, nativeHandle: { kind: 'provider' as const, providerId: 'preview', sessionId: 'preview-native' } }
select('fresh')
function Preview() { const [scene, setScene] = useState(mode); proof.select = value => { select(value); setScene(value) }; return <DesktopClientUiProvider><AgentConnectorDialog key={scene} original={{ target, hostingTarget, session, name: 'Research companion' }} mode="existing" onClose={() => {}} returnFocus={() => null} /></DesktopClientUiProvider> }
createRoot(document.getElementById('root')!).render(<Preview />); proof.ready = true
