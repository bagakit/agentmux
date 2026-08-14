import { useId } from 'react'
import { Gauge } from 'lucide-react'
import type { AgentTurnUsage } from '@agentmux/core'
import { formatTokenCount } from '../lib/agent-usage'

/**
 * The composer's context-usage indicator: an always-visible chip carrying the one scannable number,
 * plus a click-opened card with the full breakdown.
 *
 * A native observation, not an estimate based on lifetime billing or the unsent draft.
 *
 * ── Why a chip + native popover, not the old inline tooltip-span ──
 * Supervising many Agents at once, the question you scan for is "which one is filling up and about to
 * compact" — a used% that rises toward danger. So the chip shows used% inline, always, never width-
 * clipped (the whole prior bug: commit 1b5b5a69 clamped `.composer__context` to `max-width: 7ch`, which
 * hid the percentage entirely — the number is ~21 chars, the icon alone eats most of 7ch). The full
 * breakdown (both used% and remaining%, k-abbreviated used-of-total, honesty note, last observation) is
 * needed rarely, so it lives in a card opened on demand.
 *
 * The card is a native `popover`: it renders in the top layer, so it escapes the composer's
 * `overflow: hidden` (a plain absolutely-positioned card would be clipped — the same class of bug). The
 * trigger is a real `<button popovertarget>`, so keyboard toggle + Esc dismiss + focus are native, and
 * the breakdown is real DOM text a screen reader reads — an improvement on the old title-string, which
 * `title` alone would not have made keyboard-reachable.
 *
 * Honesty (kept from the prior version): KNOWN vs UNKNOWN is distinguished; a missing/non-finite
 * capacity or used never renders a fake 0% — it says "unavailable". used% and remaining% are derived
 * from ONE rounded number (`remaining = 100 - used`) so they always sum to 100.
 */
export function AgentContextUsage({ usage }: { usage?: AgentTurnUsage | undefined }) {
  const cardId = useId()
  const context = usage?.context
  const known = context && Number.isFinite(context.capacityTokens) && context.capacityTokens > 0 &&
    Number.isFinite(context.usedTokens) && context.usedTokens >= 0
  // One rounded percentage is the source of truth; the other is its complement, so the two always sum
  // to 100 (independent floors of used and remaining could sum to 99).
  const used = known ? Math.min(100, Math.max(0, Math.round(context.usedTokens / context.capacityTokens * 100))) : null
  const remaining = used === null ? null : 100 - used

  const chip = known ? `${used}%` : '—'
  const ariaLabel = known
    ? `Context window: ${used}% used, ${remaining}% remaining. ${formatTokenCount(context.usedTokens)} of ${formatTokenCount(context.capacityTokens)} tokens.`
    : 'Context usage unavailable: this Agent has not reported used tokens and capacity.'

  return (
    <>
      <button type="button" className="composer__context" aria-label={ariaLabel}
        popoverTarget={cardId} popoverTargetAction="toggle">
        <Gauge size={12} aria-hidden="true" /> {chip}
      </button>
      <div id={cardId} popover="auto" className="composer__context-card" role="tooltip" aria-label="Context window">
        <h3>Context window</h3>
        {known && usage ? (
          <>
            <strong>{used}% used</strong> <span>({remaining}% remaining)</span>
            <p>{formatTokenCount(context.usedTokens)} of {formatTokenCount(context.capacityTokens)} tokens</p>
            <p>Native observation, unsent draft excluded. The Provider may compact at its own threshold,
              which AgentMux does not guess. Last observed {new Date(usage.observedAt).toLocaleString()}.</p>
          </>
        ) : (
          <p>Unavailable — this Agent has not reported used tokens and capacity, so the compression
            threshold is unknown. This is a native reading, never an estimate from lifetime billing.</p>
        )}
      </div>
    </>
  )
}
