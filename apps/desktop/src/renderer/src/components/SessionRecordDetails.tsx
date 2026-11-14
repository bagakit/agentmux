import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useEffect, useRef, useState } from 'react'
import type { AgentSessionUsagePage } from '@agentmux/core'
import { api } from '../lib/api'
import { SessionRecordDelete } from './SessionRecordDelete'
import type { AgentSessionRecordDeletionReceipt } from '@agentmux/core/agent-session-record'
import { LocalRetainedInputDetails } from './LocalRetainedInputs'
import type { LocalInputTarget } from '../lib/local-retained-inputs'

type Observation = { page: AgentSessionUsagePage; records: number; logicalBytes: number; pages: number }
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(2)} MiB`

function Usage({ target }: { target: LocalInputTarget }) {
  const [observation, setObservation] = useState<Observation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const reader = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    reader.current = controller
    setObservation(null); setError(null); setRunning(true)
    void (async () => {
      let cursor: string | undefined, records = 0, logicalBytes = 0, pages = 0
      do {
        const page = await api.sessions.readUsage(target, { limit: 256, ...(cursor ? { cursor } : {}) }, { signal: controller.signal })
        controller.signal.throwIfAborted()
        if (page.hostId !== target.hostId || page.agentSessionId !== target.agentSessionId) throw new Error('Inspection returned another original Session. Original history is kept.')
        pages++
        if (page.captured.status === 'measured') { records += page.captured.records; logicalBytes += page.captured.logicalBytes }
        setObservation({ page, records, logicalBytes, pages })
        cursor = page.captured.status === 'measured' ? page.captured.nextCursor ?? undefined : undefined
        // Release each Core reader before allowing another short target-index page.
        if (cursor) await new Promise<void>(resolve => setTimeout(resolve, 0))
        controller.signal.throwIfAborted()
      } while (cursor)
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (reader.current === controller) setRunning(false) })
    return () => { controller.abort(); if (reader.current === controller) reader.current = null }
  }, [target.hostId, target.agentSessionId, attempt])
  const captured = observation?.page.captured
  return <section aria-label="Captured body usage" aria-busy={running}>
    <div className="session-record-details__heading"><strong>Captured record bodies</strong>
      {running ? <Button type="button" onClick={() => { reader.current?.abort(); setRunning(false) }}>Stop inspection</Button>
        : <Button type="button" onClick={() => setAttempt(value => value + 1)}>Inspect again</Button>}</div>
    {captured?.status === 'measured' ? <>
      <p className="session-record-details__amount">{bytes(observation!.logicalBytes)} <span>logical JSON · {observation!.records.toLocaleString()} versions</span></p>
      <p role="status">{captured.complete ? 'Captured range inspected' : running ? 'Inspecting captured range…' : 'Partial inspection · stopped'} · {observation!.pages} pages</p>
      <dl className="session-record-details__facts"><div><dt>Epoch</dt><dd>{captured.epoch}</dd></div>
        <div><dt>Sequence</dt><dd>1–{captured.throughSequence} · checked through {captured.lastSequence}</dd></div>
        <div><dt>Last observation</dt><dd>{new Date(observation!.page.observedAt).toLocaleString()}</dd></div></dl>
    </> : <p role="status">{captured?.status === 'not-measured' ? captured.reason : running ? 'Reading original Core storage…' : 'Usage not confirmed.'}</p>}
    {error ? <p className="session-record-details__warning" role="status">Inspection unavailable: {error} Original history and local inputs are kept.</p> : null}
    <p className="muted">Logical body bytes only, including retained revisions. Pages are observed at their own times. Other Core records, Provider originals, ctxmux Runtime and shared database physical pages are not measured. This is not total Session storage or reclaimable disk space.</p>
  </section>
}

export function SessionRecordDetails({ target, deleted = false, onDeleted }: { target: LocalInputTarget; deleted?: boolean; onDeleted?(receipt: AgentSessionRecordDeletionReceipt): void }) {
  const [open, setOpen] = useState(false)
  const [confirmedDeleted, setConfirmedDeleted] = useState(deleted)
  const identity = JSON.stringify([target.hostId, target.agentSessionId])
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button type="button" className="session-record-details-trigger">Record details</Button></Dialog.Trigger>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface session-record-dialog session-record-details" onPointerDownCapture={event => event.stopPropagation()}>
        <header><Dialog.Title>Record details</Dialog.Title><Dialog.Close asChild><Button type="button">Close</Button></Dialog.Close></header>
        <Dialog.Description>Original Session records. Reading does not restore an Agent.</Dialog.Description>
        {open ? <div key={identity} className="session-record-details__body">
          <dl className="session-record-details__facts"><div><dt>Host</dt><dd>{target.hostId}</dd></div><div><dt>Session</dt><dd>{target.agentSessionId}</dd></div><div><dt>Owner</dt><dd>AgentMux Core · captured body JSON</dd></div></dl>
          {!deleted && !confirmedDeleted ? <Usage target={target} /> : null}
          <SessionRecordDelete target={target} onDeleted={receipt => { setConfirmedDeleted(true); onDeleted?.(receipt) }} />
          <LocalRetainedInputDetails target={target} />
        </div> : null}
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
