import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SemanticIcon, type SemanticIconProps } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import { api } from '../../lib/api'

type Target = { hostId: string; route: string; runtimeId?: string | undefined }
type Sample = { runtimeId: string; published: boolean; checkedAt: number }
type Observation = { target: Target; current?: Sample; lastConfirmed?: Sample; error?: string }
type Reporter = { select(target: Target): void; confirmed(target: Target, sample: Sample): void; unknown(target: Target, message: string): void }
const Context = createContext<{ observation: Observation; reporter: Reporter; visible: boolean } | null>(null)

export function nodePublicationTarget(host: HostConfig, runtimeId = host.kind === 'ssh' ? host.runtimeId : undefined): Target {
  const { label: _label, ...route } = host
  return { hostId: host.id, route: JSON.stringify(route), ...(runtimeId ? { runtimeId } : {}) }
}
export function useNodePublicationReporter() { return useContext(Context)?.reporter }

/** A Settings-local display projection. No policy, persistence or business calls consume this state. */
export function NodePublicationObservation({ hosts, visible, section, children }: { hosts: HostConfig[]; visible: boolean; section: string; children: ReactNode }) {
  const initial = hosts.find(host => host.kind === 'local')
  const [observation, setObservation] = useState<Observation>(() => ({ target: initial ? nodePublicationTarget(initial) : { hostId: '', route: '' } }))
  const current = useRef(observation)
  const put = useCallback((next: Observation) => { current.current = next; setObservation(next) }, [])
  const select = useCallback((target: Target) => {
    const before = current.current
    const sameRoute = before.target.hostId === target.hostId && before.target.route === target.route
    const runtimeId = target.runtimeId ?? (sameRoute ? before.target.runtimeId : undefined)
    if (sameRoute && before.target.runtimeId === runtimeId) return
    put({ target: { ...target, ...(runtimeId ? { runtimeId } : {}) } })
  }, [put])
  const matches = (target: Target) => current.current.target.hostId === target.hostId && current.current.target.route === target.route &&
    (!target.runtimeId || !current.current.target.runtimeId || target.runtimeId === current.current.target.runtimeId)
  const confirmed = useCallback((target: Target, sample: Sample) => {
    if (!matches(target) || target.runtimeId && target.runtimeId !== sample.runtimeId || current.current.target.runtimeId && current.current.target.runtimeId !== sample.runtimeId) return
    put({ target: { ...current.current.target, runtimeId: sample.runtimeId }, current: sample, lastConfirmed: sample })
  }, [put])
  const unknown = useCallback((target: Target, message: string) => {
    if (!matches(target)) return
    const before = current.current
    put({ target: before.target, ...(before.lastConfirmed ? { lastConfirmed: before.lastConfirmed } : {}), error: message })
  }, [put])
  const reporter = useMemo(() => ({ select, confirmed, unknown }), [select, confirmed, unknown])
  useEffect(() => {
    const host = hosts.find(item => item.id === current.current.target.hostId)
    if (host && nodePublicationTarget(host).route !== current.current.target.route) select(nodePublicationTarget(host))
    else if (!host && current.current.target.hostId) unknown(current.current.target, 'The original saved Host is unavailable.')
  }, [hosts, select, unknown])
  const selectedHost = hosts.find(host => host.id === observation.target.hostId)
  const configuredRoute = selectedHost ? nodePublicationTarget(selectedHost).route : undefined
  const attempted = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!visible || section !== 'overview' || current.current.current || current.current.error) return
    const target = current.current.target, key = target.hostId + target.route
    if (!target.hostId || configuredRoute !== target.route || attempted.current === key) return
    attempted.current = key
    const controller = new AbortController(); let settled = false
    void api.nodePublishing.call('node.inspect', { hostId: target.hostId, ...(target.runtimeId ? { expectedRuntimeId: target.runtimeId } : {}) }, controller.signal).then(reply => {
      if (controller.signal.aborted) return
      settled = true
      confirmed(target, { runtimeId: reply.node.runtimeId, published: reply.resourcesShared || reply.roots.length > 0, checkedAt: Date.now() })
    }).catch(cause => { if (!controller.signal.aborted) { settled = true; unknown(target, cause instanceof Error ? cause.message : String(cause)) } })
    return () => { controller.abort(); if (!settled && attempted.current === key) attempted.current = undefined }
  }, [visible, section, observation.target.hostId, observation.target.route, configuredRoute, confirmed, unknown])
  const value = useMemo(() => ({ observation, reporter, visible }), [observation, reporter, visible])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The state has accessible text even when the surrounding catalogue hides decorative SVGs. */
export function NodePublicationIcon({ animation: _selection, 'aria-hidden': _decorative, ...props }: SemanticIconProps) {
  const context = useContext(Context), state = context?.observation
  const sample = state?.current
  const name = !state ? 'object.node' : !sample ? 'status.node-publication-unknown' : sample.published ? 'status.node-published' : 'status.node-private'
  const description = !state ? 'Node publication not observed' : sample
    ? `Node publication: ${sample.published ? 'Sharing published resources or folders' : 'Private; no resources or folders published'}. ${state.target.hostId}; Runtime ${sample.runtimeId}. Read ${new Date(sample.checkedAt).toLocaleString()}.`
    : `Node publication unknown. ${state.target.hostId}. ${state.error ?? 'Not observed yet.'}${state.lastConfirmed ? ` Last confirmed ${state.lastConfirmed.published ? 'published' : 'private'} on Runtime ${state.lastConfirmed.runtimeId} at ${new Date(state.lastConfirmed.checkedAt).toLocaleString()}.` : ''}`
  return <span className="settings-node-publication-icon" role="img" aria-label={description} title={description} data-node-publication={sample ? sample.published ? 'published' : 'private' : 'unknown'} data-node-publication-host={state?.target.hostId}>
    <SemanticIcon {...props} name={name} animation={sample?.published && context?.visible ? 'stream' : 'none'} aria-hidden="true" />
  </span>
}
