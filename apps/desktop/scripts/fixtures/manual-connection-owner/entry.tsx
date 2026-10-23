import { createRoot } from 'react-dom/client'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionRecord, ConnectionOperation } from '@agentmux/core/connections'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Production Settings presentation; all business DTOs here are controlled synthetic preview inputs.
const target = { hostId: 'build-host', runtimeId: 'original-build-runtime' }, local = { hostId: 'local', runtimeId: 'original-local-runtime' }
const records: ConnectionRecord[] = [], operations = new Map<string, ConnectionOperation>(), credentials = new Map<string, { credentialRef: string }>()
const config = { ...await api.config.get(), hosts: [{ id: 'build-host', kind: 'ssh' as const, label: 'Build server', hostname: 'build.invalid' }], workspaces: [], startup: { skipAgentAvailabilityCheckWait: true } }
api.config.get = async () => config
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
window.localStorage.clear(); await useAppStore.persist.rehydrate()
const stop = await useAppStore.getState().initialize(); stop()
useAppStore.setState({ config, sessions: [], botTaskSelections: {}, manualConnectionIntents: {}, manualConnectionSelections: { lark: target } })
mountThemeRuntime(window, config.appearance)
api.connections.inspectCredential = async operation => credentials.get(operation) ?? null
api.connections.storeCredential = async input => { const ref = { credentialRef: 'synthetic-private-reference' }; credentials.set(input.operationId, ref); return ref }
api.ui.openExternal = async () => {}
api.connections.hostingTarget = async (hostId = 'local') => hostId === 'local' ? local : target
let loseReply = true
api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M], owner = target): Promise<ConnectionResultMap[M]> => {
  if (![target, local].some(original => owner.hostId === original.hostId && owner.runtimeId === original.runtimeId)) throw Error('Preview owner mismatch')
  let result: unknown
  if (method === 'connection.service.get') result = { enabled: false, revision: 1 }
  else if (method === 'connection.enrollment.ls' || method === 'connection.setup.ls') result = { operations: [], next: null }
  else if (method === 'connection.ls') result = { connections: records }
  else if (method === 'connection.inspect') {
    const p = input as ConnectionParamsMap['connection.inspect']
    const operation = p.operationId ? operations.get(p.operationId) ?? null : null
    result = { operation, connection: operation?.connection ?? records.find(record => record.config.connectionId === p.connectionId) ?? null }
  } else if (method === 'connection.configure') {
    const p = input as ConnectionParamsMap['connection.configure']
    const connection: ConnectionRecord = { config: p.connection, revision: (p.expectedRevision ?? 0) + 1,
      observation: { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
    const operation: ConnectionOperation = { operationId: p.operationId, status: 'configured', connection }
    records.push(connection); operations.set(p.operationId, operation); result = operation
    if (loseReply) { loseReply = false; throw Error('The original Host save reply was interrupted.') }
  } else if (method === 'connection.test') result = { ...records[0]!, observation: { authentication: { state: 'ready' }, transport: { state: 'unknown', reason: 'not-started' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
  else if (method === 'connection.metadata.ls') result = { connectionId: records[0]!.config.connectionId, connectionRevision: 1, application: records[0]!.config.application, entries: [], next: null }
  else throw Error('Preview does not perform ' + method)
  return structuredClone(result) as ConnectionResultMap[M]
}
const root = createRoot(document.getElementById('root')!), render = (scene: string) => root.render(<DesktopClientUiProvider><SettingsPanel key={scene} visible initialSection="lark" onClose={() => {}} /></DesktopClientUiProvider>)
const proof = { ready: false, errors: [] as string[], showDefault() {
  records.length = 0
  useAppStore.setState({ manualConnectionSelections: {}, manualConnectionIntents: {}, botTaskSelections: {} }); render('default')
}, showOwnerless() {
  const original = { channel: 'lark' as const, target: null, draft: { view: 'new' as const, label: 'Original bot', appId: 'cli_original_unknown_owner', domain: 'open.feishu.cn', enabled: false }, pending: { operationId: 'original-save-unconfirmed', expectedRevision: null, connection: { connectionId: 'original-application', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_original_unknown_owner' }, label: 'Original bot', enabled: false, credentialRef: '' } } }
  useAppStore.setState({ manualConnectionIntents: { [JSON.stringify(['lark', null, null])]: original } }); render('ownerless')
} }
Object.assign(window, { manualOwnerProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
render('remote')
proof.ready = true
