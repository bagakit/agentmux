import type { BrowserOperationJournalChanges, BrowserOperationJournalDocument } from '../src/main/browser-operation-journal.js'

/** Test-only durable collaborator; it consumes the same immutable delta as the file owner. */
export function applyJournalChanges(document: BrowserOperationJournalDocument | null, changes: BrowserOperationJournalChanges): BrowserOperationJournalDocument {
  const next = document ?? { version: 1, operations: [], events: [] }
  for (const { metadata, steps } of changes.operations) {
    const index = next.operations.findIndex(operation => operation.id === metadata.id)
    const previous = index < 0 ? [] : next.operations[index]!.steps
    const bySequence = new Map(previous.map(step => [step.sequence, step]))
    for (const step of steps) bySequence.set(step.sequence, structuredClone(step))
    const operation = { ...structuredClone(metadata), steps: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence) }
    if (index < 0) next.operations.push(operation)
    else next.operations[index] = operation
  }
  next.events.push(...changes.events.map(({ event }) => structuredClone(event)))
  next.events = next.events.slice(-changes.maxEvents)
  return next
}
