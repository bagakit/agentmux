import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { mintObjectId } from '@agentmux/core/object-id'
import type { CapsuleRuntimeObservation, CapsuleRuntimeParamsMap } from '@agentmux/core'
import { api } from '../../lib/api'

type Attempt = { kind: 'start'; params: CapsuleRuntimeParamsMap['capsule.runtime.start']; phase: 'pending' | 'unknown' | 'confirmed' | 'failed'; message: string }
  | { kind: 'stop'; params: CapsuleRuntimeParamsMap['capsule.runtime.stop']; phase: 'pending' | 'unknown' | 'confirmed' | 'failed'; message: string }
const labels: Record<CapsuleRuntimeObservation['phase'], string> = { unconfigured: 'Not started', running: 'Running', starting: 'Starting', stopping: 'Stopping', stopped: 'Stopped', unknown: 'Unknown', unavailable: 'Unavailable' }
const rejected = new Set(['INVALID_CONTROL_REQUEST', 'CAPSULE_RUNTIME_REVISION_CONFLICT', 'CAPSULE_RUNTIME_RUN_CONFLICT', 'CAPSULE_RUNTIME_OPERATION_CONFLICT'])

/** App-only management consumer. Core retains the service intent, Run and original commands. */
export function CapsuleRuntimeSettings({ active, observed }: { active: boolean; observed(value: CapsuleRuntimeObservation): void }) {
  const [value, setValue] = useState<CapsuleRuntimeObservation | null>(null), [issue, setIssue] = useState('')
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const busy = useRef(false), mounted = useRef(true), consume = useRef(observed)
  consume.current = observed
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  function accept(next: CapsuleRuntimeObservation) { setValue(current => !current || next.revision >= current.revision ? next : current); consume.current(next); setIssue('') }
  function reconcile(original: Attempt, next: CapsuleRuntimeObservation) {
    const operation = next.operation
    if (operation?.operationId === original.params.operationId && operation.kind === original.kind && operation.phase === 'confirmed') {
      setAttempt({ ...original, phase: 'confirmed', message: original.kind === 'start' ? 'The original service Start is confirmed.' : 'The original service Stop is confirmed.' })
    } else if (operation?.operationId === original.params.operationId && operation.kind === original.kind && operation.phase === 'not_applied') {
      setAttempt({ ...original, phase: 'failed', message: operation.failure?.message ?? 'The original service command was not applied. A new explicit command can try again.' })
    } else setAttempt({ ...original, phase: 'unknown', message: 'The original service command is still unconfirmed. Check its identity without repeating it.' })
  }
  async function inspect() {
    if (busy.current) return
    busy.current = true
    const original = attempt
    try {
      const next = await api.capsuleRuntime.call('capsule.runtime.inspect', original?.phase === 'unknown' ? { operationId: original.params.operationId } : {})
      if (!mounted.current) return
      accept(next)
      if (original?.phase === 'unknown') reconcile(original, next)
    } catch (error) { if (mounted.current) setIssue(presentError(error)) }
    finally { busy.current = false }
  }
  useEffect(() => { if (active) void inspect() }, [active])
  async function submit(kind: 'start' | 'stop') {
    if (busy.current || !value || attempt?.phase === 'pending' || attempt?.phase === 'unknown') return
    const original: Attempt = kind === 'start'
      ? { kind, params: { operationId: mintObjectId(), expectedRevision: value.revision }, phase: 'pending', message: '' }
      : { kind, params: { operationId: mintObjectId(), expectedRevision: value.revision, expectedRun: value.run ? { runId: value.run.runId } : null }, phase: 'pending', message: '' }
    busy.current = true; setAttempt(original)
    try {
      const next = original.kind === 'start'
        ? await api.capsuleRuntime.call('capsule.runtime.start', original.params)
        : await api.capsuleRuntime.call('capsule.runtime.stop', original.params)
      if (!mounted.current) return
      accept(next); reconcile(original, next)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (mounted.current) setAttempt({ ...original, phase: typeof code === 'string' && rejected.has(code) ? 'failed' : 'unknown', message: presentError(error) })
    } finally { busy.current = false }
  }
  const locked = attempt?.phase === 'pending' || attempt?.phase === 'unknown'
  return <section className="settings-group" data-settings-field="capsule-service" aria-label="Capsule service">
    <header><span>Page service</span><small>Runs independently of the App and its management connection.</small></header>
    <div className="capsule-settings__actions"><span role="status">{value ? labels[value.phase] : issue ? 'Status unconfirmed' : 'Reading service status…'}</span>
      <button type="button" className="small-button" onClick={() => void inspect()}>{attempt?.phase === 'unknown' ? 'Check original service command' : 'Read service status'}</button>
      {value?.issue?.retry === 'start' && !value.run
        ? <button type="button" className="primary-button" disabled={locked} onClick={() => void submit('start')}>Try Start again</button>
        : value ? value.desired === 'running'
        ? <button type="button" className="small-button" disabled={locked} onClick={() => void submit('stop')}>Stop service</button>
        : <button type="button" className="primary-button" disabled={locked} onClick={() => void submit('start')}>Start service</button> : null}
      {value?.issue?.retry === 'stop' && value.run
        ? <button type="button" className="small-button" disabled={locked} onClick={() => void submit('stop')}>Try Stop again</button> : null}
    </div>
    {value ? <details><summary>Service identity</summary><dl>
      {value.runtime ? <><dt>Runtime</dt><dd><code>{value.runtime.runtimeId}</code></dd><dt>Instance</dt><dd><code>{value.runtime.ownerInstanceId}</code></dd></> : null}
      {value.run ? <><dt>Run</dt><dd><code>{value.run.runId}</code></dd></> : null}
      {value.operation?.firstFailure ? <><dt>Original failure</dt><dd>{value.operation.firstFailure.message}</dd></> : null}
      <dt>Service state</dt><dd>{value.stateDirectory}</dd><dt>Control socket</dt><dd>{value.socketPath}</dd>
    </dl></details> : null}
    {value?.desired === 'stopped' ? <p className="capsule-settings__hint">Pages, settings and drafts are retained. Start the service explicitly to serve them again.</p> : null}
    {value?.issue ? <p className="capsule-settings__issue" role="status">{value.issue.message} {value.issue.recovery}</p> : null}
    {issue ? <p className="capsule-settings__issue" role="alert">{issue}</p> : null}
    {attempt ? <div className="capsule-settings__receipt" role="status"><span>{attempt.phase === 'pending' ? 'Waiting for the original service command…' : attempt.message}</span><small>Operation <code>{attempt.params.operationId}</code></small></div> : null}
  </section>
}
