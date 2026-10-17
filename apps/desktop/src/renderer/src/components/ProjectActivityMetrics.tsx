import type { SessionSnapshot } from '../../../shared/contracts'
import { categoryFor } from '../lib/attention-event'
import { idleAgentCount, producingAgentCount } from '../lib/project-board'
import { SemanticIcon } from './semantic-icons'

export function activityMetrics(sessions: readonly SessionSnapshot[]) {
  return [
    { key: 'needs-you', count: sessions.filter(session => session.kind === 'agent' && categoryFor(session.status.state) === 'needs-you').length, icon: 'status.needs-input' as const, label: 'Needs you' },
    { key: 'error', count: sessions.filter(session => session.kind === 'agent' && categoryFor(session.status.state) === 'error').length, icon: 'status.failed' as const, label: 'Error' },
    { key: 'working', count: producingAgentCount(sessions), icon: 'status.working' as const, label: 'Working' },
    { key: 'idle', count: idleAgentCount(sessions), icon: 'status.idle' as const, label: 'Idle' },
    { key: 'done', count: sessions.filter(session => session.kind === 'agent' && session.status.state === 'done').length, icon: 'status.completed' as const, label: 'Completed' }
  ].filter(metric => metric.count > 0)
}

export function ActivityMetrics({ sessions, compact = false }: { sessions: readonly SessionSnapshot[]; compact?: boolean }) {
  const metrics = activityMetrics(sessions)
  const attention = metrics.filter(metric => metric.key === 'needs-you' || metric.key === 'error')
  const shown = compact ? (attention.length ? attention : metrics.slice(0, 1)) : metrics
  return <span className="project-activity__metrics" aria-hidden="true">{shown.map(metric =>
    <span key={metric.key} className={`project-activity__metric project-activity__metric--${metric.key}`}>
      <SemanticIcon name={metric.icon} size={12} /><strong>{metric.count}</strong>
    </span>)}</span>
}

