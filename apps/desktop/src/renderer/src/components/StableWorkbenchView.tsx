import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WorkbenchPresentationContext, type BrowserControlConfirmation } from '../lib/workbench-presentation'

/** One React/terminal tree; only its existing DOM host changes spatial parent. */
export function StableWorkbenchView({ homeId, targetId, active, retainedRegionId, homeNotice, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion, children }: {
  homeId: string
  targetId: string | null
  active: boolean
  retainedRegionId: string | null
  survey?: boolean | undefined
  controlsOpen?: boolean | undefined
  onBrowserControlConfirmation?: BrowserControlConfirmation | undefined
  onSelectRegion?: ((regionId: string) => void) | undefined
  /** The existing projection owner describes a borrowed View at its original slot. */
  homeNotice?: ReactNode
  children: ReactNode
}) {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'retained-workbench-view'
    return element
  })
  const presentation = useMemo(() => ({ active, retainedRegionId, tabHostId: targetId ?? homeId, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion }),
    [active, retainedRegionId, targetId, homeId, survey, controlsOpen, onBrowserControlConfirmation, onSelectRegion])
  const parking = useRef<HTMLDivElement>(null)
  const showHomeNotice = Boolean(homeNotice)
  const [noticeHome, setNoticeHome] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const destinationId = targetId ?? homeId
    const attach = () => {
      const destination = document.getElementById(destinationId)
      if (!destination) return false
      if (host.parentElement !== destination) destination.append(host)
      // Confirm the actual placement before describing it. Pending targets retain
      // the original View; a destination hint alone does not prove it moved.
      setNoticeHome(showHomeNotice && targetId !== null ? document.getElementById(homeId) : null)
      return true
    }
    // Keep the already-mounted view in its last host while a Focus slot arrives.
    // Initial restoration has a private parking host, never a second view tree.
    if (!host.isConnected && parking.current) parking.current.append(host)
    if (attach()) return
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }) // The original layout can replace a slot without changing its exact address.
  useLayoutEffect(() => () => host.remove(), [host])
  return <WorkbenchPresentationContext.Provider value={presentation}>
    <div ref={parking} className="retained-workbench-parking" aria-hidden="true" inert />{createPortal(children, host)}
    {targetId !== null && noticeHome && homeNotice ? createPortal(homeNotice, noticeHome) : null}
  </WorkbenchPresentationContext.Provider>
}
