import { Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../../lib/api'
import { NetworkChoice, PhoneConnectionCard, PhoneConnectionSteps, DevicePresence } from '../toolkit/PhoneConnectionVisuals'
import { OpenInSurveyButton } from '../toolkit/ToolkitResultLink'
import './mobile-settings.css'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeObjectPhoneIcon = semanticIconComponent('object.phone')
const ThemeObjectConnectionCodeIcon = semanticIconComponent('object.connection-code')


type DeviceList = AgentMuxRpcResult<'device.ls'>


export function DeviceManagementSettings({ active }: { active: boolean }) {
  const [list, setList] = useState<DeviceList | null>(null), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [url, setUrl] = useState(''), [readIssue, setReadIssue] = useState('')
  // The Mac's local-network addresses from the last link read; the chosen one stays until changed.
  const [candidates, setCandidates] = useState<AgentMuxRpcResult<'device.link'>['candidates']>([])
  // `chosen` is the person's explicit pick; `shown` is the address the current link actually uses.
  const [chosen, setChosen] = useState<string | null>(null), [shown, setShown] = useState<string | null>(null)
  const [linkAction, setLinkAction] = useState<'scan' | 'copy' | null>(null)
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
  // Only an address the person picked is requested again; the Host's own preferred address is never
  // pinned, so a network change that removes it does not make every later refresh fail.
  const link = async (action: 'scan' | 'copy', picked = chosen) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setLinkAction(action); setNotice('')
    const epoch = generation.current
    try {
      let connectionUrl: string
      const request = picked && (!candidates.length || candidates.some(candidate => candidate.address === picked)) ? picked : null
      // A pick can leave this Mac with a network change. Electron IPC keeps only an error's message, so a
      // failed pick is followed by one read of the default link, which also brings the current candidates;
      // a pick that is no longer among them is then dropped. Any other failure still reaches the notice below.
      let result: Awaited<ReturnType<typeof api.deviceManagement.link>>
      try { result = await api.deviceManagement.link(request ? { address: request } : {}) }
      catch (error) {
        if (!request) throw error
        result = await api.deviceManagement.link({})
        if (result.candidates.some(candidate => candidate.address === request)) throw error
      }
      if (epoch !== generation.current) return
      connectionUrl = result.url; setCandidates(result.candidates)
      setChosen(request && result.candidates.some(candidate => candidate.address === request) ? request : null)
      setShown(new URL(result.pageUrl).hostname)
      if (epoch !== generation.current) return
      setUrl(connectionUrl)
      if (action === 'scan') { setNotice('Scan this code with your phone camera to connect.'); return }
      try { await api.ui.writeClipboardText(connectionUrl); if (epoch === generation.current) setNotice('Link copied. Open it on your phone to connect.') }
      catch { if (epoch === generation.current) setNotice('Could not copy the link. Scan the code or select the full link below.') }
    } catch (error) { if (epoch === generation.current) setNotice(`Could not read the connection link. Try again. ${presentError(error)}`) }
    finally { pending.current = false; setBusy(false); setLinkAction(null) }
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
    <div className="device-management__connection phone-connect-hero">
      <header className="phone-connect-hero__head">
        <span className="phone-connect-hero__badge"><ThemeObjectPhoneIcon size={22} aria-hidden="true" /></span>
        <div><h3>Connect your phone</h3><p>Your agents, conversations and terminals, in your pocket. Everything stays encrypted between this Mac and your phone.</p></div>
      </header>
      <div className="phone-connect-hero__body">
        <div className="phone-connect-hero__code">
          {url ? <PhoneConnectionCard url={url} network={candidates.find(candidate => candidate.address === shown) ?? null} state={busy ? 'updating' : 'current'} />
            : <button type="button" className="phone-connect-hero__reveal" data-device-action="scan" disabled={busy} onClick={() => { void link('scan') }}>
              {linkAction === 'scan' ? <ThemeStatusLoadingIcon size={28} animation="spin" /> : <ThemeObjectConnectionCodeIcon size={32} strokeWidth={1.4} />}
              <strong>{linkAction === 'scan' ? 'Getting code…' : 'Show connection code'}</strong></button>}
        </div>
        <div className="phone-connect-hero__side">
          {!devices.length ? <PhoneConnectionSteps /> : <p className="phone-connect-hero__ready">Scan with any phone to add it. {devices.filter(device => device.online === true).length} of {devices.length} online now.</p>}
          <NetworkChoice candidates={candidates} value={shown} disabled={busy} onChoose={address => { void link('scan', address) }} />
          {candidates.length > 1 ? <p className="phone-connect-hero__hint">Pick the network your phone is on.</p> : null}
          <div className="settings-pane-toolbar device-management__actions">
            {url ? <button type="button" className="primary-button" data-device-action="scan" disabled={busy} onClick={() => { void link('scan') }}>{linkAction === 'scan' ? <ThemeStatusLoadingIcon size={16} animation="spin" /> : <ThemeActionRefreshIcon size={16} />}{linkAction === 'scan' ? 'Getting code…' : 'Refresh code'}</button> : null}
            <button type="button" className="small-button" data-device-action="copy" disabled={busy} onClick={() => { void link('copy') }}>{linkAction === 'copy' ? <ThemeStatusLoadingIcon size={16} animation="spin" /> : <ThemeActionCopyIcon size={16} />}{linkAction === 'copy' ? 'Copying…' : 'Copy connection link'}</button>
            {url ? <OpenInSurveyButton url={url} note="Opens your phone page in Survey on this Mac. It connects as another device." /> : null}
          </div>
          {url && <p className="phone-connect-hero__hint">Opening in Survey connects this Mac as another device.</p>}
          {notice && <p className="device-management__feedback" role="status">{notice}</p>}
          {url && <details className="device-management__link"><summary>View full connection link</summary><Textarea aria-label="Phone connection link" rows={3} readOnly value={url} onFocus={event => event.target.select()} /></details>}
        </div>
      </div>
    </div>
    <div className="device-management__devices">
      <div className="settings-pane-toolbar"><div><h3>Devices</h3><p className="device-management__count">{list ? <>{readIssue ? 'Last observed · ' : ''}<strong className="phone-device-count"><DevicePresence online={devices.some(device => device.online === true) || undefined} />{devices.filter(device => device.online === true).length} online</strong><span> · {devices.length} authorized</span></> : 'Device status not yet confirmed'}</p></div><button className="small-button" disabled={refreshing} onClick={() => { void read() }}>{refreshing ? <ThemeStatusLoadingIcon size={16} animation="spin" /> : <ThemeActionRefreshIcon size={16} />}{refreshing ? 'Checking…' : 'Refresh'}</button></div>
      {observedAt && <p className="device-management__updated">Last checked {new Date(observedAt).toLocaleTimeString()}</p>}
      {list && <div className="device-management__service">
        <span>Connection service{readIssue ? ' · last observed' : ''}</span><strong>{list.mobileAccess.state === 'connected' ? 'Ready to connect' : list.mobileAccess.state === 'starting' ? 'Starting' : 'Unavailable'}</strong>
        {list.mobileAccess.state !== 'connected' && <details><summary>Connection details</summary><p>{list.mobileAccess.message}</p></details>}
      </div>}
      {readIssue && <div className="device-management__read-issue" role="status">
        <strong>Device status unavailable</strong><p>Previous records are kept. Refresh to check again.</p>
        <details><summary>Observation details</summary><p>{readIssue}</p></details>
      </div>}
      <details className="device-management__records" data-device-records>
        <summary>Device records{list ? ` · ${devices.length} authorized` : ''}</summary>
        {devices.map(device => <details className="device-management__record" data-device-record={device.deviceId} key={device.deviceId}>
          <summary><span className="phone-device-avatar"><ThemeObjectPhoneIcon size={16} aria-hidden="true" /><DevicePresence online={device.online} /></span><strong>{device.name}</strong><span>{device.online === true ? 'Connected' : device.online === false ? 'Disconnected' : 'Connection unconfirmed'}</span></summary>
          <div className="device-management__record-body">
            <dl className="device-management__identity">
              <div><dt>Key fingerprint</dt><dd><code>{device.keyFingerprint ?? 'Not yet confirmed'}</code>{device.keyFingerprint && <button type="button" className="icon-button" aria-label={`Copy key fingerprint for ${device.name}`} title="Copy key fingerprint" onClick={() => { void copyFingerprint(device.deviceId, device.keyFingerprint!) }}><ThemeActionCopyIcon size={14} /></button>}</dd></div>
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
            <button className="danger-button" disabled={busy} onClick={() => { void revoke(device.deviceId) }}>Revoke access</button>
          </div>
        </details>)}
        {list && !devices.length && <p className="settings-group-note">No devices paired yet. Open the connection link on your phone to get started.</p>}
      </details>
    </div>
  </section>
}
