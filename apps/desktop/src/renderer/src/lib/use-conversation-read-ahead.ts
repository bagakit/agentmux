import { useCallback, useEffect, useRef } from 'react'
import { CONVERSATION_MAX_WINDOW_RECORDS } from '@agentmux/core/conversation'

type Direction = 'earlier' | 'newer'
type Demand = { direction: Direction; remaining: number; waitingFor: object | null; force: boolean }

/** A finite presentation demand over the existing Reader, never another window. */
export function useConversationReadAhead(input: {
  identity: string
  active: boolean
  stopped: boolean
  loading: boolean
  frame: object | null
  nearEdge: (direction: Direction) => boolean
  read: (direction: Direction) => boolean
}) {
  const current = useRef(input)
  const demand = useRef<Demand | null>(null)
  if (current.current.identity !== input.identity || !input.active || input.stopped) demand.current = null
  current.current = input

  const advance = useCallback(() => {
    const next = demand.current, value = current.current
    if (!next || !value.active || value.stopped || value.loading || !value.frame) return
    // A render before the requested frame arrives cannot spend another page.
    if (next.waitingFor === value.frame) return
    if (!next.remaining || !next.force && !value.nearEdge(next.direction)) { demand.current = null; return }
    next.force = false
    next.remaining--
    next.waitingFor = value.frame
    if (!value.read(next.direction)) demand.current = null
  }, [])
  // Layout is feedback for this exact demand. It cannot create or replenish one.
  useEffect(advance)
  const cancel = useCallback(() => { demand.current = null }, [])
  const request = useCallback((direction: Direction, force = false) => {
    const value = current.current
    if (!value.active || value.stopped || !value.frame) return
    if (demand.current?.direction === direction) return
    // Geometry decides how much is readable. One demand can inspect at most a
    // Core-window worth of 100-record source pages, even if all of them fold flat.
    // The next physical reading action can continue; layout cannot renew this work.
    demand.current = { direction, remaining: Math.ceil(CONVERSATION_MAX_WINDOW_RECORDS / 100), waitingFor: null, force }
    advance()
  }, [advance])
  return { request, cancel }
}
