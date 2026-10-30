import { useLayoutEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { MobileIdentity, type MobileObjectIdentity } from './MobileIdentity'

/** Only this welcome portrait measures its layout slot; the identity/motion owner remains unchanged. */
export function MobileMoteStartPortrait({ identity, client, visible }: {
  identity: MobileObjectIdentity; client: AgentMuxHostedClient | null; visible: boolean
}) {
  const slot = useRef<HTMLSpanElement>(null), [size, setSize] = useState(136)
  useLayoutEffect(() => {
    const node = slot.current
    if (!node) return
    const measure = () => {
      const next = Math.floor(Math.min(node.clientWidth, node.clientHeight))
      if (next > 0) setSize(previous => previous === next ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <span ref={slot} className="mobile-mote-start-portrait" style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
    <MobileIdentity key={size} identity={identity} client={client} connected={Boolean(client)} visible={visible} size={size} />
  </span>
}
