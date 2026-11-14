import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js'

type Target = { ownerKey: string; sourceKey: string; generation: number }
type Lease = Target & { publisher: object }
type Source = { lease: Lease; props: AgentComposerProps }
export type ComposerConnection = {
  claim(ownerKey: string, sourceKey: string, publisher: object): Lease | null
  publish(lease: Lease, props: AgentComposerProps): void
  release(lease: Lease): void
}
const DispatchContext = createContext<ComposerConnection | null>(null)
/** A retained React owner may receive its exact presentation Host through its existing portal bridge. */
export function useComposerConnection(): ComposerConnection | null { return useContext(DispatchContext) }
const SurfaceContext = createContext<{ ownerKey: string; props: AgentComposerProps; active: boolean } | null>(null)

/** One presentation slot. Draft storage, target qualification and delivery stay with its callers. */
export function ComposerHost({ ownerKey, sourceKey, value, onChange, active, unbound, children }: {
  ownerKey: string; sourceKey: string; value: string; onChange(value: string): void; active: boolean
  unbound: Omit<AgentComposerProps, 'value' | 'onChange'>; children: ReactNode
}) {
  const target = useRef<Target>({ ownerKey, sourceKey, generation: 0 })
  if (target.current.ownerKey !== ownerKey || target.current.sourceKey !== sourceKey)
    target.current = { ownerKey, sourceKey, generation: target.current.generation + 1 }
  const current = useRef<Lease | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  // Sources never subscribe to draft values or to another Source's publications.
  const dispatcher = useMemo<ComposerConnection>(() => ({
    claim(owner, key, publisher) {
      const expected = target.current
      if (owner !== expected.ownerKey || key !== expected.sourceKey) return null
      if (current.current?.generation === expected.generation && current.current.publisher !== publisher) return null
      const lease = { ...expected, publisher }; current.current = lease
      return lease
    },
    publish(lease, props) {
      if (current.current !== lease || lease.generation !== target.current.generation) return
      setSource(previous => current.current === lease && lease.generation === target.current.generation ? { lease, props } : previous)
    },
    release(lease) {
      if (current.current !== lease) return
      current.current = null
      setSource(previous => previous?.lease === lease ? null : previous)
    }
  }), [])
  const selected = source?.lease === current.current && source.lease.generation === target.current.generation ? source.props : unbound
  return <DispatchContext.Provider value={dispatcher}>
    <SurfaceContext.Provider value={{ ownerKey, props: { ...selected, value, onChange }, active }}>{children}</SurfaceContext.Provider>
  </DispatchContext.Provider>
}

/** Publishes only the explicitly selected source; mounting or updating this node performs no input action. */
export function ComposerSource({ ownerKey, sourceKey, enabled = true, connection, ...props }: AgentComposerProps & {
  ownerKey: string; sourceKey: string; enabled?: boolean; connection?: ComposerConnection | null | undefined
}) {
  const inherited = useContext(DispatchContext), dispatcher = connection ?? inherited, publisher = useRef({}), lease = useRef<Lease | null>(null)
  useLayoutEffect(() => {
    if (!dispatcher || !enabled || props.active === false) return
    const original = dispatcher.claim(ownerKey, sourceKey, publisher.current); lease.current = original
    return () => { if (original) dispatcher.release(original); if (lease.current === original) lease.current = null }
  }, [dispatcher, ownerKey, sourceKey, enabled, props.active])
  useLayoutEffect(() => { if (dispatcher && lease.current) dispatcher.publish(lease.current, props) })
  return null
}

/** Its AgentComposer and editor have one stable position throughout every body/source transition. */
export function ComposerSurface({ className }: { className?: string }) {
  const surface = useContext(SurfaceContext)
  if (!surface) throw new Error('ComposerSurface requires its original ComposerHost.')
  return <div className={className} hidden={!surface.active} inert={!surface.active}>
    <AgentComposer key={surface.ownerKey} {...surface.props} active={surface.active} />
  </div>
}
