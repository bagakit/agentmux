import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import type { HostCheckState } from '../store'
import { hostCheckLabel } from '../lib/host-check'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { useHostConnectionHint } from './HostConnectionTooltip'
import { HostIcon } from './HostBadge'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'

const ThemeObjectFolderIcon = semanticIconComponent('object.folder')


/** The project and its device come from the Space entry; the start page only reads them. */
export function LauncherEnvironment({ workspace, host, check, displayPath, executionControl }: {
  workspace: WorkspaceRecord | undefined
  host: HostConfig | undefined
  check: HostCheckState | undefined
  displayPath: string
  executionControl?: ReactNode
}) {
  const identity = hostIdentityProjection(workspace?.hostId, host)
  const connection = useHostConnectionHint(identity.id, identity.label)
  const path = workspace?.path && workspace.path !== displayPath ? workspace.path : displayPath
  // The home affordance belongs to the Space device entry, not to this read-only label.
  const channel = connection.detail.split('\n').filter(line => !line.startsWith('~ opens')).join('\n')
  const detail = [path || 'No working directory selected', channel, check ? `Last check: ${hostCheckLabel(check)}${check.detail ? ` · ${check.detail}` : ''}` : '']
    .filter(Boolean).join('\n')
  const tooltip = useWorkbenchNameTooltip(connection.name, detail, false, { pointerPassThrough: true })
  const name = workspace?.name ?? 'Choose a workspace'
  return <header className="launcher-environment">
    <div className="launcher-environment__project">
      <div className="launcher-environment__title">
        <ThemeObjectFolderIcon size={20} /><h2 title={name}>{name}</h2>
        <span className="launcher-environment__device" tabIndex={0} data-host-id={identity.id ?? ''} data-host-kind={identity.kind}
          aria-label={`Device: ${identity.label}`} {...tooltip.props}>
          <HostIcon kind={identity.kind} size={12} /><span>{identity.label}</span>
        </span>
      </div>
      <span className="launcher-environment__path" title={displayPath || undefined}>{displayPath || 'No working directory selected'}</span>
    </div>
    {executionControl ? <div className="launcher-environment__execution">
      <span className="launcher-environment__execution-label">Agent device</span>
      {executionControl}
    </div> : null}
    {tooltip.content}
  </header>
}
