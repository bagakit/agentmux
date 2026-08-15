import { AlertTriangle, X } from 'lucide-react'
import { serviceNoticeAriaLive } from '../lib/service-window-notice'

/**
 * A transient workflow error that never covers the workbench and can be revisited after dismissal.
 *
 * Volume is no longer hardcoded here. Before, this surface pinned `role="alert" aria-live="assertive"` for
 * every one of `reportError`'s call sites — from "document save failed" to a dead channel — so everything
 * shouted at maximum urgency and nothing was heard (alarm fatigue). It now derives its ARIA volume from the
 * SAME axis the service window uses: `serviceNoticeAriaLive(kind)` (service-window-notice.ts, built by
 * T-003). No second severity enum, no second table — one axis, consumed by both render surfaces. `role`
 * follows the volume (`assertive ⟺ alert`, else `status`), the identical rule ServiceWindowNotice applies.
 *
 * `kind` defaults to `'indeterminate'`, the safe side for an unlabelled caller. A caught `unknown` reaching
 * `reportError` carries no agent-viability to read; principle 11 keeps `unknown` first-class (never folded
 * into "alive" or "dead"), and a survey of the ~69 call sites found them class-2 by construction — the
 * agent-death facts flow through session status, not this banner. `indeterminate` maps to the
 * quiet-but-visible tier (`polite`/`status`): non-interrupting, but never silent. A caller that KNOWS the
 * agent is dead passes `kind="agent-broken"` for the loud tier; labelling the individual call sites is the
 * follow-up, not this change.
 *
 * f-25h8fysz9 disposition: layer 3 (this alarm-fatigue collapse) is handled here; layers 1-2 (re-picking an
 * already-registered folder should not error; a schema's internals should not leak) were fixed by
 * WorkspaceSidebar's no-op focus and commits 50885d62 / 0512be62.
 */
export function TransientErrorNotice({
  error,
  dismissed,
  lastError,
  onDismiss,
  onReopen,
  // Reuse the service-window axis's own key type — referenced, not copied, and without needing a new
  // export. Adding a fifth kind reds T-003's `Record` in service-window-notice.ts, so the exhaustiveness
  // guarantee flows through here rather than being re-asserted.
  kind = 'indeterminate'
}: {
  error: string | null
  dismissed: boolean
  lastError: string | null
  onDismiss: () => void
  onReopen: () => void
  kind?: Parameters<typeof serviceNoticeAriaLive>[0]
}) {
  if (error && !dismissed) {
    const ariaLive = serviceNoticeAriaLive(kind)
    return (
      <aside className="error-notice" role={ariaLive === 'assertive' ? 'alert' : 'status'} aria-live={ariaLive}>
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
