import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

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

/**
 * The single definition of a custom property, e.g. `--dur-fast`. Asserts there is EXACTLY one:
 * a regex search over the concatenated sheet silently binds to the FIRST definition, so a second
 * one (a theme override, a media block) would make every value read here a coin flip on file order.
 *
 * READS THE COMMENT-STRIPPED TABLE (`rules`), not the raw sheet. Measured: an unrelated comment that
 * merely NAMES a token above the real declaration (e.g. a `--scrim-1` mention in prose) was counted as
 * a second "definition" and turned this loud one-definition guard into a FALSE RED. Comments are prose,
 * not declarations — the same #409 lesson the rest of this suite already obeys by reading `rules`.
 */
function tokenValue(token: string): string {
  const definitions = [...rules.matchAll(new RegExp(`${token}\\s*:\\s*([^;}]+)`, 'g'))].map((m) =>
    m[1]!.trim()
  )
  expect(
    definitions.length,
    `\`${token}\` 在整张表里有 ${definitions.length} 处定义。正则取值只会绑到第一处，` +
      '于是下面读到的值取决于文件拼接顺序而不是级联——这道判据会静默读错那一份。'
  ).toBe(1)
  return definitions[0]!
}

/**
 * A colour's alpha in [0,1], or NaN if unrecognised (so an unknown spelling fails loudly instead of
 * silently reading as opaque).
 *
 * WHY THIS EXISTS RATHER THAN `!== 'transparent'` (measured, not theorised): the reveal assertion
 * below used to string-compare against the literal `transparent`. `rgba(0,0,0,0)`, `#0000`,
 * `#00000000` and `hsla(0,0%,0%,0)` are all FULLY invisible and all pass that comparison — so the
 * suite's central promise (the underline appears on hover) shipped with nothing guarding it. Alpha
 * is the property the promise is actually about, so alpha is what gets read.
 *
 * `currentColor` IS NOT ASSUMED OPAQUE (measured): the hover rule paints the underline with
 * `text-decoration-color: currentColor`, and `currentColor` == the element's own computed `color`.
 * A mutation that set `color: transparent` on the same rule made the underline fully invisible while
 * this suite stayed green, because `currentColor` was hard-coded to alpha 1. So a caller resolving a
 * `currentColor` MUST pass `resolveCurrentColor`, which returns the effective `color` for that rule;
 * we then read ITS alpha. If the resolver cannot find one (colour inherited from a DOM ancestor this
 * static suite cannot see, or no resolver supplied at all) the result is NaN — LOUD — never a silent 1.
 */
function alphaOf(raw: string, resolveCurrentColor?: () => string | undefined): number {
  const value = raw.trim()
  const varRef = value.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (varRef) return alphaOf(tokenValue(varRef[1]!))
  if (/^transparent$/i.test(value)) return 0
  if (/^currentColor$/i.test(value)) {
    const resolved = resolveCurrentColor?.()
    // Unresolvable currentColor is NOT opaque-by-default: this repo has a long history of guards that
    // default to "fine" and go blind, and this is exactly that spot. NaN turns the caller's assertion red.
    if (resolved === undefined) return Number.NaN
    return alphaOf(resolved, resolveCurrentColor)
  }
  const hex = value.match(/^#([0-9a-f]+)$/i)
  if (hex) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 6) return 1
    if (digits.length === 4) return Number.parseInt(digits[3]!.repeat(2), 16) / 255
    if (digits.length === 8) return Number.parseInt(digits.slice(6), 16) / 255
    return Number.NaN
  }
  // rgb()/rgba()/hsl()/hsla(). Three spellings of the same colour must parse identically:
  // legacy commas `rgb(0,0,0,0)`, the modern space-separated CSS Color 4 form `rgb(0 0 0 / 0)`, and
  // the mixed slash form. WHITESPACE IS A SEPARATOR HERE, not decoration — splitting only on `[,/]`
  // read `rgb(0 0 0 / 0)` as the two parts `0 0 0` and `0`, fell into the `length <= 3` arm and
  // returned 1, so a FULLY INVISIBLE hover underline shipped green. This repo already writes the
  // space-separated form elsewhere (conversation-avatar.css uses `hsl(143 61 72)`), so that is not a
  // hypothetical spelling. The alpha is the 4th component in every one of the three forms.
  const fn = value.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/i)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter((p) => p.length > 0)
    if (parts.length <= 3) return 1
    const alpha = parts[3]!
    const percent = alpha.match(/^([\d.]+)%$/)
    return percent ? Number(percent[1]) / 100 : Number(alpha)
  }
  // A bare named colour (`red`, `black`, …) is opaque. Anything else is unknown → NaN → loud.
  return /^[a-z]+$/i.test(value) ? 1 : Number.NaN
}

