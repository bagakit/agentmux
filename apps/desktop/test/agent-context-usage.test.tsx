import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { extractTurnUsage, parseTurnUsage } from '../../../packages/core/src/agent-usage-transcript'
import { normalizeStoredAgentSession } from '../../../packages/core/src/agent-session-store'
import { styleFiles } from './helpers/styles.js'

function observe(used: number, capacity: unknown = 1000) {
  const content = JSON.stringify({ payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: used - 10, output_tokens: 10, total_tokens: used },
    total_token_usage: { total_tokens: 9000000 }, model_context_window: capacity
  } } })
  const usage = parseTurnUsage(extractTurnUsage({ kind: 'native-transcript', transcriptFormat: 'codex-rollout' }, content, 1000))!
  return normalizeStoredAgentSession({ kind: 'agent', agentSessionId: 'context-test',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/tmp/test',
    run: { runId: 'run-test' }, retiredRuns: [], hookBindingId: 'test-binding', hookToken: 'test-token',
    outputCursorBytes: 0, createdAt: 0, updatedAt: 1000, turnUsage: usage
  }).turnUsage!
}

describe('context observation to composer', () => {
  it('preserves current native usage through IPC parsing and store restore, never lifetime billing', () => {
    const usage = observe(250)
    expect(usage.context).toEqual({ usedTokens: 250, capacityTokens: 1000 })
    const html = renderToStaticMarkup(<AgentContextUsage usage={usage} />)
    // The chip carries the used% inline — the whole point of the indicator, and the number the prior
    // 7ch clamp hid. It must be inside the CHIP BUTTON, not merely somewhere in the markup: asserting
    // `toContain('25%')` on the whole html is satisfied by the card body ("25% used") even if the chip
    // itself shows nothing, so scope to the button's own text.
    const chip = html.match(/<button[^>]*class="composer__context"[^>]*>(.*?)<\/button>/s)?.[1]
    expect(chip, 'the context chip button did not render').toBeDefined()
    expect(chip, 'the chip does not show the used percentage — the 7ch bug at the DOM level').toContain('25%')
    // A real <button> is the trigger: natively focusable + keyboard-toggleable, no tabIndex hack, and
    // it addresses the card by popovertarget so Esc/dismiss are native too.
    expect(html).toMatch(/popovertarget/i)
    // The honesty note lives in the breakdown card, which renders into the DOM (top-layer popover).
    expect(html).toContain('Native observation')
  })

  it('shows BOTH used% and remaining%, and they sum to 100 — never a fake 0% when known', () => {
    // Reference information design: title / used% + remaining% / used-of-total in k units. Both figures
    // appear, derived from one rounded number so they always sum to 100 (independent floors could give 99).
    const html = renderToStaticMarkup(<AgentContextUsage usage={observe(250)} />)
    expect(html).toContain('25% used')
    expect(html).toContain('75% remaining')
  })

  it('uses k-abbreviated token counts in the card, not full digit strings', () => {
    // 367_400 used of 828_000 → "367k of 828k", matching the reference. The abbreviation is the shared
    // formatTokenCount SSOT (boundary behaviour is pinned in agent-usage-display.test.ts); this guard
    // only proves the component actually routes its counts through it rather than printing raw digits.
    const html = renderToStaticMarkup(<AgentContextUsage usage={observe(367_400, 828_000)} />)
    expect(html).toContain('367k of 828k')
    expect(html).not.toContain('367,400')
    expect(html).not.toContain('828,000')
    // 44% used → 56% remaining, both shown.
    expect(html).toContain('44% used')
    expect(html).toContain('56% remaining')
  })

  it('reflects reduced context after compaction and clamps an exhausted window to 100% used / 0% remaining', () => {
    expect(renderToStaticMarkup(<AgentContextUsage usage={observe(800)} />)).toContain('80% used')
    expect(renderToStaticMarkup(<AgentContextUsage usage={observe(200)} />)).toContain('20% used')
    const exhausted = renderToStaticMarkup(<AgentContextUsage usage={observe(1100)} />)
    expect(exhausted).toContain('100% used')
    expect(exhausted).toContain('0% remaining')
  })

  it.each([undefined, 0, -1, '1000'])('keeps missing or invalid capacity %s honest — "Unavailable", never a fake 0%%', (capacity) => {
    const usage = observe(250, capacity === undefined ? null : capacity)
    expect(usage.context).toBeUndefined()
    const html = renderToStaticMarkup(<AgentContextUsage usage={usage} />)
    expect(html).toContain('Unavailable')
    // The reason to distinguish KNOWN from UNKNOWN: an unavailable reading must never render as 0% used
    // or 0% remaining, which would read as a real, empty-or-full window.
    expect(html).not.toContain('0% used')
    expect(html).not.toContain('0% remaining')
    // The chip degrades to a neutral marker, not a fabricated number.
    expect(html).toMatch(/composer__context"[^>]*>[^<]*<svg/) // chip still renders
  })

  it('never shows lifetime billing — the card names its source as native, not an estimate', () => {
    const known = renderToStaticMarkup(<AgentContextUsage usage={observe(250)} />)
    expect(known).toContain('unsent draft excluded')
    const unknown = renderToStaticMarkup(<AgentContextUsage usage={observe(250, 0)} />)
    expect(unknown).toContain('never an estimate from lifetime billing')
  })

  // ── CSS-contract guard for the 7ch clipping bug ──
  // jsdom does not lay out or apply `text-overflow`/`overflow: hidden`, so no DOM test can observe the
  // percentage being visually clipped away. The defect lived entirely in the stylesheet (commit
  // 1b5b5a69: `max-width: 7ch; overflow: hidden; text-overflow: ellipsis` on `.composer__context`,
  // clipping a ~21-char label — and even the shorter new chip — down to roughly the icon). So the guard
  // that would have caught it reads the stylesheet: the chip's base rule must not width-clamp its own
  // text.
  it('the context chip is not width-clipped in the stylesheet (would have caught the 7ch bug)', () => {
    const composer = styleFiles().find((file) => file.name === 'composer.css')
    expect(composer, 'composer.css is not in the @import list any more').toBeDefined()
    // The base rule only: `.composer__context {` — not :hover, :focus-visible, or -card.
    const matches = [...composer!.text.matchAll(/\.composer__context \{([^}]*)\}/g)]
    expect(matches.length, '`.composer__context` base rule is not exactly one — picking [0] would guess wrong').toBe(1)
    const rule = matches[0]![1]!
    expect(rule, 'chip re-acquired a max-width — the percentage clips again, the whole 7ch bug').not.toMatch(/max-width/)
    expect(rule, 'chip re-acquired text-overflow:ellipsis — the percentage is truncated to an ellipsis').not.toMatch(/text-overflow/)
  })
})
