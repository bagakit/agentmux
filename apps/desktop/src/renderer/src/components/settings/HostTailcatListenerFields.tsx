import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { InputGroup, Switch, Textarea, TextInput } from '@agentmux/client-ui/input'
import type { HostRuntimeObservation } from '@agentmux/core'
import type { LocalHostConfig, TailcatListenerConfig } from '@agentmux/host/host-configuration'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import { copyTextToClipboard } from '../../lib/clipboard-copy'
import { useContentCopyAction } from '@agentmux/client-ui/use-content-copy-action'
import { TailcatKeyPreparation } from './TailcatKeyPreparation'
import { TailcatSetupFlow } from './TailcatSetupFlow'

type Listener = HostRuntimeObservation['tailcat']

/** Draft editing never starts a listener; the original Host applies saved configuration. */
export function HostTailcatListenerFields({ host, committed, active, onChange, allowedClientsText, onAllowedClientsTextChange, saveLabel = 'Save hosts' }: {
  host: LocalHostConfig
  committed?: HostConfig | undefined
  active: boolean
  saveLabel?: string
  onChange: (config: TailcatListenerConfig) => void
  allowedClientsText?: string | undefined
  onAllowedClientsTextChange?: ((text: string) => void) | undefined
}) {
  const configuration = host.tailcat ?? { enabled: false, keyFile: '', allowedClients: [] }
  const latest = useRef(configuration); latest.current = configuration
  const visible = useRef(active); visible.current = active
  const allowedInput = useRef<HTMLTextAreaElement>(null)
  const addressField = useId()
  const [clientText, setClientText] = useState({ text: configuration.allowedClients.join('\n'), keys: configuration.allowedClients })
  const retainedKeys = allowedClientsText?.split('\n').map(key => key.trim()).filter(Boolean)
  const allowedText = retainedKeys && configValuesEqual(retainedKeys, configuration.allowedClients) ? allowedClientsText!
    : configValuesEqual(clientText.keys, configuration.allowedClients) ? clientText.text : configuration.allowedClients.join('\n')
  const target = JSON.stringify(committed)
  const saved = committed !== undefined && configValuesEqual(host, committed)
  const [revision, setRevision] = useState(0)
  const [read, setRead] = useState<{ target: string; value?: Listener; error?: string; busy?: boolean }>({ target })
  useEffect(() => {
    if (!active || !saved) return
    const controller = new AbortController()
    setRead(previous => ({ ...(previous.target === target ? previous : { target }), busy: true }))
    void api.hosts.inspect(committed!, { signal: controller.signal }).then(observation => {
      if (controller.signal.aborted) return
      if (observation.routeHostId !== host.id || !configValuesEqual(observation.configuration, committed)) throw new Error('Listener observation belongs to another Host.')
      setRead({ target, value: observation.tailcat })
    }).catch(() => {
      if (!controller.signal.aborted) setRead(previous => ({ ...(previous.target === target ? previous : { target }), busy: false,
        error: 'Listener status could not be read. Existing Agent work remains available; refresh this observation.' }))
    })
    return () => controller.abort()
  }, [active, saved, target, revision, host.id])
  const current = read.target === target ? read : undefined
  const listener = current?.value
  const address = listener?.state === 'listening' ? listener.address : undefined
  const copyIdentity = useMemo(() => ({}), [target, address])
  const copy = useContentCopyAction(copyIdentity, copyTextToClipboard, active && saved)
  return <div className="host-tailcat-listener" data-tailcat-listener>
    <TailcatSetupFlow role="server" peerName="The other Mac" />
    <TailcatKeyPreparation active={active} host={host} role="server" keyFile={configuration.keyFile} saveLabel={saveLabel} onPrepared={(result, mayFocus) => {
      if (!configValuesEqual(latest.current, configuration)) return false
      onChange({ ...latest.current, keyFile: latest.current.keyFile || result.key, enabled: true })
      if (visible.current && mayFocus) allowedInput.current?.focus()
      return true
    }} />
    <details className="host-tailcat-advanced"><summary>Receiving key</summary><div className="host-edit-grid">
      <label className="host-edit-grid__wide"><span>Server key file or name</span><TextInput aria-label="Tailcat server key" value={configuration.keyFile}
        onChange={event => onChange({ ...configuration, keyFile: event.target.value })} placeholder="agentmux-server" /></label>
    </div></details>
    <div className="host-edit-grid">
      <label className="host-edit-grid__wide"><span>Allowed client public keys <small>one per line</small></span><Textarea ref={allowedInput} aria-label="Tailcat allowed clients" value={allowedText} rows={3} spellCheck={false}
        onChange={event => {
          const text = event.target.value, keys = text.split('\n').map(key => key.trim()).filter(Boolean)
          setClientText({ text, keys }); onAllowedClientsTextChange?.(text); onChange({ ...configuration, allowedClients: keys })
        }} placeholder="nodekey:…" /></label>
    </div>
    <label className="host-tailcat-toggle"><Switch aria-label="Allow Tailcat connections" checked={configuration.enabled}
      onChange={event => onChange({ ...configuration, enabled: event.target.checked })} /><span><strong>Allow Tailcat connections</strong><small>Applies when you save incoming connections.</small></span></label>
    <p className="settings-group-note">{saveLabel} applies the access choice and allowed clients. The listener’s confirmed private address appears here when it is ready.</p>
    <div className="host-tailcat-status"><span role="status">{!saved ? `${saveLabel} to apply these changes.` : current?.error ?? (listener ? `Tailcat listener · ${listener.state}` : current?.busy ? 'Reading listener status…' : 'Tailcat listener status unknown')}</span>
      <button type="button" className="small-button" disabled={!saved || current?.busy === true} onClick={() => setRevision(value => value + 1)}>Refresh status</button></div>
    {saved && listener?.detail ? <p className="host-check-detail">{listener.detail}</p> : null}
    {saved && address ? <div className="host-tailcat-address">
      <label htmlFor={addressField}>Private Tailcat address</label>
      <InputGroup className="host-tailcat-address__field">
        <TextInput id={addressField} aria-label="Private Tailcat address" type="password" autoComplete="off" value={address} readOnly />
        <button type="button" className="small-button" aria-disabled={copy.state === 'copying' || undefined}
          onClick={() => { void copy.copy(address) }}><span role="status">{copy.state === 'copied' ? 'Copied' : 'Copy address'}</span></button>
      </InputGroup>
    </div> : null}
    {copy.state === 'failed' ? <p role="alert" className="host-check-detail">Address copy failed. Select the private field and copy it again.</p> : null}
  </div>
}
