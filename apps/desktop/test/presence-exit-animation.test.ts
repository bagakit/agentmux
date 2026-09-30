import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

// A regression guard for a failure mode that cost three packaging runs and looked nothing like its
// cause. Radix wraps a Dialog/Menu `Content` in `Presence`, which keeps the node MOUNTED after close
// while it waits for `animationend` — it decides an exit is in flight by reading the computed
// `animationName` at close time. An entry animation declared unconditionally is therefore still
// "running" as far as Presence can tell, so it waits for an event that a close never fires, and the
// node lives in the DOM forever: stale menu items keep matching queries, and `Escape` closes nothing
// a test can observe. Each entry must belong to `[data-state='open']`. A deliberate exit may belong
// to `[data-state='closed']` only with a distinct animation name, defined keyframes and an explicit
// finite duration; Presence then receives a real completion. Native Renderer qualification proves
// completion/unmount for those intentional exits, which a static scan alone cannot establish.
//
// This reads the real sheet and the real components rather than rendering, because the bug is a
// static property of the CSS: no jsdom assertion would have caught it (jsdom does not run
// animations), and the packaged-Electron probe caught it only as an unexplained timeout.

const rendererDir = new URL('../src/renderer/src/', import.meta.url)
// Comments are stripped before parsing: they sit between rules, so a naive brace walk would fold a
// comment into the following rule's selector text — enough for prose that merely mentions a class to
// fabricate a match, or to make a real offender's message unreadable.
const styles = allStyles().replace(/\/\*[\s\S]*?\*\//g, '')

// Radix parts whose rendered node is wrapped in `Presence` — verified against the installed
// @radix-ui/react-menu and @radix-ui/react-dialog, which both mount Content/SubContent/Overlay
// through it. Dropdown and context menus are thin wrappers over react-menu, so they inherit it.
const PRESENCE_PARTS = /\b(?:Dialog|DropdownMenu|ContextMenu|Menu|Popover|Tooltip|HoverCard|Select|AlertDialog)\.(?:Content|SubContent|Overlay)\b/g

// Collect every class name the codebase hangs on a Presence-managed node. Deriving this from source
// is the point: a menu added next month is covered without anyone remembering this test exists.
function presenceClassNames(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, dir))
        continue
      }
      if (!entry.name.endsWith('.tsx')) continue
      const file = new URL(entry.name, dir)
      const source = readFileSync(file, 'utf8')
      // A JSX element's attributes can wrap across lines, so scan a window forward from the part name
      // to the tag's own close rather than line by line.
      for (const match of source.matchAll(PRESENCE_PARTS)) {
        const window = source.slice(match.index, match.index + 600)
        const className = /className="([^"]+)"/.exec(window)
        if (!className) continue
        for (const name of className[1]!.trim().split(/\s+/)) {
          const sites = found.get(name) ?? []
          sites.push(join(dir.pathname.split('/renderer/src/')[1] ?? '', entry.name))
          found.set(name, sites)
        }
      }
    }
  }
  walk(rendererDir)
  return found
}

// Every rule in the sheet that declares a keyframe animation, paired with its selector text. Skips
// `animation: none` (a suppression, not an animation) and infinite loops on non-Presence decorations.
function animationRules(): { selector: string; declaration: string }[] {
  const rules: { selector: string; declaration: string }[] = []
  // Walk brace-delimited rule bodies; nested at-rules are entered rather than treated as selectors.
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of styles.matchAll(pattern)) {
    const selector = match[1]!.trim()
    const body = match[2]!
    if (selector.startsWith('@')) continue
    const declaration = /(?:^|[;\s])animation(?:-name)?\s*:\s*([^;]+)/.exec(body)?.[1]?.trim()
    if (!declaration || declaration === 'none') continue
    rules.push({ selector, declaration })
  }
  return rules
}

describe('Radix Presence exit animation', () => {
  it('finds the Presence-managed class names by reading the components, not a hand-kept list', () => {
    const classNames = presenceClassNames()
    // The scan is the whole guard: if it silently found nothing, every assertion below would pass
    // vacuously while the bug walked straight back in.
    expect(classNames.size).toBeGreaterThan(0)
    // The menu base and the dialog are the two Presence surfaces this app actually has today.
    expect([...classNames.keys()]).toContain('tab-context-menu')
    expect([...classNames.keys()]).toContain('confirmation-dialog')
  })

  it('scopes Presence animations to open entry or an explicit distinct finite closed exit', () => {
    const classNames = presenceClassNames()
    expect(classNames.size).toBeGreaterThan(0)
    const rules = animationRules()
    expect(rules.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const { selector: selectors, declaration } of rules) for (const selector of selectors.split(',')) {
      for (const [className, sites] of classNames) {
        // Match the class as a whole token so `.tab-context-menu__item` does not read as
        // `.tab-context-menu`; only the Presence node itself is under this rule.
        if (!new RegExp(`\\.${className}(?![\\w-])`).test(selector)) continue
        if (selector.includes("data-state='open'") || selector.includes('data-state="open"')) continue
        if (selector.includes("data-state='closed'") || selector.includes('data-state="closed"')) {
          const name = declaration.split(/\s+/)[0]!
          const durations = [...declaration.matchAll(/(?:^|\s)(\d+(?:\.\d+)?(?:ms|s))\b|var\((--[\w-]+)\)/g)].map(match => {
            const value = match[1] ?? new RegExp(`${match[2]}\\s*:\\s*([\\d.]+(?:ms|s))`).exec(styles)?.[1]
            return value ? Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000) : 0
          })
          const entries = rules.filter(rule => new RegExp(`\\.${className}(?![\\w-])`).test(rule.selector)
            && /data-state=['"]open['"]/.test(rule.selector))
          expect(entries.length).toBeGreaterThan(0)
          const hasKeyframes = new RegExp(`@keyframes\\s+${name}\\s*\\{`).test(styles)
          if (hasKeyframes && durations.some(duration => Number.isFinite(duration) && duration > 0) && !/\binfinite\b/.test(declaration)
            && entries.every(entry => entry.declaration.split(/\s+/)[0] !== name)) continue
        }
        offenders.push(
          `${selector} { animation: ${declaration} } — .${className} is Presence-managed ` +
            `(${[...new Set(sites)].join(', ')}). An open entry or distinct, explicitly finite ` +
            'closed exit is required; otherwise Presence can wait for a completion that never fires.'
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it('still animates the menu on entry, so the guard cannot be satisfied by deleting the animation', () => {
    // The fix is scoping, not removal: the menu must still grow from the pointer. Asserting the
    // animation survives keeps a future "fix" from passing the rule above by dropping the motion.
    const scoped = animationRules().filter(
      ({ selector }) =>
        /\.tab-context-menu(?![\w-])/.test(selector) && selector.includes("data-state='open'")
    )
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.declaration).toContain('menu-in')
  })
})
