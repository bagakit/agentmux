import { useRef, useState } from 'react'
import type { SshHostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { HostUpgradePanel, useHostUpgrade } from './HostUpgradePanel'
import { HostInstallPanel, HostInstallRecords, useHostInstall } from './HostInstallPanel'

function matches(a: SshHostConfig, b: SshHostConfig) {
  const { label: _a, ...left } = a, { label: _b, ...right } = b
  return configValuesEqual(left, right)
}

/** One maintenance surface; the original owners decide update versus first install. */
export function HostCorePanel(props: { host: SshHostConfig; committed: SshHostConfig | undefined; active: boolean }) {
  const [updates, setUpdates] = useState<SshHostConfig>()
  const current = useRef(props); current.current = props
  const checking = useRef(false)
  const installation = useHostInstall({ ...props, onManageUpdates: () => setUpdates(structuredClone(props.host)) })
  const installing = Boolean(installation.operation || !installation.state?.error && installation.check?.eligible)
  const updating = updates && matches(updates, props.host)
  const showInstall = installing && !updating
  const installationDetail = installation.state?.error ?? installation.check?.detail
  const upgrade = useHostUpgrade({ ...props, active: props.active && !showInstall, installationDetail })
  async function checkCore() {
    if (checking.current) return
    checking.current = true
    const input = props.host
    try {
      const result = await upgrade.inspectVersions()
      // Only the original first-install owner can prove absence. A missing
      // version observation or an unresolved upgrade cannot authorize installation.
      const now = current.current
      if (!result || result.current.state === 'available' || input.runtimeId || upgrade.unresolved ||
        result.latestOperation?.status === 'unknown' || result.latestOperation?.status === 'running' ||
        !now.active || !now.committed || !matches(input, now.host) || !matches(input, now.committed)) return
      await installation.checkMachine()
    } finally { checking.current = false }
  }
  return <div className="host-core">
    {showInstall ? <HostInstallPanel maintenance={installation} />
      : <HostUpgradePanel maintenance={upgrade} onCheck={checkCore} installationDetail={installationDetail} checkingInstallation={installation.busy} />}
    {!showInstall ? <HostInstallRecords maintenance={installation} /> : null}
  </div>
}
