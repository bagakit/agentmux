import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

// Guards the radius clause of the surface contract (docs/design/agentmux-surface-density.md).
//
// The contract used to say radii come only from --radius-sm/--radius/--radius-lg, with a vague
// carve-out for "status dots and micro-badges". The sheet actually hardcodes 24 sub-token radii, and
// most are neither dots nor badges — Tree Row, the tab close button, pane actions. So the doc asserted
// something the code did not do, which is worse than either choice: a maintainer retuning --radius-sm
// would find a dozen controls silently not following.
//
// The values are deliberate — a 24px icon button at 6px reads as a pill — so the contract now names
// the two exception classes instead of pretending they do not exist, and this test holds the line:
// every sub-token radius must belong to a declared exception. A new hardcoded radius on a surface-level
// container (card, menu, dialog, input, dock) has to either use a token or be argued into this list.

// Comments are stripped so prose mentioning a radius cannot register as a rule.
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

// The smallest token. Anything below this is a hardcoded exception by definition.
const SMALLEST_TOKEN_PX = 6

// Class 1 — compact interactive controls: 24px icon buttons, dense rows, close affordances.
const COMPACT_CONTROLS = [
  '.surface-switch button',
  '.explorer-header__actions button, .file-search button',
  '.file-tree-root-target',
  '.file-tree-drag-preview',
  '.tree-row',
  '.tree-row__actions button',
  '.tree-inline-input',
  '.file-row',
  '.workbench-tab-strip__nav',
  '.workbench-tab__close',
  '.pane-action',
  '.pane-view-toggle button',
  '.workbench-region__close',
  '.pane-drop-overlay span',
  '.terminal-replay-gap > button'
]

// Class 2 — micro marks and decoration: hairlines, ruler ticks, icon corners, selection marks.
const MICRO_MARKS = [
  '.workspace-tools-resize-handle::after',
  '.agent-provider-icon > img',
  '.activity-ruler__rail',
  '.activity-ruler__tick',
  '.activity-ruler__band',
  '.agent-pick--selected::before',
  '.terminal-theme-preview__composer',
  // 10px 高的进度轨（workflow.css:73）。--radius-sm 的 6px 在这个高度上把两端啃成半圆，读起来是
  // 一颗胶囊而不是一条轨。与上面 activity-ruler 那三条同类：量级只有几像素的装饰性刻度。
  '.wf-rail'
]

const DECLARED_EXCEPTIONS = new Set([...COMPACT_CONTROLS, ...MICRO_MARKS])

type RadiusRule = { selector: string; px: number }

// Collect every border-radius below the smallest token, paired with the selector that owns it.
function subTokenRadii(): RadiusRule[] {
  const rules: RadiusRule[] = []
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, ' ')
    if (selector.startsWith('@')) continue
    for (const declaration of match[2]!.matchAll(/border-radius:\s*([^;]+)/g)) {
      // A shorthand can carry several values; the smallest one is what decides the corner.
      for (const raw of declaration[1]!.matchAll(/(\d+)px/g)) {
        const px = Number(raw[1])
        if (px < SMALLEST_TOKEN_PX) rules.push({ selector, px })
      }
    }
  }
  return rules
}

describe('surface radius contract', () => {
  it('finds the sub-token radii by reading the sheet, not a hand-kept list', () => {
    // If the scan found nothing, every assertion below would pass while saying nothing at all.
    expect(subTokenRadii().length).toBeGreaterThan(0)
  })

  it('allows a sub-token radius only on a declared compact control or micro mark', () => {
    const undeclared = subTokenRadii()
      .filter((rule) => !DECLARED_EXCEPTIONS.has(rule.selector))
      .map((rule) => `${rule.selector} { border-radius: ${rule.px}px }`)

    // The message a future maintainer sees: use a token, or argue the selector into the contract.
    expect(undeclared).toEqual([])
  })

  it('keeps no exception for a rule that no longer has a sub-token radius', () => {
    // The reverse direction, and the reason this test exists: the check above only asks whether every
    // sub-token radius is excused. It says nothing about an excuse whose rule is gone. Delete a rule and
    // its line here lingers as a standing permission for a selector nobody can see any more — which is
    // exactly how `.open-destination-menu__item > svg:last-child` outlived the entire
    // `.open-destination-menu*` block it belonged to, invisibly, until someone read the list by hand.
    //
    // Asserted as set equality rather than "the selector appears somewhere in the sheet": a selector can
    // easily still exist while its sub-token radius has been retuned up to a token, and that is the
    // common case — a stale permission, not a missing selector. Equality also means the list cannot grow
    // a speculative entry ahead of the rule it excuses.
    const excused = new Set(subTokenRadii().map((rule) => rule.selector))
    const stale = [...DECLARED_EXCEPTIONS].filter((selector) => !excused.has(selector)).sort()
    expect(stale).toEqual([])
  })

  it('keeps the three tokens defined, since the exceptions are relative to them', () => {
    for (const token of ['--radius-sm', '--radius', '--radius-lg']) {
      expect(styles).toContain(`${token}:`)
    }
    // The smallest token must stay at the value the exception classes were judged against; moving it
    // silently would change what "sub-token" even means here.
    expect(styles).toMatch(/--radius-sm:\s*6px/)
  })

  it('does not let a surface-level container claim an exception', () => {
    // The contract restricts exceptions to compact controls and micro marks. These container-ish
    // patterns must never appear in the exception list, or the rule would be meaningless.
    const containerish = /(^|\s)\.(confirmation-dialog|tab-context-menu|quick-switch|agent-interaction)\b/
    for (const selector of DECLARED_EXCEPTIONS) {
      expect(selector).not.toMatch(containerish)
    }
  })
})
