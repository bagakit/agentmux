import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionMethod, ConnectionParamsMap, ConnectionResultMap, ConnectionRecord } from '@agentmux/core/connections'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Production presentation with controlled public DTOs; no token or native side effect leaves this private preview.
const records: ConnectionRecord[] = [], operations = new Map<string, unknown>(), calls: string[] = []
let checks = 0
const config = { ...await api.config.get(), workspaces: [] }
useAppStore.setState({ config, sessions: [], botTaskSelections: {} })
mountThemeRuntime(window, config.appearance)
api.connections.inspectCredential = async () => null
api.connections.storeCredential = async () => { calls.push('secure-credential-write'); return { credentialRef: 'private-preview-reference' } }
api.ui.openExternal = async () => { calls.push('developer-portal') }
api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
  calls.push(method)
  let value: unknown
  if (method === 'connection.ls') value = { connections: records }
  else if (method === 'connection.service.get') value = { enabled: true, revision: 1 }
  else if (method === 'connection.inspect') { const p = input as ConnectionParamsMap['connection.inspect']; value = 'operationId' in p ? { connection: null, operation: operations.get(p.operationId!) ?? null } : { connection: records.find(record => record.config.connectionId === p.connectionId) ?? null, operation: null } }
  else if (method === 'connection.configure') {
    const p = input as ConnectionParamsMap['connection.configure']
    const record: ConnectionRecord = { config: p.connection, revision: 1, observation: { authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } } }
    records.push(record); value = { operationId: p.operationId, status: 'configured', connection: record }; operations.set(p.operationId, value)
  } else if (method === 'connection.test') {
    const record = records[0]!
    value = { ...record, observation: { authentication: ++checks > 1 ? { state: 'unavailable', reason: 'check-failed' } : { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
  } else if (method === 'connection.metadata.ls') value = { connectionId: records[0]!.config.connectionId, connectionRevision: 1, application: records[0]!.config.application, entries: [], next: null }
  else if (method === 'connection.delete.ls') value = { operations: [], next: null }
  else throw Error('Preview does not perform ' + method)
  return structuredClone(value) as ConnectionResultMap[M]
}
const proof = { ready: false, calls, errors: [] as string[] }
Object.assign(window, { discordSettingsProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
function Fixture() { const [visible, setVisible] = useState(true); return <DesktopClientUiProvider><SettingsPanel visible={visible} initialSection="discord" onClose={() => setVisible(false)} /></DesktopClientUiProvider> }
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
