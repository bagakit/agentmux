import { useId } from 'react'
import { Gauge } from 'lucide-react'
import type { AgentTurnUsage } from '@agentmux/core'
import { contextUsedPercent, formatTokenCount } from '../lib/agent-usage'

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
  // 「这个数知不知道」由 agent-usage 的 contextUsedPercent 独判——全窗口唯一一处。此处曾自己写那 6 行，
  // 项目活动行也照抄过一份；三份同源判定漂移，同一个 Agent 会在输入框、项目行、名册上给出三种说法。
  const used = contextUsedPercent(context)
  const known = context !== undefined && used !== null
  // used% 与 remaining% 由同一个取整数派生（remaining = 100 - used），两者永远加起来是 100
  // （各自独立取整会出现 99）。
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
      <div id={cardId} popover="auto" className="composer__context-card" aria-label="Context window">
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
