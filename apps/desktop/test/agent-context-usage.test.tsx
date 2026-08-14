import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentContextUsage } from '../src/renderer/src/components/AgentContextUsage'
import { extractTurnUsage, parseTurnUsage } from '../../../packages/core/src/agent-usage-transcript'
import { normalizeStoredAgentSession } from '../../../packages/core/src/agent-session-store'
import { styleFiles, stripCssComments } from './helpers/styles.js'

// ── A tiny brace-aware CSS reader, only enough to answer "does any rule width-clamp the chip?" ──
// No CSS parser is installed in this tree, and the property we must pin — "the chip is never
// width-clamped" — cannot be seen by a substring/regex guard: it hides behind a different property
// (`width` vs `max-width`) or a higher-specificity selector the base rule never sees. So we parse.
type Decls = Map<string, string>
type Rule = { selector: string; decls: Decls }

function parseDecls(body: string): Decls {
  const decls: Decls = new Map()
  for (const part of body.split(';')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const prop = part.slice(0, idx).trim().toLowerCase()
    if (prop) decls.set(prop, part.slice(idx + 1).trim()) // last write wins = the rule's resolved value
  }
  return decls
}

// Every style rule, descending into @media/@supports/@container/@layer/@scope bodies (a clamp can hide
// in a media query too); @keyframes/@font-face bodies are skipped whole via brace depth.
function parseRules(css: string): Rule[] {
  const rules: Rule[] = []
  const walk = (start: number, end: number) => {
    let i = start
    let prelude = ''
    while (i < end) {
      const c = css[i]
      if (c === '{') {
        let depth = 1, j = i + 1
        for (; j < end && depth > 0; j++) {
          if (css[j] === '{') depth++
          else if (css[j] === '}' && --depth === 0) break
        }
        const sel = prelude.trim()
        if (/^@(media|supports|container|layer|scope)\b/i.test(sel)) walk(i + 1, j)
        else if (sel && !sel.startsWith('@')) rules.push({ selector: sel, decls: parseDecls(css.slice(i + 1, j)) })
        prelude = ''
        i = j + 1
      } else if (c === ';') { prelude = ''; i++ } // @import; / @charset; and friends
      else { prelude += c; i++ }
    }
  }
  walk(0, css.length)
  return rules
}

