import type { NodeOwnerTarget } from '../../../../shared/node-publishing'
import type { NodeResources } from '@agentmux/core/node-publishing'
import { appendNodeSample, type NodeSampleFrame } from './node-resource-view'
import { HostNodeResources } from './HostNodeResources'
import { useEffect, useState } from 'react'
import type { HostRuntimeObservation, HostRuntimeSource } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { api } from '../../lib/api'
import './host-runtime-panel.css'

const RefreshIcon = semanticIconComponent('action.refresh')
const InfoIcon = semanticIconComponent('status.info')
const NATIVE_CAPABILITIES = [['orderedOutputBytes', 'Ordered output'], ['boundedReplay', 'Bounded replay'], ['recoverableInput', 'Recoverable input'], ['resize', 'Resize'], ['interrupt', 'Interrupt'], ['completeStop', 'Complete stop']] as const
type State = { target: string; nodeReply?: NodeResources; nodeError?: string | undefined; frames?: NodeSampleFrame[]; current?: HostRuntimeObservation; confirmed?: HostRuntimeObservation; error?: string | undefined; busy?: boolean | undefined }
function route({ label: _label, ...host }: HostConfig) { return host }
function keep<T>(current: HostRuntimeSource<T>, previous?: HostRuntimeSource<T>): HostRuntimeSource<T> {
  return current.state === 'available' || previous?.state !== 'available' ? current : previous
}
function confirmed(current: HostRuntimeObservation, previous?: HostRuntimeObservation): HostRuntimeObservation {
  if (current.owner.state === 'available' && previous?.owner.state === 'available' &&
      (current.owner.value.runtimeId !== previous.owner.value.runtimeId || current.owner.value.ownerInstanceId !== previous.owner.value.ownerInstanceId) ||
      current.nativeIdentity.state === 'available' && previous?.nativeIdentity.state === 'available' && current.nativeIdentity.value.instanceId !== previous.nativeIdentity.value.instanceId ||
      current.diagnostics.state === 'available' &&
      (previous?.diagnostics.state === 'available' && current.diagnostics.value.ctxmux.serving.instanceId !== previous.diagnostics.value.ctxmux.serving.instanceId ||
       previous?.nativeIdentity.state === 'available' && current.diagnostics.value.ctxmux.serving.instanceId !== previous.nativeIdentity.value.instanceId)) previous = undefined
  return { ...current, owner: keep(current.owner, previous?.owner), nativeIdentity: keep(current.nativeIdentity, previous?.nativeIdentity),
    diagnostics: keep(current.diagnostics, previous?.diagnostics), resources: keep(current.resources, previous?.resources) }
}
function value<T>(source: HostRuntimeSource<T> | undefined): T | undefined { return source?.state === 'available' ? source.value : undefined }
function time(at: number): string { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
function bytes(amount: number): string {
  const unit = amount >= 1024 * 1024 * 1024 ? 'GiB' : amount >= 1024 * 1024 ? 'MiB' : amount >= 1024 ? 'KiB' : 'B'
  const divisor = unit === 'GiB' ? 1024 ** 3 : unit === 'MiB' ? 1024 ** 2 : unit === 'KiB' ? 1024 : 1
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount / divisor)} ${unit}`
}
function SourceIssue({ source, retained }: { source: HostRuntimeSource<unknown> | undefined; retained: HostRuntimeSource<unknown> | undefined }) {
  return source?.state === 'unavailable' ? <p className="host-runtime__issue" data-diagnostics><InfoIcon size={12} />
    <span>{source.message}{retained?.state === 'available' ? ` Last confirmed ${time(retained.readAt)}.` : ''}</span></p> : null
}
/** A single visible consumer of one saved route; it owns no Runtime or shared sampling clock. */
export function HostRuntimePanel({ host, committed, active, ownerTarget }: { host: HostConfig; committed?: HostConfig | undefined; active: boolean; ownerTarget?: NodeOwnerTarget | undefined }) {
  const target = JSON.stringify([host, ownerTarget])
  const committedTarget = JSON.stringify(committed)
  const saved = committed !== undefined && configValuesEqual(route(host), route(committed))
  const [state, setState] = useState<State>({ target })
  const [revision, setRevision] = useState(0)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed) }, [])
  useEffect(() => {
    if (!active || !saved || !visible) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, localRuntimeId: string | undefined
    const observe = async () => {
      setState(previous => ({ ...(previous.target === target ? previous : { target }), busy: true, error: undefined }))
      try {
        const runtime = api.hosts.inspect(committed!, { signal: controller.signal })
        const node = ownerTarget ? api.nodePublishing.owner(ownerTarget, 'settings.node.resources', {}, controller.signal)
          : host.kind === 'ssh' ? api.nodePublishing.call('node.resources', { hostId: host.id, ...(host.runtimeId ? { expectedRuntimeId: host.runtimeId } : {}) }, controller.signal)
          : (async () => {
            if (!localRuntimeId) {
              const original = await api.nodePublishing.call('node.inspect', { hostId: host.id }, controller.signal)
              localRuntimeId = original.node.runtimeId
            }
            return api.nodePublishing.owner({ hostId: host.id, expectedRuntimeId: localRuntimeId }, 'settings.node.resources', {}, controller.signal)
          })()
        const [runtimeRead, nodeRead] = await Promise.allSettled([runtime, node])
        if (controller.signal.aborted) return
        setState(previous => {
          const next: State = { ...(previous.target === target ? previous : { target }), busy: false }
          if (runtimeRead.status === 'fulfilled') {
            const observation = runtimeRead.value
            if (observation.routeHostId === host.id && configValuesEqual(observation.configuration, committed)) {
              next.current = observation; next.confirmed = confirmed(observation, next.confirmed); next.error = undefined
            } else next.error = 'The observation belongs to another Host. Refresh this connection.'
          } else next.error = runtimeRead.reason instanceof Error ? runtimeRead.reason.message : String(runtimeRead.reason)
          if (nodeRead.status === 'fulfilled') {
            const reply = nodeRead.value
            if ((ownerTarget?.expectedRuntimeId ?? (host.kind === 'ssh' ? host.runtimeId : localRuntimeId)) && reply.node.runtimeId !== (ownerTarget?.expectedRuntimeId ?? (host.kind === 'ssh' ? host.runtimeId : localRuntimeId))) next.nodeError = 'Resource identity differs from this saved Runtime. The original connection is kept.'
            else {
              next.nodeReply = reply; next.nodeError = undefined
              if (reply.status === 'withheld') next.frames = []
              else if (reply.status === 'available') next.frames = appendNodeSample(next.frames ?? [], reply.sample)
              else next.frames = [...(next.frames ?? []), { at: Date.now(), sample: null }].slice(-120)
            }
          } else { next.nodeError = nodeRead.reason instanceof Error ? nodeRead.reason.message : String(nodeRead.reason); next.frames = [...(next.frames ?? []), { at: Date.now(), sample: null }].slice(-120) }
          return next
        })
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => void observe(), 5000) }
    }
    void observe()
    return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [target, committedTarget, host.id, active, saved, visible, revision])
  const current = state.target === target ? state.current : undefined
  const retained = state.target === target ? state.confirmed : undefined
  const owner = value(retained?.owner), native = value(retained?.nativeIdentity), diagnostic = value(retained?.diagnostics), resources = value(retained?.resources)
  const busy = active && visible && saved && state.target === target && state.busy === true
  const failed = state.target === target ? state.error : undefined
  const partial = current && [current.owner, current.nativeIdentity, current.diagnostics, current.resources].some(source => source.state === 'unavailable')
  const diagnosticEvidence = diagnostic ? !busy && !failed && current?.diagnostics.state === 'available' ? 'current' : 'retained' : 'unconfirmed'
  return <section className="host-runtime" aria-label="Runtime observation" data-host-runtime={host.id}>
    <header className="host-runtime__header"><div><strong>Service status <span className="host-runtime__target">{host.label}</span></strong><span>{!saved ? 'Save this connection to read its service status.' :
      !current ? busy ? 'Reading this environment…' : 'No confirmed observation yet' :
      `${partial || failed ? 'Some observations unavailable' : 'Observed'} · ${time(current.completedAt)}`}</span></div>
      <button type="button" className="small-button" disabled={!saved || !active || busy || !visible} onClick={() => setRevision(previous => previous + 1)} aria-label="Refresh Runtime observation"><RefreshIcon size={13} />{busy ? 'Reading…' : 'Refresh'}</button>
    </header>
    {failed ? <p className="host-runtime__issue" role="status" data-diagnostics><InfoIcon size={13} /><span>{failed} {retained ? 'Last confirmed values are kept below.' : 'Refresh to read this original connection again.'}</span></p> : null}
    {saved ? <>
      <HostNodeResources reply={state.target === target ? state.nodeReply : undefined} frames={state.target === target ? state.frames ?? [] : []} error={state.target === target ? state.nodeError : undefined} busy={busy} active={active && visible} privateOwner={Boolean(ownerTarget) || host.kind === 'local'} />
      <div className="host-runtime__resources" aria-label="Retained Runtime resources">
        <div><span>Running Runs</span><strong>{resources?.runningRuns ?? '—'}</strong><small>{resources ? `${resources.runCount} retained in total` : 'Not observed'}</small></div>
        <div><span>Attachments</span><strong>{resources?.attachments ?? '—'}</strong><small>Service readers</small></div>
        <div><span>Retained output</span><strong>{resources ? bytes(resources.retainedOutputBytes) : '—'}</strong><small>In-memory payload</small></div>
      </div>
      <SourceIssue source={current?.resources} retained={retained?.resources} />
      {resources ? <p className="host-runtime__sample">Resource sample {time(resources.observedAt)} · {resources.terminatedRuns} ended Runs · {resources.terminatedUnattachedRuns} ended without readers</p> : null}
      <div className="host-runtime__environment"><span>Agent service</span><strong>{owner ? owner.availability === 'connected' ? 'Identity confirmed' : 'Connection not verified' : 'Identity not verified'}</strong>
        <span>{diagnostic ? `${diagnostic.platform} · ${diagnostic.arch} · Node ${diagnostic.nodeVersion}` : 'Platform not observed'}</span></div>
      <SourceIssue source={current?.owner} retained={retained?.owner} /><SourceIssue source={current?.diagnostics} retained={retained?.diagnostics} />
      <details className="host-runtime__details" data-diagnostics><summary>Service identities &amp; capabilities</summary>
        <dl>
          <div><dt>Host route</dt><dd><code>{host.id}</code></dd></div>
          {host.kind === 'ssh' ? <div><dt>Runtime binding</dt><dd><code>{host.runtimeId ?? 'Not confirmed'}</code></dd></div> : null}
          <div><dt>Semantic Runtime</dt><dd><code>{owner?.runtimeId ?? 'Unconfirmed'}</code></dd></div>
          <div><dt>Core instance</dt><dd><code>{owner?.ownerInstanceId ?? 'Unconfirmed'}</code></dd></div>
          <div><dt>Core process / protocol</dt><dd>{owner ? `${owner.processId} / ${owner.protocolVersion}` : 'Unconfirmed'}</dd></div>
          <div><dt>Native instance</dt><dd><code>{native?.instanceId ?? 'Unconfirmed'}</code></dd></div>
          <div><dt>Native build / protocol</dt><dd>{native ? `${native.buildIdentity} / ${native.protocolVersion}` : 'Unconfirmed'}</dd></div>
          <div><dt>Native process</dt><dd>{native?.processId ?? 'Not provided by Runtime'}</dd></div>
          <div><dt>Bundled Native</dt><dd>{diagnostic ? `${diagnostic.ctxmux.bundled.version} · ${diagnostic.ctxmux.bundled.artifactPlatform}` : 'Not observed'}</dd></div>
        </dl>
        <section className="host-runtime__capabilities" aria-label="Native capability declarations" data-diagnostic-evidence={diagnosticEvidence}>
          <header><strong>Native capabilities</strong><span>Source · Native diagnostics</span></header>
          <p className="host-runtime__sample">{retained?.diagnostics.state === 'available' ? <>
            {diagnosticEvidence === 'current' ? 'Current observation' : 'Last confirmed'} · read <time dateTime={new Date(retained.diagnostics.readAt).toISOString()}>{time(retained.diagnostics.readAt)}</time>
          </> : 'Capabilities not observed'}</p>
          <ul>{NATIVE_CAPABILITIES.map(([capability, label]) => {
            const declared = diagnostic?.ctxmux.capabilities[capability] === true
            return <li key={capability} data-native-capability={capability}><span>{label}</span><strong data-declaration={declared ? 'confirmed' : 'unconfirmed'}>
              {declared ? diagnosticEvidence === 'retained' ? 'Last confirmed' : 'Declared' : 'Unconfirmed'}
            </strong></li>
          })}</ul>
          <p className="host-runtime__sample">Runtime declarations. Access to an individual Run is checked separately.</p>
        </section>
        {current ? <p className="host-runtime__sample">This read {time(current.requestedAt)}–{time(current.completedAt)}. Resource sample time comes from the original Runtime; other times describe this service’s read.</p> : null}
        <SourceIssue source={current?.nativeIdentity} retained={retained?.nativeIdentity} />
      </details>
    </> : null}
  </section>
}
