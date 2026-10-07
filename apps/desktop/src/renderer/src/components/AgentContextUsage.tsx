import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentTurnUsage } from '@agentmux/core'
import { agentUsageScopeLabel, contextUsedPercent, formatTokenCount } from '../lib/agent-usage'
import { useAppStore } from '../store'

const ThemeObjectPerformanceIcon = semanticIconComponent('object.performance')


/**
 * The composer's context-usage indicator: an always-visible chip carrying the one scannable number,
 * plus a hover preview that can be explicitly kept open for reading.
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
export function AgentContextUsage({ usage, source, visible = true }: { usage?: AgentTurnUsage | undefined; source?: string; visible?: boolean }) {
  const cardId = useId(), anchor = `--context-${cardId.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const owner = useMemo(() => ({}), [source, visible])
  const latest = useRef(owner); latest.current = owner
  const mounted = useRef(true), preview = useRef(false), interacted = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [opened, setOpened] = useState<object | null>(null)
  const open = visible && opened === owner
  const cancelClose = () => clearTimeout(closeTimer.current)
  const current = () => visible && mounted.current && latest.current === owner
  function pin() { if (!current()) return; cancelClose(); preview.current = false }
  function enter(event: PointerEvent) {
    if (!current() || event.pointerType !== 'mouse' || event.buttons !== 0) return
    cancelClose()
    if (card.current?.matches(':popover-open')) return
    preview.current = true; interacted.current = true
    // Native source supplies the implicit relationship; the unique named anchor scopes each chip.
    ;(card.current!.showPopover as (options: { source: HTMLButtonElement }) => void)
      .call(card.current, { source: trigger.current! })
  }
  function leave(event: PointerEvent) {
    if (!current() || event.pointerType !== 'mouse' || !preview.current) return
    cancelClose()
    closeTimer.current = setTimeout(() => { if (current() && preview.current) card.current?.hidePopover() }, 180)
  }
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false; cancelClose(); preview.current = false
      if (interacted.current && card.current?.isConnected) card.current.hidePopover()
      interacted.current = false
    }
  }, [owner])
  useEffect(() => {
    if (!open) return
    const dismissPreview = (event: KeyboardEvent) => {
      if (preview.current && event.key === 'Escape' && !isImeOwnedKeyboardEvent(event)) card.current?.hidePopover()
    }
    document.addEventListener('keydown', dismissPreview, true)
    return () => document.removeEventListener('keydown', dismissPreview, true)
  }, [open])
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  useEffect(() => {
    if (!open) return
    acquireNativeSurfaceOverlay()
    return () => {
      releaseNativeSurfaceOverlay()
    }
  }, [open, acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])

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
      <button ref={trigger} type="button" className="composer__context" aria-label={ariaLabel}
        style={{ anchorName: anchor }} aria-expanded={open} aria-controls={cardId}
        popoverTarget={cardId} popoverTargetAction="toggle" onPointerEnter={enter} onPointerLeave={leave}
        onClick={event => { if (!current()) { event.preventDefault(); return }; interacted.current = true; if (preview.current) { event.preventDefault(); pin() } }}>
        <ThemeObjectPerformanceIcon size={12} aria-hidden="true" /> {chip}
      </button>
      <div ref={card} id={cardId} popover="auto" className="composer__context-card" aria-label="Context window"
        style={{ positionAnchor: anchor }} onPointerEnter={() => { if (current()) cancelClose() }} onPointerLeave={leave} onPointerDownCapture={pin} onFocusCapture={pin}
        data-state={open ? 'open' : 'closed'}
        onToggle={(event) => { if (current()) {
          if (event.newState === 'open') interacted.current = true
          else { cancelClose(); preview.current = false }
          setOpened(event.newState === 'open' ? owner : null)
        } }}>
        <h3>Context window</h3>
        {known && usage ? (
          <>
            <strong>{used}% used</strong> <span>({remaining}% remaining)</span>
            <p>{formatTokenCount(context.usedTokens)} of {formatTokenCount(context.capacityTokens)} tokens · {formatTokenCount(Math.max(0, context.capacityTokens - context.usedTokens))} remaining</p>
            <p>Native observation, unsent draft excluded. The Provider may compact at its own threshold,
              which AgentMux does not guess. Last observed {new Date(usage.observedAt).toLocaleString()}.</p>
          </>
        ) : (
          <p>Unavailable — this Agent has not reported used tokens and capacity, so the compression
            threshold is unknown. This is a native reading, never an estimate from lifetime billing.</p>
        )}
        {usage ? <div className="composer__context-turn"><h3>{agentUsageScopeLabel(usage)}</h3><dl>
          <div><dt>Input</dt><dd>{formatTokenCount(usage.inputTokens)}</dd></div>
          <div><dt>Output</dt><dd>{formatTokenCount(usage.outputTokens)}</dd></div>
          <div><dt>Total</dt><dd>{formatTokenCount(usage.totalTokens)}</dd></div>
        </dl><p>Native usage report, separate from the context window observation.</p></div> : null}
      </div>
    </>
  )
}