/**
 * The colour a `currentColor` resolves to on a given element, or undefined when it cannot be resolved
 * from the static sheet (which must fail LOUD, never default to opaque).
 *
 * `currentColor` == the element's *computed* `color`, and the winning `color` is the one from the MOST
 * SPECIFIC matching rule that DECLARES it. `chain` lists that element's selectors most-specific-first
 * (e.g. `['.md-link--file:hover', '.md-link--file', '.md-link']` — the file link carries both classes
 * and, on hover, the pseudo). We take the first rule that DECLARES a colour — not the first CONCRETE
 * one: if the most specific declarer says `inherit`, the colour genuinely comes from a DOM ancestor
 * this static suite cannot see, so we return undefined rather than fall through to a less-specific
 * concrete colour the cascade has already overridden (that would be a lie). A declared `currentColor`
 * would be circular, so it too yields undefined.
 *
 * BLIND SPOT THAT REMAINS: `chain` is supplied by the caller and its order STANDS IN FOR real CSS
 * specificity. This does not compute specificity, so a colour applied to the same element through a
 * different higher-specificity selector (an id, `[attr]`, a descendant combinator) is not consulted;
 * and it only sees `color` set within this stylesheet, never a JS/inline `style` colour.
 */
function effectiveColor(chain: string[]): string | undefined {
  const parsed = parseRules(rules)
  for (const selector of chain) {
    const rule = parsed.find((r) => r.selector === selector)
    if (!rule) continue
    const color = declValue(rule.body, 'color')
    if (color === undefined) continue
    if (/^inherit$/i.test(color)) return undefined
    if (/^currentColor$/i.test(color)) return undefined
    return color
  }
  return undefined
}

/**
 * Split a `transition` shorthand into its comma-separated segments, ignoring commas nested inside
 * parentheses — `steps(1, end)` and `cubic-bezier(.4, 0, .2, 1)` each contain one, so a naive
 * `.split(',')` would cut a timing function in half and make every reading below nonsense.
 */
function transitionSegments(transition: string): string[] {
  const segments: string[] = []
  let depth = 0
  let current = ''
  for (const ch of transition) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      segments.push(current.trim())
      current = ''
    } else current += ch
  }
  segments.push(current.trim())
  return segments.filter((segment) => segment.length > 0)
}

/**
 * The transition value to read for a rule: the `transition` shorthand if it is declared, otherwise a
 * shorthand SYNTHESISED from the `transition-property` / `-duration` / `-timing-function` longhands.
 *
 * WHY THE FALLBACK (measured false-red): the reader below only consulted the shorthand, so rewriting
 * the SAME transition as its three longhands — semantically identical CSS — turned this suite red for a
 * change that broke nothing. Author's choice of shorthand vs longhands is not something this contract
 * should have an opinion about. The longhand lists are comma-zipped back into shorthand segments so the
 * segment/duration/timing readers work identically either way. Returns undefined only when NEITHER the
 * shorthand nor a property+duration longhand pair exists — i.e. there is genuinely no transition.
 */
