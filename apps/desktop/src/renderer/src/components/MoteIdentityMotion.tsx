import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { moteExpression } from '../lib/mote-expression'
import { observeMoteMotion } from '../lib/mote-face-motion'
import type { MoteExpression } from './MoteFace'

export type MoteIdentityMotionProps = {
  moteSessionId?: string | undefined; moteHostId?: string | undefined
  moteAvailability?: 'static' | 'no-agent' | 'restoring' | undefined; visible?: boolean | undefined
  motionKey?: string | undefined
  className?: string | undefined
}
type Props = MoteIdentityMotionProps & { children(expression: MoteExpression): ReactNode }

/** Static identity animation consumes no Session store; execution expression still has its original owner. */
export function MoteIdentityMotion(props: Props) {
  return !props.moteSessionId
    ? <MotionSurface expression={moteExpression(undefined, props.moteAvailability ?? 'static', undefined)} visible={props.visible} motionKey={props.motionKey} className={props.className}>{props.children}</MotionSurface>
    : <SessionMotion {...props} />
}
function SessionMotion({ moteSessionId, moteHostId, moteAvailability = 'static', visible, motionKey, className, children }: Props) {
  const expression = useAppStore(state => {
    const candidate = moteSessionId ? sessionPresentationById(state.sessions).get(moteSessionId) : undefined
    const session = candidate?.kind === 'agent' && candidate.hostId === moteHostId ? candidate : undefined
    return moteExpression(session, moteSessionId && !session ? 'restoring' : moteAvailability,
      moteSessionId ? state.timelines[moteSessionId]?.liveTool : undefined)
  })
  return <MotionSurface expression={expression} visible={visible} motionKey={motionKey} className={className}>{children}</MotionSurface>
}
function MotionSurface({ expression, visible = true, motionKey, className, children }: { expression: MoteExpression; visible?: boolean | undefined; motionKey?: string | undefined; className?: string | undefined; children(expression: MoteExpression): ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const motion = useRef<ReturnType<typeof observeMoteMotion> | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const identity = observeMoteMotion(ref.current, expression, visible); motion.current = identity
    return () => { identity.dispose(); motion.current = null }
  }, [])
  useLayoutEffect(() => { motion.current?.update(expression, visible) }, [expression, visible, children])
  // Same durable identity, same phase across surfaces; no timer or saved animation state.
  let phase = motionKey ? 2166136261 : 0
  for (const character of motionKey ?? '') phase = Math.imul(phase ^ character.charCodeAt(0), 16777619) >>> 0
  return <span ref={ref} className={'mote-identity-motion space-object-icon' + (className ? ' ' + className : '')} style={{ '--mote-ambient-delay': `${-(phase % 14000)}ms` } as CSSProperties} data-mote-expression={expression} data-mote-motion="off">{children(expression)}</span>
}
