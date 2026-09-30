import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { moteExpression } from '../lib/mote-expression'
import type { MoteExpression } from './MoteFace'

export type MoteIdentityMotionProps = {
  moteSessionId?: string | undefined; moteHostId?: string | undefined
  moteAvailability?: 'static' | 'no-agent' | 'restoring' | undefined; visible?: boolean | undefined
}

/** No animation clock in JavaScript. These event/visibility gates only control native CSS animations. */
export function MoteIdentityMotion({ moteSessionId, moteHostId, moteAvailability = 'static', visible = true, children }: MoteIdentityMotionProps & {
  children(expression: MoteExpression): ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  // Select one primitive expression. History/updatedAt changes cannot re-render this identity.
  const expression = useAppStore(state => {
    const candidate = moteSessionId ? sessionPresentationById(state.sessions).get(moteSessionId) : undefined
    const session = candidate?.kind === 'agent' && candidate.hostId === moteHostId ? candidate : undefined
    return moteExpression(session, moteSessionId && !session ? 'restoring' : moteAvailability,
      moteSessionId ? state.timelines[moteSessionId]?.liveTool : undefined)
  })
  const [inView, setInView] = useState(false), [pageVisible, setPageVisible] = useState(!document.hidden), [reduced, setReduced] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element || !visible) { setInView(false); return }
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(one => one.target === element)
      if (entry) setInView(entry.isIntersecting && entry.intersectionRatio > 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => setReduced(preference.matches), visibility = () => setPageVisible(!document.hidden)
    motion(); visibility(); preference.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility)
    return () => { preference.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  const active = visible && inView && pageVisible && !reduced && ['sleep', 'idle', 'thinking', 'tool', 'starting'].includes(expression)
  return <span ref={ref} className="mote-identity-motion space-object-icon" data-mote-expression={expression} data-mote-motion={active ? 'on' : 'off'}>{children(expression)}</span>
}
