import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentInformationPreview } from '../lib/agent-information-preview'

/**
 * A derived action for a Focus card without one confirmed Region opens over the Focus workspace
 * side, the way it opens over its own Region elsewhere: no dialog and no page scrim. The workspace
 * aside is preferred; when it is closed the action covers that same side of the Focus surface.
 */
export function FocusWorkspaceStage({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const focus = document.querySelector<HTMLElement>('.global-focus-surface')
    setHost(focus?.querySelector<HTMLElement>('.global-session-workspace') ?? focus ?? null)
  }, [])
  useLayoutEffect(() => host ? agentInformationPreview.suspendTransient(host.ownerDocument) : undefined, [host])
  return host ? createPortal(<div className="focus-workspace-stage" data-host={host.classList.contains('global-session-workspace') ? 'workspace' : 'focus'}>{children}</div>, host) : null
}
