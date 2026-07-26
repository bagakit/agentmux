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
  '.terminal-replay-gap > button',
  '.new-tab-surface kbd'
]

// Class 2 — micro marks and decoration: hairlines, ruler ticks, icon corners, selection marks.
const MICRO_MARKS = [
  '.workspace-tools-resize-handle::after',
  '.open-destination-menu__item > svg:last-child',
  '.agent-provider-icon > img',
  '.activity-ruler__rail',
  '.activity-ruler__tick',
  '.activity-ruler__band',
  '.agent-pick--selected::before',
  '.terminal-theme-preview__composer'
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
