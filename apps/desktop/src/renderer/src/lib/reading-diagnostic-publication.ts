import type { ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { clientIncidentDispatcher } from './client-incident-recorder'
import { readingClientIncident } from './reading-client-incident'

/** Reuse the document's actual diagnostic queue and authenticated archive route. */
export function publishReadingDiagnostic(record: ReadingDiagnosticRecord): void {
  try {
    const dispatcher = clientIncidentDispatcher()
    dispatcher.send(readingClientIncident(record, dispatcher.dropped()))
  } catch { /* Only this diagnostic publication is unavailable; the original reader continues. */ }
}