function transitionValue(body: string): string | undefined {
  const shorthand = declValue(body, 'transition')
  if (shorthand !== undefined) return shorthand
  const properties = declValue(body, 'transition-property')
  const durations = declValue(body, 'transition-duration')
  const timings = declValue(body, 'transition-timing-function')
  // A transition animates nothing without both a property target and a duration; if neither longhand is
  // present there is no transition to read, and the caller's `toBeDefined()` fails loudly.
  if (properties === undefined && durations === undefined) return undefined
  const propList = transitionSegments(properties ?? 'all')
  const durList = transitionSegments(durations ?? '0s')
  const timingList = transitionSegments(timings ?? 'ease')
  const count = Math.max(propList.length, durList.length, timingList.length, 1)
  const segments: string[] = []
  for (let i = 0; i < count; i += 1) {
    // CSS repeats a shorter longhand list to match the longest; mirror that with modulo so a single
    // duration/timing applies to every property, exactly as the browser would compute it.
    const prop = propList[i % propList.length] ?? 'all'
    const dur = durList[i % durList.length] ?? '0s'
    const timing = timingList[i % timingList.length] ?? 'ease'
    segments.push(`${prop} ${dur} ${timing}`)
  }
  return segments.join(', ')
}

/**
 * The `transition-property` identifier at the head of one shorthand segment, lowercased, or undefined
 * when the segment names none (property omitted → CSS defaults it to `all`). Time values, bare numbers
 * and easing functions are skipped so the FIRST real ident is returned; parenthesised groups
 * (`cubic-bezier(...)`, `steps(...)`, `var(...)`) are blanked first so their commas and inner tokens
 * cannot masquerade as a property name.
 */
function transitionPropertyToken(segment: string): string | undefined {
  const withoutGroups = segment.replace(/\([^)]*\)/g, ' ')
  for (const token of withoutGroups.trim().split(/[\s,]+/).filter((t) => t.length > 0)) {
    if (/^[\d.]/.test(token)) continue // a <time> (120ms, .2s) or bare number (delay/count)
    if (/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|steps|cubic-bezier|var)$/i.test(token))
      continue
    return token.toLowerCase()
  }
  return undefined
}

/** Whether one shorthand segment animates `prop`: it names `prop`, names `all`, or names no property
 *  at all (omitted, which the cascade treats as `all`). */
function segmentCoversProp(segment: string, prop: string): boolean {
  if (new RegExp(`(?:^|[\\s,])${prop}(?=$|[\\s,])`).test(segment)) return true
  const token = transitionPropertyToken(segment)
  return token === undefined || token === 'all'
}

/**
 * The one segment of a `transition` shorthand that animates `prop`. Asserts exactly one: reading a
 * duration or timing function off the whole shorthand would silently pick up a SIBLING property's
 * values once a second transition is added. A segment counts if it names `prop`, names `all`, or omits
 * the property (which the cascade also treats as `all`) — an `all`/omitted rule really does animate
 * `text-decoration-color`, so pinning only the explicit spelling false-reds a valid `all` transition.
 */
function transitionFor(transition: string, prop: string): string {
  const matches = transitionSegments(transition).filter((segment) => segmentCoversProp(segment, prop))
  expect(
    matches.length,
    `\`transition: ${transition}\` 里过渡 \`${prop}\` 的段落有 ${matches.length} 个（要恰好 1 个）。` +
      '0 个＝这个属性根本没被过渡，hover 会瞬跳；多个＝下面读到的时长/曲线取决于书写顺序。'
  ).toBe(1)
  return matches[0]!
}

/** Resolve a duration literal or a `var(--token)` reference to milliseconds. NaN if unrecognised. */
function durationMs(raw: string): number {
  const varRef = raw.match(/var\(\s*(--[\w-]+)\s*\)/)
  const literal = (varRef ? tokenValue(varRef[1]!) : raw).match(/([\d.]+)(ms|s)\b/)
  if (!literal) return Number.NaN
  const value = Number(literal[1])
  return literal[2] === 's' ? value * 1000 : value
}

/**
 * The timing function named in one transition segment, lowercased, or undefined if the segment names
 * none (which means the CSS default, `ease`).
 *
 * Needed because a duration alone says nothing about motion: `steps(1, end)` snaps to the end state
 * with a perfectly valid 120ms duration, which defeats "克制的淡入" while every duration assertion
 * stays green.
 *
 * THE BOUNDARY IS A LOOKAHEAD, NOT `\b` (measured): this function's first version ended the pattern
 * with `\b`, and `\b` cannot match between a `)` and end-of-string — both are non-word characters.
 * So `steps(1, end)` and every `cubic-bezier(...)` read as "no timing function declared" and fell
 * into the permitted default-`ease` branch. The `steps(1, end)` mutation shipped green because of
 * that bug, not because the assertion was wrong. A guard's own parser is part of the guard.
 */
