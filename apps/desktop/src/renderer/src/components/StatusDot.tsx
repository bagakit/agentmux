import type { AgentSessionSnapshot } from '../../../shared/contracts'

export function StatusDot({ status, withLabel = false }: { status: AgentSessionSnapshot['status']; withLabel?: boolean }) {
  return (
    <span className={`status status--${status.state}`} title={`${status.state} · ${status.source}`}>
      <span className="status__dot" />
      {withLabel ? <span>{status.state}</span> : null}
    </span>
  )
}
