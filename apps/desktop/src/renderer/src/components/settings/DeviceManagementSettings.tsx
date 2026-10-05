import { Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { ConnectionLinkCode } from '../toolkit/ConnectionLinkCode'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')


type DeviceList = AgentMuxRpcResult<'device.ls'>


export function DeviceManagementSettings({ active }: { active: boolean }) {
  const [list, setList] = useState<DeviceList | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(''), [readIssue, setReadIssue] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<{ deviceId: string; text: string } | null>(null)
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
  const copyFingerprint = async (deviceId: string, fingerprint: string) => {
    try { await api.ui.writeClipboardText(fingerprint); setCopyFeedback({ deviceId, text: 'Key fingerprint copied.' }) }
    catch (error) { setCopyFeedback({ deviceId, text: `Could not copy the fingerprint. Select the full value below. ${presentError(error)}` }) }
  }
  if (!active) return null
  const devices = list?.devices.filter(device => device.revokedAt === undefined) ?? []
  return <section className="settings-group device-management" data-device-view="settings">
    <div className="device-management__connection">
      <h3>Connect your phone</h3>
      <p className="settings-group-note">Connect both devices to the same Wi-Fi, then scan the code with your phone’s camera or open the copied link.</p>
      <p className="settings-group-note">{list ? `${devices.filter(device => device.online === true).length} connected · ${devices.length} authorized` : 'Device status not yet confirmed'}</p>
  
      <div className="settings-pane-toolbar">
        <button className="primary-button" disabled={busy} onClick={() => { void link() }}>{busy ? <ThemeStatusLoadingIcon size={16} className="device-management__spinner" /> : <ThemeActionCopyIcon size={16} />}{busy ? 'Working…' : 'Copy connection link'}</button>
      </div>
      {list && <p className="settings-group-note" role="status">{list.mobileAccess.state === 'connected' ? 'Ready to connect' : list.mobileAccess.state === 'starting' ? 'Connection service is starting. Try again shortly.' : 'Connection service unavailable'}</p>}
      {list && list.mobileAccess.state !== 'connected' && <details><summary>Connection details</summary><p className="settings-group-note">{list.mobileAccess.message}</p></details>}
      {notice && <p className="device-management__feedback" role="status">{notice}</p>}
      {url && <><ConnectionLinkCode url={url} /><details className="device-management__link"><summary>View full connection link</summary><Textarea aria-label="Phone connection link" rows={3} readOnly value={url} onFocus={event => event.target.select()} /></details></>}
    </div>
    <div className="device-management__devices">
      <div className="settings-pane-toolbar"><h3>Devices</h3><button className="small-button" disabled={refreshing} onClick={() => { void read() }}>{refreshing ? <ThemeStatusLoadingIcon size={16} className="device-management__spinner" /> : <ThemeActionRefreshIcon size={16} />}{refreshing ? 'Checking…' : 'Refresh'}</button></div>
      {observedAt && <p className="device-management__updated">Last checked {new Date(observedAt).toLocaleTimeString()}</p>}
      <details className="device-management__records" data-device-records>
        <summary>Device records{list ? ` · ${devices.length} authorized` : ''}</summary>
        {devices.map(device => <details className="device-management__record" data-device-record={device.deviceId} key={device.deviceId}>
          <summary><ThemeObjectPhoneIcon size={16} aria-hidden="true" /><strong>{device.name}</strong><span>{device.online === true ? 'Connected' : device.online === false ? 'Disconnected' : 'Connection unconfirmed'}</span></summary>
          <div className="device-management__record-body">
            <dl className="device-management__identity">
              <div><dt>Key fingerprint</dt><dd><code>{device.keyFingerprint ?? 'Not yet confirmed'}</code>{device.keyFingerprint && <button type="button" className="performance-icon-button" aria-label={`Copy key fingerprint for ${device.name}`} title="Copy key fingerprint" onClick={() => { void copyFingerprint(device.deviceId, device.keyFingerprint!) }}><ThemeActionCopyIcon size={14} /></button>}</dd></div>
              <div><dt>{device.online === true ? 'Connection IP' : device.online === false ? 'Last connection IP' : 'Recorded connection IP'}</dt><dd><code>{device.connection?.address ?? 'Not recorded'}</code>{device.connection?.address && <small>Recorded {new Date(device.connection.observedAt ?? device.connection.connectedAt).toLocaleString()}</small>}</dd></div>
              <div><dt>Browser (reported)</dt><dd>{device.connection?.userAgent ?? 'Not recorded'}</dd></div>
              <div><dt>Device ID</dt><dd><code>{device.deviceId}</code></dd></div>
              <div><dt>Paired</dt><dd><time dateTime={new Date(device.createdAt).toISOString()}>{new Date(device.createdAt).toLocaleString()}</time></dd></div>
            </dl>
            <div className="device-management__connection-record" aria-label="Latest connection record">
              {device.connection ? <><p>Connected <time dateTime={new Date(device.connection.connectedAt).toISOString()}>{new Date(device.connection.connectedAt).toLocaleString()}</time></p>
                {device.connection.disconnectedAt !== undefined && <p>Disconnected <time dateTime={new Date(device.connection.disconnectedAt).toISOString()}>{new Date(device.connection.disconnectedAt).toLocaleString()}</time></p>}
                {device.online === false && device.connection.disconnectedAt === undefined && <p>Disconnect time was not recorded.</p>}</> : <p>No connection times recorded yet.</p>}
            </div>
            {device.connectionIssue && <p className="settings-group-note" role="status">{device.connectionIssue}</p>}
            {device.operationIssue && <p className="settings-group-note" role="status">{device.operationIssue}</p>}
            {copyFeedback?.deviceId === device.deviceId && <p className="device-management__feedback" role="status">{copyFeedback.text}</p>}
            <button className="small-button" disabled={busy} onClick={() => { void revoke(device.deviceId) }}>Revoke access</button>
          </div>
        </details>)}
        {list && !devices.length && <p className="settings-group-note">No devices paired yet. Your phone will appear after opening the link.</p>}
      </details>
      {readIssue && <p className="settings-group-note" role="status">{readIssue}</p>}
    </div>
  </section>
}
