import { useRef } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { TailcatKeyPreparation } from './TailcatKeyPreparation'
import { TailcatSetupFlow } from './TailcatSetupFlow'

export function HostTailcatClientFields({ host, onChange }: {
  host: SshHostConfig
  onChange: (tailcat: NonNullable<SshHostConfig['tailcat']>) => void
}) {
  const tailcat = host.tailcat ?? { address: '', keyFile: '' }
  const latest = useRef(tailcat); latest.current = tailcat
  return <div className="tailcat-setup-client" data-tailcat-client>
    <TailcatSetupFlow role="client" peerName={host.label} />
    <TailcatKeyPreparation host={host} role="client" keyFile={tailcat.keyFile} onPrepared={result => {
      if (!configValuesEqual(latest.current, tailcat)) return false
      onChange({ ...latest.current, keyFile: latest.current.keyFile || result.key })
      return true
    }} />
    <div className="host-edit-grid">
      <label className="host-edit-grid__wide"><span>Other Mac’s Tailcat address <small>private credential</small></span><TextInput type="password" autoComplete="off" spellCheck={false} aria-label="Tailcat address" value={tailcat.address}
        onChange={event => onChange({ ...tailcat, address: event.target.value })} placeholder="Paste its tc… address" /></label>
    </div>
    <details className="host-tailcat-advanced"><summary>Client key</summary><div className="host-edit-grid">
      <label className="host-edit-grid__wide"><span>Client key file or name</span><TextInput aria-label="Tailcat client key" value={tailcat.keyFile}
        onChange={event => onChange({ ...tailcat, keyFile: event.target.value })} placeholder="agentmux-client" /></label>
    </div></details>
  </div>
}
