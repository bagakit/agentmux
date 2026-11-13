import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/** Layout only; what each key sends and that it keeps focus is rendered behaviour in
 * terminal-viewer-initial-binding.test.tsx. */
const require = createRequire(import.meta.url)
const postcss = createRequire(realpathSync(require.resolve('vite/package.json')))('postcss')
const css = postcss.parse(readFileSync(require.resolve('../src/terminal/terminal.css'), 'utf8'))
function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined
  css.walkRules((rule: any) => { if (rule.selector === selector) rule.walkDecls(property, (decl: any) => { value = decl.value }) })
  return value
}

describe('the phone terminal keypad layout', () => {
  it('keeps the keys on a fixed 7-column grid of thumb-sized keys', () => {
    expect(declaration('.mobile-app .mobile-terminal-keys', 'display')).toBe('grid')
    expect(declaration('.mobile-app .mobile-terminal-keys', 'grid-template-columns')).toBe('repeat(7, minmax(0, 1fr))')
    expect(declaration('.mobile-app .mobile-terminal-keys', 'overflow')).toBe('visible')
    expect(declaration('.mobile-app .mobile-terminal-keys > .mobile-terminal-key', 'min-height')).toBe('44px')
  })
})
