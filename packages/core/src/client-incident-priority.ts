import type { AgentMuxClientIncidentReport } from './client-incident.js'

export type ClientIncidentPriority = 'critical' | 'reading' | 'progress'

/** Retention policy only; no Run, recovery or input authority follows from this class. */
export function clientIncidentPriority(report: Pick<AgentMuxClientIncidentReport, 'kind'> & {
  reading?: { trigger: NonNullable<AgentMuxClientIncidentReport['reading']>['trigger'] }
}): ClientIncidentPriority {
  switch (report.kind) {
    case 'capability-probe': return 'progress'
    case 'conversation-reading-progress':
      // The durable index has kind only. An absent trigger cannot prove healthy progress
      // or justify reclaiming a retained release record; the whole reading group stays bounded.
      return report.reading?.trigger === 'progress' ? 'progress' : 'reading'
    case 'conversation-reading-failure':
    case 'conversation-reading-held':
    case 'conversation-reading-recovered': return 'reading'
    default: return 'critical'
  }
}