function timingFunctionOf(segment: string): string | undefined {
  const match = segment
    .toLowerCase()
    .match(
      /(?:^|[\s,])(linear|ease-in-out|ease-in|ease-out|ease|step-start|step-end|cubic-bezier\([^)]*\)|steps\([^)]*\))(?=$|[\s,])/
    )
  return match ? match[1] : undefined
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
    //
    // BOTH SIDES ARE JUDGED BY ALPHA, NOT BY THE WORD `transparent`. This assertion used to read
    // `expect(hoverColor).not.toBe('transparent')`, and that was measured green while the underline
    // was fully invisible: `rgba(0,0,0,0)`, `#0000`, `#00000000`, `hsla(0,0%,0%,0)` are all
    // zero-opacity spellings that pass a string comparison. Alpha is what the promise is about.
    const rest = ruleFor('.md-link--file')
    expect(declValue(rest.body, 'text-decoration')).toBe('underline')
    const restColor = declValue(rest.body, 'text-decoration-color')
    expect(restColor, 'at rest .md-link--file must declare a text-decoration-color').toBeDefined()
    expect(
      alphaOf(restColor!),
      `静息态的 text-decoration-color 是 \`${restColor}\`（alpha=${alphaOf(restColor!)}）。` +
        '它必须完全透明，否则下划线在不 hover 时也一直显形——那正是这条契约要防的另一侧。'
    ).toBe(0)

    const hover = ruleFor('.md-link--file:hover')
    const hoverColor = declValue(hover.body, 'text-decoration-color')
    expect(hoverColor, ':hover must set text-decoration-color').toBeDefined()
    // The hover underline is painted with `currentColor`, so its visibility is hostage to the SAME
    // rule's `color`. Resolve it: `.md-link--file:hover` sets `color`, so currentColor takes that; if a
    // future edit makes that colour transparent (measured mutation), alphaOf reads 0 here and this goes
    // red. The chain is most-specific-first — the hover pseudo, then the two classes it also carries.
    const resolveHoverColor = () =>
      effectiveColor(['.md-link--file:hover', '.md-link--file', '.md-link'])
    expect(
      alphaOf(hoverColor!, resolveHoverColor),
      `hover 态的 text-decoration-color 是 \`${hoverColor}\`，解析出的 alpha 是 ` +
        `${alphaOf(hoverColor!, resolveHoverColor)}。这道判据读 alpha 而不是跟字面量 \`transparent\` 比串：` +
        'rgba(0,0,0,0)/#0000/hsla(0,0%,0%,0) 都完全看不见却都能通过串比较（实测全绿），' +
        '于是本套件的中心承诺「hover 才显形」会在无人守的情况下发货。而 `currentColor` 不再被假设为不透明：' +
        '它取本规则自己的 `color`，一旦那被改成 transparent，下划线就完全隐形——所以这里把 currentColor ' +
        '解引用到有效 color 再读它的 alpha。NaN 表示颜色写法没被认出、或 color 从看不见的 DOM 祖先继承而来，' +
        '同样当成不合格——宁可响亮地红，也不要按「未知即不透明」放过去。'
    ).toBe(1)
  })

  it('eases the reveal on an animatable property, bounded and restrained', () => {
    // MOTION FIX. `text-decoration` itself does not transition across engines; its COLOUR does (the one
    // engine here is Chromium). The transition must therefore animate `text-decoration-color`, not the
    // shorthand, or hover would snap. Delete the transition and this goes red.
    //
    // Read via transitionValue(), which accepts EITHER the `transition` shorthand OR the equivalent
    // `transition-property`/`-duration`/`-timing-function` longhands — the two are semantically the
    // same CSS, so a valid rewrite from one to the other must not false-red this contract.
    const transition = transitionValue(ruleFor('.md-link--file').body)
    expect(transition, '.md-link--file must declare a transition (shorthand or longhands)').toBeDefined()

    // Everything below is read off the ONE segment that animates the colour, not off the whole
    // shorthand: once a second property is transitioned here, a shorthand-wide regex would happily
    // read the sibling's duration and the sibling's curve. transitionFor() also subsumes the old
    // `toContain('text-decoration-color')` check — zero matching segments is a loud failure there.
    const colorTransition = transitionFor(transition!, 'text-decoration-color')

    // Bounded and restrained: a real duration, long enough to be perceptible as a fade, and short
    // enough not to steal attention. The house value for a hover micro-interaction is --dur-fast
    // (120ms); 200ms is the ceiling the design SSOT's "克制" allows. A swap to a half-second reveal
    // fails here, and so does a token swap down to a duration no eye can resolve.
    //
    // THE LOWER BOUND IS 40ms, NOT 0. `> 0` admitted `1ms`, which is a snap wearing a transition's
    // clothes — measured green against exactly the change this test exists to catch.
    const ms = durationMs(colorTransition)
    expect(ms, `解析出的过渡时长是 ${ms}ms（段落：\`${colorTransition}\`）`).toBeGreaterThanOrEqual(40)
    expect(ms).toBeLessThanOrEqual(200)

    // A DURATION IS NOT MOTION. `steps(1, end)` snaps to the end state with a perfectly valid 120ms
    // duration — every duration assertion above stays green while the fade is gone. So the timing
    // function is read too, and step-like functions are rejected by name.
    const timing = timingFunctionOf(colorTransition)
    expect(
      timing === undefined || !/^steps?\(|^step-(start|end)$/.test(timing),
      `过渡的 timing function 是 \`${timing}\`。steps()/step-start/step-end 会在时长内瞬跳，` +
        '「克制的淡入」于是消失，而所有时长断言照旧全绿——所以这里按函数类型判，不只按时长判。' +
        '（省略 timing function 等于 CSS 默认的 ease，是允许的。）'
    ).toBe(true)
  })

  it('自检：alphaOf 对每一族颜色写法都读出真的 alpha，尤其是空格分隔的现代写法', () => {
    // 为什么这条断言存在，以及为什么它单独一个 it：上面的 reveal 判据把「hover 才显形」这件事**完全**
    // 委托给 alphaOf，而 alphaOf 此前是本文件三个解析器里唯一没有任何见证的一个——于是它自己的 bug
    // 就是那条中心承诺的静默漏点。实测的那个 bug：切分只认 `[,/]`，于是 CSS Color 4 的空格写法
    // `rgb(0 0 0 / 0)` 被切成 `0 0 0` 与 `0` 两段，落进 `length <= 3` 那条「没写 alpha 即不透明」
    // 的臂里返回 1。一条**完全看不见**的 hover 下划线于是在 7 条全绿下发货。本仓的 CSS 已经在用
    // 空格写法（conversation-avatar.css 的 `hsl(143 61 72)`），所以那不是个假想的拼法。
    //
    // 判据的解析器是判据的一部分，所以每一族写法在这里被直接质询，而不是等下一次靠变异碰巧发现。

    // 零透明度的每一种拼法都必须读成 0。这几个串全都能通过 `!== 'transparent'` 的串比较（那正是
    // 这个函数取代的那版判据），所以它们是这道门真正要挡住的输入。
    for (const invisible of [
      'transparent',
      'rgba(0,0,0,0)',
      'rgb(0 0 0 / 0)',
      'hsla(0,0%,0%,0)',
      'hsl(0 0% 0% / 0)',
      'hsl(0 0% 0% / 0%)',
      '#0000',
      '#00000000'
    ]) {
      expect(alphaOf(invisible), `\`${invisible}\` 是完全透明的，alphaOf 必须读出 0`).toBe(0)
    }

    // 不透明的每一种拼法都必须读成 1——反向那侧同样要认得出，否则「hover 设了可见颜色」这条断言
    // 会对合法的 CSS 打假红。（`currentColor` 不在此列：它现在必须靠 resolver 解引用，见下面单独一段。）
    for (const opaque of [
      '#abc',
      '#aabbcc',
      '#aabbccff',
      'rgb(1,2,3)',
      'rgb(1 2 3)',
      'rgb(1 2 3 / 1)',
      'hsl(120 50% 50%)',
      'hsl(120 50% 50% / 100%)',
      'black'
    ]) {
      expect(alphaOf(opaque), `\`${opaque}\` 是不透明的，alphaOf 必须读出 1`).toBe(1)
    }

    // `currentColor` 不再按 fiat 当成不透明——这正是本轮修掉的那个漏点：hover 用
    // `text-decoration-color: currentColor` 上色，而 currentColor 取本规则自己的 `color`；一旦
    // 那个 color 被改成 transparent，下划线**完全隐形**，可 alphaOf('currentColor') 却硬编码返回 1，
    // 于是那次变异在 8 条全绿下发货。现在的契约是：
    //   1) 没有 resolver 时，currentColor 是**不可解**的 → 必须是 NaN（响亮），绝不静默当 1。
    //      有人若把实现改回 `return 1` 的旧 fiat，这条会立刻红。
    expect(
      alphaOf('currentColor'),
      'currentColor 没有 resolver 时不可解，必须是 NaN；返回 1 就是本轮修掉的那个 fiat 漏点'
    ).toBeNaN()
    //   2) 有 resolver 时，解引用到有效 color 再读它的 alpha——不透明的 color 给 1，透明的给 0。
    expect(alphaOf('currentColor', () => 'var(--green)'), '解引用到不透明 color → 1').toBe(1)
    expect(
      alphaOf('currentColor', () => 'transparent'),
      '解引用到 transparent color → 0（这就是 color:transparent 变异被读出隐形的那条路径）'
    ).toBe(0)
    //   3) resolver 说 color 从看不见的 DOM 祖先继承而来（undefined），同样不可解 → NaN，不许兜成 1。
    expect(
      alphaOf('currentColor', () => undefined),
      'color 从看不见的祖先继承（resolver 返回 undefined）→ NaN，不许默认不透明'
    ).toBeNaN()

    // 中间值必须真的按数值读，而不是被折成 0/1 的两极。
    expect(alphaOf('rgba(0,0,0,0.5)')).toBe(0.5)
    expect(alphaOf('rgb(0 0 0 / 0.5)')).toBe(0.5)
    expect(alphaOf('rgb(0 0 0 / 50%)')).toBe(0.5)
    expect(alphaOf('#00000080')).toBeCloseTo(128 / 255, 5)

    // 认不出的写法必须是 NaN 而不是 1。「未知即不透明」会让一个笔误的颜色值静默通过 reveal 判据。
    expect(alphaOf('color-mix(in srgb, red, blue)'), '没被认出的写法必须响亮地是 NaN').toBeNaN()

    // var() 必须真的解引用下去。这条见证**自带前提自检**：先钉住这个 token 确实是半透明的，否则一旦
    // 它被改成不透明，下面那条 var() 见证会静默退化成「1 === 1」，读起来仍像在证明解析发生过——那正是
    // 本 session 修掉的那类虚构见证。
    //
    // 前提判据守的是**半透明本身**（0 < alpha < 1），不是某一种写法。早先这里钉的是「必须是八位十六进制
    // `#rrggbbaa`」，那把一个合法的等价改写（比如 `rgba(0, 0, 0, 0.25)`，本仓别处已在用
    // `hsl(... / 0.18)` 这类）打成假红，尽管它一样半透明、一样能让下面的 var() 见证成立。直接判 alpha
    // 落在开区间 (0,1)：不透明的替换（alpha=1）仍会红——它让下面退化成恒真——而任何仍半透明的改写都放行。
    const scrim = tokenValue('--scrim-1')
    const scrimAlpha = alphaOf(scrim)
    expect(
      scrimAlpha > 0 && scrimAlpha < 1,
      `--scrim-1 现在是 \`${scrim}\`（alpha=${scrimAlpha}）。它必须是半透明（0<alpha<1），否则下面那条 ` +
        'var() 见证不再证明解引用发生了——换一个仍然半透明的 token（任何写法都行），别让它退化成恒真。'
    ).toBe(true)
    const resolved = alphaOf('var(--scrim-1)')
    expect(resolved, 'var() 没有被解引用到 token 的字面值').toBeGreaterThan(0)
    expect(resolved).toBeLessThan(1)
  })

  it('自检：本文件的两个 transition 解析器认得出它们各自要拒绝的形状', () => {
    // 为什么需要这条：上面那条断言的第一版**因为解析器自己的 bug 而假绿**。
    // `timingFunctionOf` 当时用 `\b` 收尾，而 `\b` 永远匹配不到 `)` 与串尾之间（两个都是非词字符），
    // 于是 `steps(1, end)` 被读成「没写 timing function」，掉进「省略即默认 ease」那条许可分支——
    // 真实变异（把 ease 换成 steps(1, end)）在 6 条全绿下存活。判据的解析器是判据的一部分，
    // 所以这里拿它必须认出的形状直接质询它，而不是等下一次靠变异碰巧发现。
    expect(timingFunctionOf('text-decoration-color 120ms steps(1, end)')).toBe('steps(1, end)')
    expect(timingFunctionOf('text-decoration-color 120ms step-end')).toBe('step-end')
    expect(timingFunctionOf('text-decoration-color 120ms cubic-bezier(.4, 0, .2, 1)')).toBe(
      'cubic-bezier(.4, 0, .2, 1)'
    )
    expect(timingFunctionOf('text-decoration-color 120ms ease')).toBe('ease')
    expect(timingFunctionOf('text-decoration-color 120ms')).toBeUndefined()
    // `ease` 不能被 `ease-in-out` 的前缀吃掉，也不能被属性名里的字母碰上。
    expect(timingFunctionOf('text-decoration-color 120ms ease-in-out')).toBe('ease-in-out')

    // 逗号切分必须认括号：`steps(1, end)` 自带一个逗号，天真的 split(',') 会把它劈成两段，
    // 于是「恰好一个段落过渡这个属性」这条判据读到的东西完全没有意义。
    expect(transitionSegments('color 1ms ease, text-decoration-color 120ms steps(1, end)')).toEqual([
      'color 1ms ease',
      'text-decoration-color 120ms steps(1, end)'
    ])
    // 属性名按整词匹配：`text-decoration` 不该被 `text-decoration-color` 那段答复。
    expect(transitionFor('text-decoration-color 120ms ease', 'text-decoration-color')).toBe(
      'text-decoration-color 120ms ease'
    )

    // `all`（以及省略属性名，级联同样当成 all）的段落确实过渡 text-decoration-color——只钉显式拼法会把
    // 合法的 `all` 过渡打成假红。这两种都必须被 transitionFor 认成「覆盖了这个属性」。
    expect(transitionFor('all var(--dur-fast) ease', 'text-decoration-color')).toBe(
      'all var(--dur-fast) ease'
    )
    expect(segmentCoversProp('all 120ms ease', 'text-decoration-color')).toBe(true)
    expect(segmentCoversProp('120ms ease', 'text-decoration-color')).toBe(true) // 省略属性＝all
    // 但一个**具名的别的属性**不覆盖：否则「恰好一个段落过渡这个属性」这条判据会把 sibling 的时长读进来。
    expect(segmentCoversProp('color 120ms ease', 'text-decoration-color')).toBe(false)
    // 括号里的逗号/内部 token 不能冒充属性名。
    expect(transitionPropertyToken('color 120ms cubic-bezier(.4, 0, .2, 1)')).toBe('color')
    expect(transitionPropertyToken('120ms steps(1, end)')).toBeUndefined() // 省略属性

    // transitionValue：shorthand 在场就用 shorthand；不在场则从三条 longhand 合成等价 shorthand，
    // 于是「把 transition 拆成 transition-property/-duration/-timing-function」这个语义等价的改写不再假红。
    // 缺省 longhand 用 CSS 默认补齐，短列表按 CSS 规则循环补齐到最长。
    expect(transitionValue('transition: text-decoration-color 120ms ease;')).toBe(
      'text-decoration-color 120ms ease'
    )
    expect(
      transitionValue(
        'transition-property: text-decoration-color; transition-duration: 120ms; transition-timing-function: ease;'
      )
    ).toBe('text-decoration-color 120ms ease')
    // 只有 property 没有 duration 也当作有过渡在场（duration 默认 0s，让下游时长判据去响亮地拒绝），
    // 而两者皆无才是「根本没有过渡」→ undefined，让调用方的 toBeDefined() 响亮地红。
    expect(transitionValue('color: var(--green);')).toBeUndefined()
  })
})
