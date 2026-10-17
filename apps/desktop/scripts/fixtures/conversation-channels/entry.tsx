import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConnectionEnrollmentOperation, ConnectionRecord, ConnectionMethod, ConnectionParamsMap, ConnectionResultMap } from '@agentmux/core/connections'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import type { SettingsPageId } from '../../../src/renderer/src/components/settings/settings-modules'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { deviceInvitation, deviceList } from '../settings-connections/data'
import '../../../src/renderer/src/styles/index.css'

// Controlled public DTOs exercise production presentation; no real device or tenant is contacted.
const calls: Array<{ method: string; input?: unknown }> = []
const connection: ConnectionRecord = {
  config: { connectionId: 'preview-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'preview-app' },
    label: 'Research and engineering team', enabled: true, credentialRef: 'preview-reference' },
  revision: 1, observation: { authentication: { state: 'unknown' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }
}
const original: ConnectionEnrollmentOperation = {
  operationId: 'original-preview-setup', connectionId: 'original-preview-connection', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Team conversation assistant',
  revision: 2, authorization: 'not-started', credential: 'not-started', configuration: 'not-started', application: null, configured: null,
  authentication: { attemptId: 'original-preview-sign-in', stage: 'unknown' },
  diagnostic: { stage: 'authentication', code: 'native-unconfirmed', step: 'console', failure: 'redirect-unconfirmed', boundary: 'handoff', httpStatus: 302 }
}
const config = { ...await api.config.get(), workspaces: [] }
useAppStore.setState({ config, sessions: [] })
mountThemeRuntime(window, config.appearance)
api.deviceManagement.ls = async input => { calls.push({ method: 'device.ls', input }); return structuredClone({ ...deviceList, mobileAccess: { state: 'connected' as const, message: 'Controlled first-party connection' } }) }
api.deviceManagement.link = async input => { calls.push({ method: 'device.link', input }); return structuredClone(deviceInvitation) }
api.deviceManagement.revoke = async input => { calls.push({ method: 'device.revoke', input }); throw new Error('Preview does not revoke real device access') }
api.ui.writeClipboardText = async value => { calls.push({ method: 'clipboard', input: value }) }
api.connections.call = async <M extends ConnectionMethod>(method: M, input: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
  calls.push({ method, input: structuredClone(input) })
  const value = method === 'connection.ls' ? { connections: [connection] }
    : method === 'connection.service.get' ? { enabled: false, revision: 1 }
    : method === 'connection.enrollment.ls' ? { operations: [original], next: null, capabilities: [] }
    : method === 'connection.enrollment.inspect' ? { operation: original, challenge: null, account: null, actions: [] }
    : method === 'connection.setup.ls' ? { operations: [], next: null, capability: null }
    : null
  if (!value) throw new Error('Preview does not execute ' + method)
  return structuredClone(value) as ConnectionResultMap[M]
}
const proof = { ready: false, calls, errors: [] as string[] }
Object.assign(window, { conversationChannelsProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
function Fixture() {
  const [visible, setVisible] = useState(true)
  return <DesktopClientUiProvider><SettingsPanel visible={visible} initialSection={'overview' satisfies SettingsPageId} onClose={() => setVisible(false)} /></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
