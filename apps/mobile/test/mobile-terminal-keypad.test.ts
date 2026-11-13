import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const postcss = createRequire(realpathSync(require.resolve('vite/package.json')))('postcss')
const viewer = readFileSync(require.resolve('../src/terminal/MobileTerminalViewer.tsx'), 'utf8')
const css = postcss.parse(readFileSync(require.resolve('../src/terminal/terminal.css'), 'utf8'))
function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined
  css.walkRules((rule: any) => { if (rule.selector === selector) rule.walkDecls(property, (decl: any) => { value = decl.value }) })
  return value
}

describe('the phone terminal keypad', () => {
  it('keeps the stop and navigation keys on a fixed 7-column grid with original terminal encodings', () => {
    const table = /const MOBILE_TERMINAL_KEYS = \[([\s\S]*?)\] as const/.exec(viewer)?.[1]
    expect(table).toBeDefined()
    const keys = [...table!.matchAll(/\['([^']+)', '([^']+)'/g)].map(match => [match[1], match[2]])
    expect(keys.length).toBeGreaterThanOrEqual(8)
    expect(Object.fromEntries(keys)).toMatchObject({ Esc: '\\x1b', '↑': '\\x1b[A', '↓': '\\x1b[B', '←': '\\x1b[D', '→': '\\x1b[C', Tab: '\\t', Enter: '\\r', 'Ctrl-C': '\\x03' })
    expect(declaration('.mobile-app .mobile-terminal-keys', 'display')).toBe('grid')
    expect(declaration('.mobile-app .mobile-terminal-keys', 'grid-template-columns')).toBe('repeat(7, minmax(0, 1fr))')
    expect(declaration('.mobile-app .mobile-terminal-keys', 'overflow')).toBe('visible')
    expect(declaration('.mobile-app .mobile-terminal-keys > .mobile-terminal-key', 'min-height')).toBe('44px')
    // Pressing a key never steals focus from the composer or a native keyboard.
    expect(viewer).toMatch(/className="mobile-terminal-key"[^>]*onPointerDown=\{event => event\.preventDefault\(\)\}/)
  })
})