// A rule styles the chip itself when the SUBJECT (rightmost compound) of some selector in its list
// targets the class — as the dotted `.composer__context` OR any attribute-selector spelling of the same
// class (`[class~="composer__context"]`, `[class*="composer__context"]`, …). Those are CSS-equivalent
// ways to reach `class="composer__context"` that a dotted-only matcher misses — the very "pins one
// spelling" trap this guard exists to defeat, just moved from the property onto the selector. The
// trailing `(?![\w-])` keeps `.composer__context-card` (and its attribute form) out either way, so the
// breakdown card's own max-width never counts. Not matched: descendants like `.composer__context svg`.
const CHIP = /(?:\.composer__context|\[class[~*^$|]?=\s*["']?[^"'\]]*composer__context)(?![\w-])/

// The rightmost compound = everything after the last TOP-LEVEL combinator. Combinator chars (` >+~`)
// also live inside `[att~="…"]` and `:has(> …)`, so splitting on them raw shatters an attribute selector
// (the `~` in `[class~=…]`) and hands back a garbage subject — the exact defect the adversary used to
// re-enter the bug. So mask bracket/paren interiors to same-length filler first, find the last combinator
// in the masked copy, and slice the ORIGINAL there. (memory: lexical boundaries need a real lexer.)
function maskGroups(sel: string): string {
  let out = '', paren = 0, bracket = false
  for (const c of sel) {
    if (!bracket && c === '(') { paren++; out += c }
    else if (!bracket && c === ')') { paren = Math.max(0, paren - 1); out += c }
    else if (paren === 0 && c === '[') { bracket = true; out += c }
    else if (bracket && c === ']') { bracket = false; out += c }
    else out += (paren > 0 || bracket) ? 'x' : c
  }
  return out
}
function matchesChip(selector: string): boolean {
  return selector.split(',').some((raw) => {
    const sel = raw.trim()
    const masked = maskGroups(sel)
    let cut = -1
    for (let k = 0; k < masked.length; k++) if (/[\s>+~]/.test(masked[k]!)) cut = k
    return CHIP.test(sel.slice(cut + 1))
  })
}

// The resolved effect that clips the number: a finite width constraint. `max-width` anything but `none`;
// `width`/`flex-basis` anything but the intrinsic-content keywords (a chip must size to its text).
// `text-overflow` other than `clip` is the truncation smell that has no business on a never-truncated
// chip. Both the physical (`max-width`/`width`) and the logical (`max-inline-size`/`inline-size`)
// spellings clip an inline-flex chip identically in horizontal writing mode, and the chip is a flex item
// of the toolbar row so a fixed `flex-basis` (longhand or as the `flex` shorthand's length component)
// clips it just as hard — check them all, or each is a free re-entry for the same 7ch bug.
// ponytail: clip via `clip-path: inset(...)` math is left unguarded — exotic, no accidental-regression
// path; add an inset parser only if a real one shows up.
const INTRINSIC = ['auto', 'max-content', 'fit-content', 'min-content']
const LENGTH = /^-?\d*\.?\d+(?:ch|px|r?em|%|v[wh]|vmin|vmax|pt|pc|in|cm|mm|q|ex|cap|ic|r?lh|v[bi])$/i
function clampReasons(decls: Decls): string[] {
  const reasons: string[] = []
  for (const prop of ['max-width', 'max-inline-size']) {
    const value = decls.get(prop)
    if (value !== undefined && value !== 'none') reasons.push(`${prop}: ${value}`)
  }
  for (const prop of ['width', 'inline-size', 'flex-basis']) {
    const value = decls.get(prop)
    if (value !== undefined && !INTRINSIC.includes(value) && value !== 'content') reasons.push(`${prop}: ${value}`)
  }
  const flex = decls.get('flex') // shorthand: its one length/percentage token is the flex-basis
  const basis = flex?.split(/\s+/).find((token) => LENGTH.test(token))
  if (basis !== undefined && parseFloat(basis) !== 0) reasons.push(`flex: ${flex}`)
  const textOverflow = decls.get('text-overflow')
  if (textOverflow !== undefined && textOverflow !== 'clip') reasons.push(`text-overflow: ${textOverflow}`)
  return reasons
}

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
  // This repo runs vitest in the node environment: no jsdom, no layout engine, so no DOM test can ever
  // observe the percentage being visually clipped. The defect lived entirely in the stylesheet (commit
  // 1b5b5a69: `max-width: 7ch; overflow: hidden; text-overflow: ellipsis` on `.composer__context`,
  // clipping a ~21-char label down to roughly the icon). The property this guard must pin is not a
  // spelling — it is "no rule that styles the chip width-clamps its text". A substring guard on one base
  // rule is defeatable two ways that both leave the suite green: a different clamping property in the
  // same rule (`width: 7ch` clips an inline-flex chip just as hard), and the original `max-width` clause
  // re-added at higher specificity (`.composer__context:not(#never) { max-width: 7ch; … }`) which a
  // base-rule regex never sees. So we PARSE: every rule whose subject compound targets the chip, across
  // every stylesheet, checked for a resolved width constraint.
  it('no stylesheet rule width-clamps the context chip (pins the property, not one spelling)', () => {
    const rules = styleFiles().flatMap((file) => parseRules(stripCssComments(file.text)))
    const chipRules = rules.filter((rule) => matchesChip(rule.selector))
    // Existence: if the class is renamed or deleted the whole guard would pass vacuously (memory:
    // name-existence-check-is-blind-to-rule-bodies). The chip must actually be styled, and its bare base
    // rule must be one of the rules we found.
    expect(chipRules.length, 'no rule targets `.composer__context` — the chip is unstyled or renamed, guard is vacuous').toBeGreaterThan(0)
    expect(chipRules.some((rule) => rule.selector.trim() === '.composer__context'),
      'the bare `.composer__context {` base rule is gone — the chip definition moved out from under the guard').toBe(true)
    const offenders = chipRules
      .flatMap((rule) => clampReasons(rule.decls).map((reason) => `${rule.selector} { ${reason} }`))
    expect(offenders, `the context chip is width-clamped — the percentage clips again, the whole 7ch bug:\n${offenders.join('\n')}`)
      .toEqual([])
  })
})
