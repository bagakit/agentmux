import { useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { MoteIcon } from '../../../../packages/client-ui/src/components/MoteIcon.js'
import { observeMoteMotion } from '../../../../packages/client-ui/src/lib/mote-face-motion.js'

type MotePreviewOptions = { size?: number; interactive?: boolean }

function MotePreview({ size = 88, interactive = true }: MotePreviewOptions) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!interactive || !ref.current) return
    const motion = observeMoteMotion(ref.current, 'identity', true)
    return () => motion.dispose()
  }, [interactive])
  return <span ref={ref} className="mote-identity-motion" data-mote-expression="identity">
    <MoteIcon size={size} interactive={interactive} data-mote-icon-source="automatic" />
  </span>
}

/** A single selected demo uses the product rig and its visibility/input owner. */
export function mountMotePreview(element: HTMLElement, options: MotePreviewOptions = {}) {
  const root = createRoot(element)
  root.render(<MotePreview {...options} />)
  return { dispose: () => root.unmount() }
}
