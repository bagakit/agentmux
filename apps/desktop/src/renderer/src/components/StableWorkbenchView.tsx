import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** One React/terminal tree; only its existing DOM host changes spatial parent. */
export function StableWorkbenchView({ homeId, targetId, children }: {
  homeId: string
  targetId: string | null
  children: ReactNode
}) {
  const [host] = useState(() => {
    const element = document.createElement('div')
    element.className = 'retained-workbench-view'
    return element
  })
  const parking = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const destinationId = targetId ?? homeId
    const attach = () => {
      const destination = document.getElementById(destinationId)
      if (!destination) return false
      if (host.parentElement !== destination) destination.append(host)
      return true
    }
    // Keep the already-mounted view in its last host while a Focus slot arrives.
    // Initial restoration has a private parking host, never a second view tree.
    if (!host.isConnected && parking.current) parking.current.append(host)
    if (attach()) return
    const observer = new MutationObserver(() => { if (attach()) observer.disconnect() })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [homeId, targetId, host])
  useLayoutEffect(() => () => host.remove(), [host])
  return <><div ref={parking} className="retained-workbench-parking" aria-hidden="true" inert />{createPortal(children, host)}</>
}
