import { ChevronDown, Folder, RadioTower, SquareTerminal, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import type { HostCheckState } from '../store'
import { hostCheckLabel } from '../lib/host-check'
import { resolveOverlayContainer } from './WindowOverlayHost'

/** The existing Host facts are read on demand; this surface does not check or change execution. */
export function LauncherEnvironment({ workspace, host, check, displayPath }: {
  workspace: WorkspaceRecord | undefined
  host: HostConfig | undefined
  check: HostCheckState | undefined
  displayPath: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const label = host?.label ?? workspace?.hostId ?? 'No host'
  const kind = host?.kind === 'local' ? 'Local host' : host?.kind === 'ssh' ? 'SSH host' : 'Host unconfirmed'
  const Icon = host?.kind === 'ssh' ? RadioTower : SquareTerminal
  useLayoutEffect(() => {
    const anchor = trigger.current
    if (!open || !anchor || !panel) return
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, panel, { placement: 'bottom-end', strategy: 'fixed',
        middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })] })
      if (!disposed) Object.assign(panel.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop() }
  }, [open, panel])

  return <header className="launcher-environment">
    <div className="launcher-environment__project"><Folder size={20} /><div>
      <h2 title={workspace?.name}>{workspace?.name ?? 'Choose a workspace'}</h2>
      <span className="launcher-environment__path" title={workspace?.path}>{displayPath || 'No working directory selected'}</span>
    </div></div>
    <Dialog.Root modal={false} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button type="button" className="launcher-environment__host" ref={trigger} aria-label="Runtime environment" title={`${kind} · ${label}`}>
        <Icon size={14} /><span>{label}</span><ChevronDown size={12} />
      </button></Dialog.Trigger>
      <Dialog.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
        <Dialog.Content ref={setPanel} className="launcher-environment__panel" style={{ visibility: 'hidden' }}>
          <header><div className="launcher-environment__identity"><Icon size={18} /><div><Dialog.Title>{label}</Dialog.Title><Dialog.Description>{kind}</Dialog.Description></div></div>
            <Dialog.Close className="icon-button" aria-label="Close runtime environment"><X size={14} /></Dialog.Close></header>
          <dl>
            <div><dt>Working directory</dt><dd className="launcher-environment__directory" title={workspace?.path}>{displayPath || 'Not selected'}</dd></div>
            {host?.kind === 'ssh' ? <div><dt>Address</dt><dd>{host.user ? `${host.user}@` : ''}{host.hostname}{host.port ? `:${host.port}` : ''}</dd></div> : null}
            <div><dt>Connection check</dt><dd data-state={check?.state ?? 'idle'}>{check ? hostCheckLabel(check) : 'Not tested'}{check?.detail ? <small>{check.detail}</small> : null}</dd></div>
            <div><dt>Execution</dt><dd>{host ? 'Configured host shell' : 'Host not configured'}</dd></div>
          </dl>
          <p className="launcher-environment__availability">Isolated environments are not supported yet.</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </header>
}
