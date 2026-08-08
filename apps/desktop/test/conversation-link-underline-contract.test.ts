import { describe, expect, it } from 'vitest'
import { allStyleRules, allStyles } from './helpers/styles.js'

// Guards the conversation-body link underline (tracker #794): where it SITS (offset + thickness) and its
// restrained hover MOTION. Two complaints drove this: the underline sat too close to the glyphs (it cut
// through the descenders of a mono path), and it snapped into existence instead of easing in.
//
// Both behaviours live in `activity-conversation.css` as `text-decoration` — NOT a border-bottom or a
// box-shadow bar. That distinction is load-bearing: a faked bar sits at the box edge and ignores
// descenders, so the fix would be impossible to express as an offset. This suite therefore also pins
// that the underline stays a real `text-decoration` and that its position is governed by the
// baseline-aware `text-underline-offset`, shared once on the `.md-link` base so the http link and the
// file reference cannot drift apart on where the line sits.
//
// WHY THE ASSERTIONS BIND TO EXACT SELECTORS AND TO DECLARATION BODIES, NOT TO NAMES:
//   - #111: a guard that only checked the selector name existed stayed green when the declaration body
//     was deleted. So every assertion here reads the *body* of its rule and fails when the specific
//     declaration is gone.
//   - #434: a guard using `.some()` was satisfied by a SIBLING rule, letting the target vanish. So we
//     look each selector up by exact normalised equality and assert on that one rule's body.
//   - #349: a ring guard asserted the wrong properties. The properties asserted here are the ones the
//     defect was actually about — the offset and thickness (where the line sits) and the transition
//     (motion) — plus the reveal semantics that make the motion visible.
//
// KNOWN BLIND SPOT (stated so no one mistakes it for coverage): this suite reasons about the STATIC CSS
// text. It does not render the conversation, so it cannot prove the underline is visually clear of a
// particular font's descenders at a particular size — only that the offset property carries a real,
// non-collapsed value and that the animated property is one an engine actually transitions. A visual
// regression that keeps a valid offset but still looks cramped at some zoom is out of its reach.

// Comments are stripped so prose in a rule's explanation cannot register as a declaration (see
// helpers/styles.ts — this is the #409 lesson: a comment quoting a selector once passed as the rule).
const rules = allStyleRules()

type Rule = { selector: string; body: string }

/** Every `selector { body }` pair, selector normalised to single spaces. Nested @-blocks are flat here,
 *  which is fine: the rules this suite targets are all top-level. */
function parseRules(css: string): Rule[] {
  const out: Rule[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@') || selector === '') continue
    out.push({ selector, body: match[2]!.trim() })
  }
  return out
}

/** The one rule whose selector is exactly `selector`. Exact equality is the point: `.md-link--file`
 *  must not be answered by `.md-code .md-link--file`, and `.md-link` must not be answered by any of its
 *  modifiers — that is the sibling-satisfaction hole (#434). */
function ruleFor(selector: string): Rule {
  const matches = parseRules(rules).filter((rule) => rule.selector === selector)
  // Exactly one owner, or the lookup is ambiguous and the assertions below would be reading the wrong body.
  expect(matches.length, `expected exactly one rule for \`${selector}\``).toBe(1)
  return matches[0]!
}

/** The value of `prop` in `body`, or undefined if the declaration is absent. Longhand only. */
function declValue(body: string, prop: string): string | undefined {
  const match = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))
  return match ? match[1]!.trim() : undefined
}

/** Resolve a duration literal or a `var(--token)` reference to milliseconds, reading the token table
 *  from the same concatenated sheet. Returns NaN for anything unrecognised so a bad value fails loudly
 *  rather than passing as 0. */
function durationMs(raw: string): number {
  const varRef = raw.match(/var\(\s*(--[\w-]+)\s*\)/)
  const literal = varRef
    ? allStyles().match(new RegExp(`${varRef[1]}\\s*:\\s*([\\d.]+)(ms|s)`))
    : raw.match(/([\d.]+)(ms|s)/)
  if (!literal) return NaN
  const value = Number(literal[1])
  return literal[2] === 's' ? value * 1000 : value
}

