import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { moteExpression } from '../lib/mote-expression'
import { observeMoteMotion } from '../lib/mote-face-motion'
import type { MoteExpression } from './MoteFace'

export type MoteIdentityMotionProps = {
  moteSessionId?: string | undefined; moteHostId?: string | undefined
  moteAvailability?: 'static' | 'no-agent' | 'restoring' | undefined; visible?: boolean | undefined
}
type Props = MoteIdentityMotionProps & { children(expression: MoteExpression): ReactNode }

/** Static identity animation consumes no Session store; execution expression still has its original owner. */
export function MoteIdentityMotion(props: Props) {
  return !props.moteSessionId
    ? <MotionSurface expression={moteExpression(undefined, props.moteAvailability ?? 'static', undefined)} visible={props.visible}>{props.children}</MotionSurface>
    : <SessionMotion {...props} />
}
function SessionMotion({ moteSessionId, moteHostId, moteAvailability = 'static', visible, children }: Props) {
  const expression = useAppStore(state => {
    const candidate = moteSessionId ? sessionPresentationById(state.sessions).get(moteSessionId) : undefined
    const session = candidate?.kind === 'agent' && candidate.hostId === moteHostId ? candidate : undefined
    return moteExpression(session, moteSessionId && !session ? 'restoring' : moteAvailability,
      moteSessionId ? state.timelines[moteSessionId]?.liveTool : undefined)
  })
  return <MotionSurface expression={expression} visible={visible}>{children}</MotionSurface>
}
function MotionSurface({ expression, visible = true, children }: { expression: MoteExpression; visible?: boolean | undefined; children(expression: MoteExpression): ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const motion = useRef<ReturnType<typeof observeMoteMotion> | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const identity = observeMoteMotion(ref.current, expression, visible); motion.current = identity
    return () => { identity.dispose(); motion.current = null }
  }, [])
  useLayoutEffect(() => { motion.current?.update(expression, visible) }, [expression, visible, children])
  return <span ref={ref} className="mote-identity-motion space-object-icon" data-mote-expression={expression} data-mote-motion="off">{children(expression)}</span>
}
