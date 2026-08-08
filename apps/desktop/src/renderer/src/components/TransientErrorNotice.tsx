import { AlertTriangle, X } from 'lucide-react'

/** A transient workflow error that never covers the workbench and can be revisited after dismissal. */
export function TransientErrorNotice({
  error,
  dismissed,
  lastError,
  onDismiss,
  onReopen
}: {
  error: string | null
  dismissed: boolean
  lastError: string | null
  onDismiss: () => void
  onReopen: () => void
}) {
  if (error && !dismissed) {
    return (
      <aside className="error-notice" role="alert" aria-live="assertive">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{error}</span>
        <button className="icon-button error-notice__close" type="button" aria-label="Dismiss error" title="Dismiss error" onClick={onDismiss}>
          <X size={14} />
        </button>
      </aside>
    )
  }
  if (dismissed && lastError) {
    return (
      <button className="error-notice__reopen" type="button" onClick={onReopen}>
        <AlertTriangle size={12} aria-hidden="true" /> Show last error
      </button>
    )
  }
  return null
}