describe('conversation link underline contract (#794)', () => {
  it('scans a non-empty sheet that still carries the two link selectors', () => {
    // A guard that finds zero files, or a sheet that no longer has these classes (renamed, extracted,
    // moved out of @import), would pass every assertion below while protecting nothing — the #683 hole.
    expect(rules.length).toBeGreaterThan(0)
    const selectors = new Set(parseRules(rules).map((rule) => rule.selector))
    expect(selectors.has('.md-link')).toBe(true)
    expect(selectors.has('.md-link--file')).toBe(true)
    expect(selectors.has('.md-link--file:hover')).toBe(true)
  })

  it('draws the underline as text-decoration, never a faked bar', () => {
    // If either link were switched to a border-bottom or an inset box-shadow to fake an underline, the
    // position could no longer be expressed as an offset and this whole contract would be moot. Pin the
    // real mechanism on the base rule the file reference inherits.
    const base = ruleFor('.md-link')
    expect(declValue(base.body, 'text-decoration')).toBe('underline')
    expect(base.body).not.toMatch(/border-bottom|box-shadow/)
    expect(ruleFor('.md-link--file').body).not.toMatch(/border-bottom|box-shadow/)
  })

  it('positions the underline with a real baseline-aware offset on the shared base', () => {
    // POSITION FIX. The offset lives once on `.md-link`; the file reference carries `.md-link` too, so
    // both link kinds inherit the same clearance. Delete this line and the underline falls back to the
    // engine's `auto`, which is what sat inside the descenders — this assertion goes red.
    const offset = declValue(ruleFor('.md-link').body, 'text-underline-offset')
    expect(offset, 'text-underline-offset must be declared on .md-link').toBeDefined()
    const px = Number.parseFloat(offset!)
    // A real value that clears descenders — not 0, not `auto` (NaN), not the cramped 2px it started at.
    expect(px).toBeGreaterThanOrEqual(3)
  })

  it('pins the underline thickness too, since clearance is offset AND weight', () => {
    // The position fix shipped TWO declarations, and this suite originally asserted only one: deleting
    // `text-decoration-thickness` left all five tests green (measured). That is the #111 shape again —
    // a load-bearing declaration with no witness — so it gets its own assertion here.
    //
    // Why thickness belongs to the SAME criterion as the offset rather than being cosmetic: the default
    // is `auto`, which an engine scales with the font size. A line that grows downward from a fixed 3px
    // offset re-enters the descender zone at a larger zoom or font setting, which is exactly the
    // complaint the offset was raised to fix. Pinning the offset while leaving the weight free guards
    // half a mechanism.
    const thickness = declValue(ruleFor('.md-link').body, 'text-decoration-thickness')
    expect(thickness, 'text-decoration-thickness must be declared on .md-link').toBeDefined()
    const px = Number.parseFloat(thickness!)
    // A pinned hairline: a real length (not `auto`/`from-font`, which read as NaN and would reintroduce
    // font-scaled growth), and thin enough that a 3px offset still clears the descenders.
    expect(px).toBeGreaterThan(0)
    expect(px).toBeLessThanOrEqual(2)
  })

  it('keeps the file reference underline hidden at rest and revealed on hover', () => {
    // REVEAL SEMANTICS. The line is always laid out (so hover cannot shift the text), but invisible
    // until hover paints its colour. If the rest colour stops being transparent the underline shows
    // always; if hover stops setting a visible colour there is nothing to ease in.
    const rest = ruleFor('.md-link--file')
    expect(declValue(rest.body, 'text-decoration')).toBe('underline')
    expect(declValue(rest.body, 'text-decoration-color')).toBe('transparent')

    const hover = ruleFor('.md-link--file:hover')
    const hoverColor = declValue(hover.body, 'text-decoration-color')
    expect(hoverColor, ':hover must set text-decoration-color').toBeDefined()
    expect(hoverColor).not.toBe('transparent')
  })

  it('eases the reveal on an animatable property, bounded and restrained', () => {
    // MOTION FIX. `text-decoration` itself does not transition across engines; its COLOUR does (the one
    // engine here is Chromium). The transition must therefore animate `text-decoration-color`, not the
    // shorthand, or hover would snap. Delete the transition and this goes red.
    const transition = declValue(ruleFor('.md-link--file').body, 'transition')
    expect(transition, '.md-link--file must declare a transition').toBeDefined()
    expect(transition).toContain('text-decoration-color')

    // Bounded and restrained: a real duration, > 0 so it actually eases, and short enough not to steal
    // attention. The house cap for a hover micro-interaction is --dur-fast (120ms); 200ms is the ceiling
    // the design SSOT's "克制" allows. A swap to a half-second reveal, or to 0s, fails here.
    const ms = durationMs(transition!)
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(200)
  })
})
