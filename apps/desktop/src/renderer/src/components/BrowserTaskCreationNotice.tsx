import type { MouseEvent } from 'react'
import type { BrowserTaskCreateInput } from '../../../shared/browser-task-creation'

export function BrowserTaskCreationNotice({ input, busy, onInspect, onContinue }: {
  input: BrowserTaskCreateInput
  busy: boolean
  onInspect(event: MouseEvent<HTMLButtonElement>): void
  onContinue(event: MouseEvent<HTMLButtonElement>): void
}) {
  return <section className="browser-task-asset-entry browser-task-creation" aria-label="Original task import">
    <p role="status">The original import input is kept until its saved receipt is confirmed.</p>
    <small>Source {input.sourceRecordingId} · revision {input.sourceRevision} · request {input.createOperationId}</small>
    <div>
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={onInspect}>Check original import</button>
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={onContinue}>Continue original import</button>
    </div>
  </section>
}
