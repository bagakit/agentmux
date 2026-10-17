import { isObjectId, mintObjectId } from './object-id.js'
import { READING_DIAGNOSTIC_MAX_EVENTS, READING_DIAGNOSTIC_MAX_RECORD_BYTES, READING_DIAGNOSTIC_TRIGGERS,
  parseReadingDiagnosticEventInput, parseReadingDiagnosticScope,
  type ReadingDiagnosticEvent, type ReadingDiagnosticRecord, type ReadingDiagnosticScope } from './reading-diagnostic.js'

export type ReadingDiagnosticRecorderStatus = {
  recorded: number
  retained: number
  /** Logical UTF-8 JSON bytes of retained events, not a measurement of backing heap allocation. */
  retainedEventBytes: number
  overwritten: number
  rejected: number
  publicationFailures: number
  lastEmittedLogId: string | null
}
export type ReadingDiagnosticRecorder = {
  record(input: Omit<ReadingDiagnosticEvent, 'sequence' | 'wallMs' | 'monoMs'>): void
  flush(trigger: ReadingDiagnosticRecord['trigger']): void
  status(): ReadingDiagnosticRecorderStatus
}

const encoder = new TextEncoder()
const bytes = (value: object): number => encoder.encode(JSON.stringify(value)).byteLength
const increment = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, value + 1)
// Leave room for the finite envelope, IDs, counters and array separators. The final envelope is checked too.
const ENVELOPE_RESERVE_BYTES = 1024
function clock(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('Diagnostic clock is unavailable.')
  return value
}
function copyEvent(input: Omit<ReadingDiagnosticEvent, 'sequence' | 'wallMs' | 'monoMs'>,
  sequence: number, wallMs: number, monoMs: number): ReadingDiagnosticEvent {
  // The original finite metadata parser rejects accessors and arbitrary fields before reading them.
  const event: ReadingDiagnosticEvent = { ...parseReadingDiagnosticEventInput(input), sequence, wallMs, monoMs }
  if (event.nativeSource) Object.freeze(event.nativeSource)
  if (event.document) Object.freeze(event.document)
  return Object.freeze(event)
}

/** Owner-local finite metadata only. No timer, IO, trigger decision, source clock inference or business control. */
export function createReadingDiagnosticRecorder(scopeInput: ReadingDiagnosticScope, options: {
  publish(record: ReadingDiagnosticRecord): void
  now?(): number
  wall?(): number
  mintId?(): string
}): ReadingDiagnosticRecorder {
  const now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now, mintId = options.mintId ?? mintObjectId
  const retained: Array<{ event: ReadingDiagnosticEvent; bytes: number }> = []
  let scope: ReadingDiagnosticScope | null = null, eventBudget = 0, sequence = 0, recorded = 0, retainedEventBytes = 0
  let overwritten = 0, rejected = 0, publicationFailures = 0, previousLogId: string | null = null
  let startedAt: number | null = null, endedAt: number | null = null, lastMonoMs: number | null = null, publishing = false
  try {
    scope = Object.freeze(parseReadingDiagnosticScope(scopeInput))
    eventBudget = READING_DIAGNOSTIC_MAX_RECORD_BYTES - bytes(scope) - ENVELOPE_RESERVE_BYTES
    if (eventBudget < 0) scope = null
  } catch { /* Invalid diagnostic metadata cannot prevent construction of the original reader. */ }

  function evict(): void {
    const oldest = retained.shift()!
    retainedEventBytes -= oldest.bytes
    overwritten = increment(overwritten)
  }
  return {
    record(input) {
      sequence = increment(sequence)
      try {
        if (!scope || sequence === Number.MAX_SAFE_INTEGER) { rejected = increment(rejected); return }
        const wallMs = clock(wall()), monoMs = clock(now())
        if (lastMonoMs !== null && monoMs < lastMonoMs) { rejected = increment(rejected); return }
        const event = copyEvent(input, sequence, wallMs, monoMs), size = bytes(event) + 1
        if (size > eventBudget) { rejected = increment(rejected); return }
        while (retained.length >= READING_DIAGNOSTIC_MAX_EVENTS || retainedEventBytes + size > eventBudget) evict()
        retained.push({ event, bytes: size }); retainedEventBytes += size; recorded = increment(recorded)
        lastMonoMs = monoMs
        startedAt ??= wallMs
        if (event.phase === 'consumer-ended') endedAt = wallMs
      } catch { rejected = increment(rejected) }
    },
    flush(trigger) {
      if (publishing) { publicationFailures = increment(publicationFailures); return }
      try {
        if (!scope || !READING_DIAGNOSTIC_TRIGGERS.includes(trigger)) { publicationFailures = increment(publicationFailures); return }
        const logId = mintId()
        if (!isObjectId(logId) || logId === previousLogId) { publicationFailures = increment(publicationFailures); return }
        const makeRecord = (): ReadingDiagnosticRecord => ({ version: 'reading-diagnostic.v1', logId, previousLogId, scope: scope!,
          trigger, startedAt: startedAt ?? clock(wall()), endedAt, events: retained.map(value => value.event),
          coverage: { firstSequence: retained[0]?.event.sequence ?? null, lastSequence: retained.at(-1)?.event.sequence ?? null, overwritten, rejected, publicationFailures } })
        let record = makeRecord()
        while (bytes(record) > READING_DIAGNOSTIC_MAX_RECORD_BYTES && retained.length) { evict(); record = makeRecord() }
        if (bytes(record) > READING_DIAGNOSTIC_MAX_RECORD_BYTES) { publicationFailures = increment(publicationFailures); return }
        Object.freeze(record.events); Object.freeze(record.coverage); Object.freeze(record)
        publishing = true
        try {
          const result: unknown = options.publish(record)
          if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
            // A void callback can still be implemented with async. It violates the synchronous enqueue contract.
            publicationFailures = increment(publicationFailures)
            void Promise.resolve(result).catch(() => {})
            return
          }
          previousLogId = logId
        }
        finally { publishing = false }
      } catch { publicationFailures = increment(publicationFailures) }
    },
    status() {
      return { recorded, retained: retained.length, retainedEventBytes, overwritten, rejected, publicationFailures, lastEmittedLogId: previousLogId }
    },
  }
}
