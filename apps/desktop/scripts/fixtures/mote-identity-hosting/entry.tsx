import { createRoot } from 'react-dom/client'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { DocumentOverlayPortal } from '../../../src/renderer/src/components/WindowOverlayHost'
import { MoteConnectionPanel } from '../../../src/renderer/src/components/MoteConnectionIdentity'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/styles/mote-connection-identity.css'
declare const __MOTE_PREPARED_IMAGE__: { dataUrl: string; sha256: string }
const target = { spaceId: 'preview-mote', zoneId: 'preview-home', expectedResource: { hostId: 'preview-host', workspaceId: 'preview-workspace', workspacePath: (new URL('file:///').pathname + "preview/mote") } }, revision = 'sha256:' + 'a'.repeat(64)
const config = { ...await api.config.get(), hosts: [], workspaces: [], startup: { skipAgentAvailabilityCheckWait: true } }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
await useAppStore.persist.rehydrate()
const stop = await useAppStore.getState().initialize(); stop()
useAppStore.setState({ config, sessions: [] }); mountThemeRuntime(window, config.appearance)
const name = 'Research companion', description = 'Public notes and useful findings for our shared work.'
const hostingTarget = { hostId: 'preview-connector-host', runtimeId: 'preview-connector-runtime' }
api.connections.hostingTarget = async () => ({ ...hostingTarget })
const resource = { ...target.expectedResource, zoneId: target.zoneId, zonePath: (new URL('file:///').pathname + "preview/mote"), path: 'MOTE.md' }
const moteDocument = { path: 'MOTE.md', content: '# Mote preferences\n', revision }
const reference = { connectionId: 'research-bot', application: { domain: 'chat.example', appId: 'research-application' } }
const values = { connection: reference }
const record = { config: { ...reference, adapterId: 'preview', label: 'Research group bot', enabled: true, credentialRef: 'preview-reference' }, revision: 1, observation: { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
api.motePreferences.read = async () => ({ kind: 'connection', target, status: 'ready', source: { resource, result: { status: 'read', document: moteDocument } }, values, issue: null })
api.motePreferences.save = async () => { throw Error('Visual preview never saves a preference') }
useAppStore.setState({ moteBotRequests: {}, botTaskSelections: {}, moteConnectionSaveIntents: { 'original-choice-unknown': { phase: 'may-have-dispatched', input: { kind: 'connection', target, operationId: 'original-choice-unknown', baseline: { resource, document: moteDocument, values }, values: { connection: null } } } } })
api.files.readPublic = async params => ({ resource: { ...target.expectedResource, zoneId: target.zoneId, zonePath: target.expectedResource.workspacePath, path: 'topic.md' }, result: { status: 'read', document: { path: 'topic.md', content: '# '+name+'\n\n'+description+'\n', revision } } })
api.moteAvatars.read = async params => ({ target: params.target, revision, choice: null, image: { dataUrl: __MOTE_PREPARED_IMAGE__.dataUrl, width: 256, height: 256 }, issues: [] })
api.moteConnections.call = async method => {
  if (method === 'space.mote.connection.ls') return { operations: [], next: null } as never
  throw Error('Visual preview never dispatches ' + method)
}
api.connections.call = async method => {
  if (method === 'connection.ls') return { connections: [record] } as never
  if (method === 'connection.enrollment.ls') return { operations: [], next: null, capabilities: [] } as never
  throw Error('Visual preview never dispatches ' + method)
}
const proof = { ready: false, errors: [] as string[] }; Object.assign(window, { moteIdentityHostingProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message)); window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><Dialog.Root open><DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" /><Dialog.Content className="dialog-surface mote-connection-dialog"><header className="mote-connection-dialog__header"><div><Dialog.Title>Bot for Research companion</Dialog.Title><Dialog.Description>New group chats use this bot. Existing groups keep their bot.</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="Close bot choice">×</button></Dialog.Close></header><MoteConnectionPanel target={target} hostingTarget={hostingTarget} topicId="preview-topic" moteName="Research companion" onRead={() => {}} /></Dialog.Content></DocumentOverlayPortal></Dialog.Root></DesktopClientUiProvider>); proof.ready = true
