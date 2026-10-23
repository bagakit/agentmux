import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MoteChatRequests } from '../../../src/renderer/src/components/MoteChatRequests'
import { MoteBotSetup } from '../../../src/renderer/src/components/MoteBotSetup'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { botTaskSelectionKey } from '../../../src/renderer/src/lib/bot-task-selection'
import { restoredMoteBotRequests } from '../../../src/renderer/src/lib/mote-bot-request'
import { parseMoteConnectionOperation, type MoteConnectionCreate } from '@agentmux/core/mote-connections'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/styles/mote-connection-identity.css'
declare const __MOTE_PREPARED_IMAGE__: { dataUrl: string; sha256: string }
const target = { spaceId: 'preview-mote', zoneId: 'preview-home', expectedResource: { hostId: 'preview-host', workspaceId: 'preview-workspace', workspacePath: (new URL('file:///').pathname + "preview/mote") } }, revision = 'sha256:' + 'a'.repeat(64)
const source = { target, preparedFrom: { topicRevision: revision, avatarRevision: revision } }, name = 'Research companion', description = 'Public notes and useful findings for our shared work.'
const input: MoteConnectionCreate = { operationId: 'prepared-admission', source, desired: { name, description, avatar: { pngDataUrl: __MOTE_PREPARED_IMAGE__.dataUrl } }, adapterId: 'preview', domain: 'preview.example' }
const enrollment = { operationId: 'prepared-child', connectionId: 'prepared-connection', adapterId: input.adapterId, domain: input.domain, label: name, preset: { name, description, avatarSha256: __MOTE_PREPARED_IMAGE__.sha256, width: 256, height: 256 }, revision: 3, authorization: 'not-started', credential: 'not-started', configuration: 'not-started', application: null, authentication: { attemptId: 'prepared-account', stage: 'confirmed' }, creation: { upload: 'not-started', create: 'not-started' }, configured: null }
const operation = parseMoteConnectionOperation({ operationId: input.operationId, action: 'create', source, snapshot: { name, description, avatarSha256: __MOTE_PREPARED_IMAGE__.sha256 }, connection: null, enrollmentOperationId: enrollment.operationId, profileOperationId: null, defaultSave: null, enrollment, profile: null, defaultLink: { state: 'pending', current: null }, issue: null })
const config = { ...await api.config.get(), hosts: [], workspaces: [], startup: { skipAgentAvailabilityCheckWait: true } }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
await useAppStore.persist.rehydrate()
const stop = await useAppStore.getState().initialize(); stop()
useAppStore.setState({ config, sessions: [] }); mountThemeRuntime(window, config.appearance)
const hostingTarget = { hostId: 'preview-connector-host', runtimeId: 'preview-connector-runtime' }
api.connections.hostingTarget = async () => ({ ...hostingTarget })
let mode: 'legacy' | 'prepared' | 'chat' = 'legacy'
const legacy = { operationId: 'original-unknown', source: { target, expectedTopicRevision: revision, expectedAvatarRevision: revision }, adapterId: input.adapterId, domain: input.domain, avatar: 'include-saved' }
function select(value: typeof mode) {
  mode = value
  const request = value === 'legacy' ? legacy : input
  useAppStore.setState({ moteBotRequests: restoredMoteBotRequests({ [request.operationId]: { action: 'create', input: request, phase: 'may-have-dispatched', ...(value === 'prepared' ? { hostingTarget } : {}) } }),
    botTaskSelections: { [botTaskSelectionKey({ kind: 'mote', target })]: value === 'prepared' ? { operationId: request.operationId, hostingTarget } : request.operationId },
    moteChatIntents: value === 'chat' ? { 'original-chat-unknown': { method: 'space.mote.chat.configure', phase: 'may-have-dispatched', input: { operationId: 'original-chat-unknown', target, expectedRevision: null, expectedConnectionRevision: null, values: { enabled: false, connection: null, conversationIdleMs: 1800000, strangerMessageLimit: 0 } } } } : {} })
}
api.files.readPublic = async params => ({ resource: { ...target.expectedResource, zoneId: target.zoneId, zonePath: target.expectedResource.workspacePath, path: 'topic.md' }, result: { status: 'read', document: { path: 'topic.md', content: '# '+name+'\n\n'+description+'\n', revision } } })
api.moteAvatars.read = async params => ({ target: params.target, revision, choice: null, image: { dataUrl: __MOTE_PREPARED_IMAGE__.dataUrl, width: 256, height: 256 }, issues: [] })
api.moteConnections.call = async (method, params) => {
  if (method === 'space.mote.connection.ls') return { operations: mode === 'prepared' ? [operation] : [], next: null } as never
  if (method === 'space.mote.connection.inspect') return { operation: mode === 'prepared' ? operation : null } as never
  throw Error('Visual preview never dispatches '+method)
}
api.connections.call = async (method, params) => {
  if (method === 'connection.enrollment.ls') return { operations: [], next: null, capabilities: [{ adapterId: input.adapterId, domain: input.domain, label: 'Bot platform', availability: 'available' }] } as never
  if (method === 'connection.enrollment.inspect') return { operation: enrollment, challenge: null, account: null, actions: [{ actionId: 'create-prepared', ownRevision: 3, kind: 'create' }] } as never
  throw Error('Visual preview never dispatches '+method)
}
const proof = { ready: false, errors: [] as string[], select: (_value: typeof mode) => {} }; Object.assign(window, { motePreparedProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message)); window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
select('legacy')
function Preview() { const [scene, setScene] = useState(mode); proof.select = value => { select(value); setScene(value) }; return <DesktopClientUiProvider><main className="mote-connection-dialog"><div className="mote-connection-dialog__body" style={{ paddingTop: 20 }}>{scene === 'chat' ? <MoteChatRequests target={target} onConfirmed={() => { throw Error('No visual preview receipt') }} /> : <MoteBotSetup key={scene} target={target} topicId="preview-topic" record={null} hasSavedBot={false} onChoose={() => {}} onCurrent={() => {}} />}</div></main></DesktopClientUiProvider> }
createRoot(document.getElementById('root')!).render(<Preview />); proof.ready = true
