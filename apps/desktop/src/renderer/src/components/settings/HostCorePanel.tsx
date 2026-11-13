import { useState } from 'react'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { HostUpgradePanel } from './HostUpgradePanel'
import { HostInstallPanel } from './HostInstallPanel'

/** Installation and update share one maintenance workface; the probe decides which review applies. */
export function HostCorePanel(props: { host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean }) {
  const [firstInstall, setFirstInstall] = useState<SshHostConfig[]>([])
  const [updates, setUpdates] = useState<SshHostConfig>()
  const { label: _label, ...route } = props.host
  const installing = firstInstall.some(({ label: _name, ...input }) => configValuesEqual(input, route))
  const updating = updates && (() => { const { label: _name, ...input } = updates; return configValuesEqual(input, route) })()
  return <div>
    <div hidden={installing && !updating} inert={installing && !updating}><HostUpgradePanel {...props} active={props.active && (!installing || Boolean(updating))} /></div>
    <div hidden={Boolean(updating)} inert={Boolean(updating)}><HostInstallPanel {...props} active={props.active && !updating}
      onFirstInstall={setFirstInstall} onManageUpdates={() => setUpdates(structuredClone(props.host))} /></div>
  </div>
}
