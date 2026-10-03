import { Copy, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'

type DeviceList = AgentMuxRpcResult<'device.ls'>
const operationLabels: Readonly<Record<string, string>> = { submitAgentPrompt: 'Send message', writeAgent: 'Terminal input', pasteAgent: 'Paste input', respondAgentPermission: 'Respond to permission', answerAgentRequest: 'Answer request', resizeAgent: 'Resize terminal', signalAgent: 'Send signal', stopAgent: 'Stop Agent', resumeAgent: 'Resume Agent', createAgent: 'Create Agent', removeAgent: 'Remove Agent' }

export function DeviceManagementSettings({ active }: { active: boolean }) {
  const [list, setList] = useState<DeviceList | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(''), [readIssue, setReadIssue] = useState('')
  const [refreshing, setRefreshing] = useState(false), [observedAt, setObservedAt] = useState<number | null>(null)
  const generation = useRef(0), pending = useRef(false), readSequence = useRef(0)
  const read = async (epoch = generation.current) => {
    const sequence = ++readSequence.current
    setRefreshing(true)
    try { const facts = await api.deviceManagement.ls({}); if (epoch === generation.current && sequence === readSequence.current) { setList(facts); setReadIssue(''); setObservedAt(Date.now()) } }
    catch (error) { if (epoch === generation.current && sequence === readSequence.current) setReadIssue(`Device status is unavailable. Previous records are kept. ${presentError(error)}`) }
    finally { if (epoch === generation.current && sequence === readSequence.current) setRefreshing(false) }
  }
  useEffect(() => {
    const epoch = ++generation.current
    if (!active) return
    void read(epoch)
    const timer = setInterval(() => { void read(generation.current) }, 5000)
    return () => { generation.current++; clearInterval(timer) }
  }, [active])
  const link = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice('')
    const epoch = generation.current
    try {
      const value = await api.deviceManagement.link({})
      if (epoch !== generation.current) return
      setUrl(value.url)
      try { await api.ui.writeClipboardText(value.url); setNotice('Link copied. Open it on your phone to connect.') }
      catch { setNotice('Link generated. Select and copy the full link below.') }
    } catch (error) { if (epoch === generation.current) setNotice(`Could not generate a connection link. Try again later. ${presentError(error)}`) }
    finally { pending.current = false; setBusy(false) }
  }
  const revoke = async (deviceId: string) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    const epoch = ++generation.current
    try { await api.deviceManagement.revoke({ deviceId }); if (epoch === generation.current) { setNotice('Device access revoked. Agent sessions are preserved.'); await read(epoch) } }
    catch (error) { if (epoch === generation.current) { setNotice(`Revocation is unconfirmed. Check the refreshed device status. ${presentError(error)}`); await read(epoch) } }
    finally { pending.current = false; setBusy(false) }
  }
  if (!active) return null
  const devices = list?.devices.filter(device => device.revokedAt === undefined) ?? []
  return <section className="settings-group device-management" data-device-view="settings">
    <div className="device-management__connection">
      <h3>Connect your phone</h3>
      <p className="settings-group-note">Connect your phone and Mac to the same Wi-Fi, then open the copied link in your phone’s browser.</p>
      <p className="settings-group-note">{list ? `${devices.filter(device => device.online).length} online · ${devices.length} authorized` : 'Device status not yet confirmed'}</p>
  
      <div className="settings-pane-toolbar">
        <button className="primary-button" disabled={busy} onClick={() => { void link() }}>{busy ? <LoaderCircle size={16} className="device-management__spinner" /> : <Copy size={16} />}{busy ? 'Working…' : 'Copy connection link'}</button>
      </div>
      {list && <p className="settings-group-note" role="status">{list.mobileAccess.state === 'connected' ? 'Ready to connect' : list.mobileAccess.state === 'starting' ? 'Connection service is starting. Try again shortly.' : 'Connection service unavailable'}</p>}
      {list && list.mobileAccess.state !== 'connected' && <details><summary>Connection details</summary><p className="settings-group-note">{list.mobileAccess.message}</p></details>}
      {notice && <p className="device-management__feedback" role="status">{notice}</p>}
      {url && <details className="device-management__link"><summary>View full connection link</summary><textarea aria-label="Phone connection link" rows={3} readOnly value={url} onFocus={event => event.target.select()} /></details>}
    </div>
    <div className="device-management__devices">
      <div className="settings-pane-toolbar"><h3>Connected devices</h3><button className="small-button" disabled={refreshing} onClick={() => { void read() }}>{refreshing ? <LoaderCircle size={16} className="device-management__spinner" /> : <RefreshCw size={16} />}{refreshing ? 'Checking…' : 'Refresh'}</button></div>
      {observedAt && <p className="device-management__updated">Last checked {new Date(observedAt).toLocaleTimeString()}</p>}
      {devices.map(device => <section className="host-settings-card" key={device.deviceId}>
        <div className="settings-pane-toolbar"><Smartphone size={16} /><strong>{device.name}</strong><span>{device.online ? 'Online' : 'Offline'}</span>
          <button className="small-button" disabled={busy} onClick={() => { void revoke(device.deviceId) }}>Revoke access</button></div>
        <><p className="settings-group-note">{device.lastSeenAt ? `Last active ${new Date(device.lastSeenAt).toLocaleString()}` : 'No recent activity'}</p>
          {device.operations?.slice(-10).reverse().map(operation => <p className="settings-group-note" key={operation.id}><time>{new Date(operation.at).toLocaleString()}</time> · {operationLabels[operation.method] ?? operation.method} · {operation.target} · {operation.result === 'confirmed' ? 'Submitted' : operation.result === 'failed' ? 'Failed' : 'Unconfirmed'}</p>)}</>
        {device.operationIssue && <p className="settings-group-note" role="status">{device.operationIssue}</p>}
      </section>)}
      {list && !devices.length && <p className="settings-group-note">No connected devices yet. Your phone will appear here after opening the link.</p>}
      {readIssue && <p className="settings-group-note" role="status">{readIssue}</p>}
    </div>
  </section>
}
