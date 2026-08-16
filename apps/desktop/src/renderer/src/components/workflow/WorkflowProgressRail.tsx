export function WorkflowProgressRail({ completed, total, status }: { completed: number; total: number; status: string }) {
  const percentage = total === 0 ? 0 : Math.max(0, Math.min(100, (completed / total) * 100))
  return (
    <span
      className="wf-rail"
      role="progressbar"
      aria-label="Workflow progress"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      data-status={status}
    >
      <span className="wf-rail__fill" style={{ width: `${percentage}%` }} />
    </span>
  )
}
