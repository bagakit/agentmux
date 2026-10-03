import type { AgentMuxRunStorageObservation } from '@agentmux/core'
import { Database, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SessionControl } from '../../../shared/contracts'
import { api } from '../lib/api'

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const power = value === 0 ? 0 : Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 1024 ** power)} ${units[power]}`
}
function offset(value: number): string { return `${value.toLocaleString()} B` }

/** A bounded, explicit read of this original control. Storage observation never changes input or Run ownership. */
export function TerminalStorageDetails({ control, scope, visible = true, continuationReason }: {
  control: SessionControl
  scope: string
  visible?: boolean
  continuationReason?: string | undefined
}) {
  const target = JSON.stringify([scope, control])
  const current = useRef({ target, visible })
  current.current = { target, visible }
  const mounted = useRef(true), sequence = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [pending, setPending] = useState<string | null>(null)
  const [sample, setSample] = useState<{ target: string; value: AgentMuxRunStorageObservation } | null>(null)
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null)
  const observation = sample?.target === target ? sample.value : null
  const error = failure?.target === target ? failure.message : null
  const checking = pending === target
  async function checkStorage() {
    if (!visible || checking) return
    const request = ++sequence.current, original = structuredClone(control)
    setPending(target); setFailure(null)
    try {
      const value = await api.sessions.observeStorage(original)
      if (!mounted.current || current.current.target !== target || !current.current.visible || sequence.current !== request) return
      if (value.run.runId !== original.run.runId || value.runtime.hostId !== original.hostId) {
        throw new Error('Storage observation returned another Host or Run. The original terminal is kept.')
      }
      setSample({ target, value })
    } catch (cause) {
      if (mounted.current && current.current.target === target && current.current.visible && sequence.current === request) {
        setFailure({ target, message: presentError(cause) })
      }
    } finally {
      // Finishing a hidden read must release only its own button; its late facts remain unapplied.
      if (mounted.current && sequence.current === request) setPending(previous => previous === target ? null : previous)
    }
  }
  const storage = observation?.status === 'observed' ? observation.storage : null
  const persistence = storage?.persistence
  const lag = persistence ? Math.max(0, persistence.offeredByte - persistence.confirmedByte) : null
  return <section className="terminal-storage-details" aria-label="Terminal storage facts">
    <header><strong><Database size={13} />Storage</strong><button type="button" className="small-button"
      disabled={checking || !visible} onPointerDown={event => event.preventDefault()} onClick={() => void checkStorage()}>
      {checking ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
      {checking ? 'Checking storage…' : observation ? 'Refresh storage' : 'Check storage'}
    </button></header>
    {!observation && !error ? <p>Read this Run’s storage facts on demand. This check leaves terminal input unchanged.</p> : null}
    {error ? <p role="status" className="terminal-storage-details__failure">Storage check did not complete: {error} Your original terminal is kept; retry this same Run.</p> : null}
    {observation ? <>
      <p className="terminal-storage-details__sample">Sampled {new Date(observation.observedAt).toLocaleTimeString()} · {observation.runtime.hostId}</p>
      <dl className="terminal-storage-details__identity"><div><dt>Run</dt><dd>{observation.run.runId}</dd></div><div><dt>Runtime</dt><dd>{observation.runtime.instanceId}</dd></div></dl>
      {observation.status === 'unsupported' ? <p role="status">{observation.message} Storage limits and persistence state are unknown; existing terminal capabilities are unchanged.</p> : null}
    </> : null}
    {storage ? <>
      {persistence?.firstFailure ? <div className="terminal-storage-details__failure" role="status"><strong>Storage persistence failure</strong><p>{persistence.firstFailure}</p><p>The original owner error and stage are retained. This does not by itself mean PTY source bytes were lost.</p></div> : null}
      <dl className="terminal-storage-details__metrics">
        <div><dt>Memory byte interval</dt><dd>[{storage.memory.firstAvailableByte.toLocaleString()}, {storage.memory.latestOutputByte.toLocaleString()}) B</dd></div>
        <div><dt>Durable earliest byte</dt><dd>Unknown · not exposed by this observation</dd></div>
        {persistence ? <>
          <div><dt>Offered to storage</dt><dd title={offset(persistence.offeredByte)}>{offset(persistence.offeredByte)}</dd></div>
          <div><dt>Last confirmed commit</dt><dd title={offset(persistence.confirmedByte)}>{offset(persistence.confirmedByte)}</dd></div>
          <div><dt>Unconfirmed byte span</dt><dd>{bytes(lag!)} · not a lost-byte count</dd></div>
          <div><dt>Storage writer</dt><dd>{persistence.actorStopped ? 'Stopped' : 'Not stopped'}</dd></div>
          <div><dt>Queued append commands</dt><dd>{persistence.queuedAppendCommands.toLocaleString()} · excludes in-flight work</dd></div>
        </> : <div><dt>Persistence facts</dt><dd>Unavailable for this Runtime</dd></div>}
      </dl>
      <p>Offered and confirmed positions are separate watermarks. Disk may be ahead after an unconfirmed commit; this sample does not prove a durable byte range.</p>
      {continuationReason === 'source_gap' ? <p className="terminal-storage-details__reason"><strong>Source gap reported.</strong> The Runtime cannot confirm continuous terminal state. Storage lag and capacity limits are separate facts.</p> : continuationReason === 'tail_evicted' ? <p className="terminal-storage-details__reason"><strong>Retained tail evicted.</strong> The Runtime reported missing bytes after the checkpoint. Refreshing storage cannot reconstruct those bytes.</p> : null}
      <h4>Effective capacity policy</h4>
      <dl className="terminal-storage-details__metrics">
        <div><dt>Memory · Run / shared</dt><dd>{bytes(storage.policy.memoryPerRunBytes)} / {bytes(storage.policy.memorySharedBytes)}</dd></div>
        <div><dt>Replay · Run / shared</dt><dd>{bytes(storage.policy.replayPerRunBytes)} / {bytes(storage.policy.replaySharedBytes)}</dd></div>
        <div><dt>Database budget</dt><dd>{bytes(storage.policy.databaseBytes)}</dd></div>
        <div><dt>WAL checkpoint threshold</dt><dd>{bytes(storage.policy.walCheckpointBytes)}</dd></div>
        <div><dt>Terminal history limit</dt><dd>{storage.policy.terminalHistoryRows.toLocaleString()} rows</dd></div>
        <div><dt>Terminal checkpoint limit</dt><dd>{bytes(storage.policy.terminalCheckpointBytes)}</dd></div>
      </dl>
      <p>Capacity policies bound retention and can evict older bytes. A storage failure or a reported source gap is a separate condition; limits alone do not identify lost history.</p>
    </> : null}
  </section>
}
