import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import type { HostCheckState } from '../store'
import { hostCheckLabel } from '../lib/host-check'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { LauncherExecutionPicker } from './LauncherExecutionPicker'

const ThemeObjectBroadcastIcon = semanticIconComponent('object.broadcast')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectFolderIcon = semanticIconComponent('object.folder')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


/** Select a future execution resource without checking or changing any existing Run. */
export function LauncherEnvironment({ workspace, host, check, displayPath, active, contextName, hosts, workspaces, onSelectWorkspace, selectionDisabled = false, onManageProjects }: {
  workspace: WorkspaceRecord | undefined
  host: HostConfig | undefined
  check: HostCheckState | undefined
  displayPath: string
  active: boolean
  contextName?: string | undefined
  hosts: readonly HostConfig[]
  workspaces: readonly WorkspaceRecord[]
  onSelectWorkspace(workspaceId: string): void
  selectionDisabled?: boolean
  onManageProjects(): void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const label = host?.label ?? workspace?.hostId ?? 'No host'
  const name = contextName ?? workspace?.name ?? 'Choose a workspace'
  const kind = host?.kind === 'local' ? 'Local host' : host?.kind === 'ssh' ? 'SSH host' : 'Host unconfirmed'
  const Icon = host?.kind === 'ssh' ? ThemeObjectBroadcastIcon : ThemeObjectTerminalIcon
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useLayoutEffect(() => {
    const anchor = trigger.current
    if (!active || !open || !anchor || !panel) return
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, panel, { placement: 'bottom-end', strategy: 'fixed',
        middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })] })
      if (!disposed) Object.assign(panel.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop() }
  }, [active, open, panel])

  return <header className="launcher-environment">
    <div className="launcher-environment__project"><ThemeObjectFolderIcon size={20} /><div>
      <h2 title={name}>{name}</h2>
      <span className="launcher-environment__path" title={displayPath || undefined}>{displayPath || 'No working directory selected'}</span>
    </div></div>
    <Dialog.Root modal={false} open={open && active} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button type="button" className="launcher-environment__host" ref={trigger} disabled={!active} aria-label="Runtime environment" title={`${kind} · ${label}`}>
        <Icon size={14} /><span>{label}</span><ThemeNavigationDownIcon size={12} />
      </button></Dialog.Trigger>
      {active ? <Dialog.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <Dialog.Content ref={setPanel} className="launcher-environment__panel" inert={!open} style={{ visibility: 'hidden' }}
          onEscapeKeyDown={() => trigger.current?.focus()} onCloseAutoFocus={event => event.preventDefault()}>
          <header><div className="launcher-environment__identity"><Icon size={18} /><div><Dialog.Title>Choose where to start</Dialog.Title><Dialog.Description>Current target · {label} · {kind}</Dialog.Description></div></div>
            <Dialog.Close className="icon-button" aria-label="Close runtime environment" onClick={() => trigger.current?.focus()}><ThemeActionCloseIcon size={14} /></Dialog.Close></header>
          {open ? <LauncherExecutionPicker hosts={hosts} workspaces={workspaces} selected={workspace} disabled={selectionDisabled}
            onSelect={workspaceId => { onSelectWorkspace(workspaceId); setOpen(false); trigger.current?.focus() }}
            onManageProjects={() => { setOpen(false); onManageProjects() }} /> : null}
          <details className="launcher-environment__details"><summary>Environment details</summary><dl>
            <div><dt>Working directory</dt><dd className="launcher-environment__directory" title={displayPath || undefined}>{displayPath || 'Not selected'}</dd></div>
            {workspace?.path && workspace.path !== displayPath ? <div><dt>Full path</dt><dd className="launcher-environment__directory">{workspace.path}</dd></div> : null}
            {host?.kind === 'ssh' ? <div><dt>Address</dt><dd>{host.user ? `${host.user}@` : ''}{host.hostname}{host.port ? `:${host.port}` : ''}</dd></div> : null}
            <div><dt>Connection check</dt><dd data-state={check?.state ?? 'idle'}>{check ? hostCheckLabel(check) : 'Not tested'}{check?.detail ? <small>{check.detail}</small> : null}</dd></div>
            <div><dt>Execution</dt><dd>{host ? 'Configured host shell' : 'Host not configured'}</dd></div>
          </dl></details>
        </Dialog.Content>
      </Dialog.Portal> : null}
    </Dialog.Root>
  </header>
}
