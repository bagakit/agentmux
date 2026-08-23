import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS, themeVar } from '../src/renderer/src/lib/theme-contract.js'
import { allStyles } from './helpers/styles.js'

const tokens = allStyles()
const appearance = readFileSync(new URL('../src/renderer/src/lib/app-appearance.ts', import.meta.url), 'utf8')

function themeBlock(): string {
  const start = tokens.indexOf('@theme inline {')
  expect(start, 'tokens.css must contain the utility adapter anchor').toBeGreaterThan(-1)
  const end = tokens.indexOf('\n}', start)
  expect(end, 'utility adapter must have a closing brace').toBeGreaterThan(start)
  const block = tokens.slice(start, end + 2)
  expect(block.length).toBeGreaterThan(100)
  return block
}

describe('theme and style SSOT contract', () => {
  it('utility adapter is a non-empty mapping layer over declared tokens', () => {
    const block = themeBlock()
    const mappings = [...block.matchAll(/--[\w-]+:\s*var\((--[\w-]+)\);/g)].map((match) => match[1]!)
    expect(mappings.length).toBeGreaterThan(5)
    for (const name of Object.values(THEME_TOKENS)) expect(mappings).toContain(name)
    for (const name of mappings) expect(tokens).toMatch(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`))
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:oklch|rgb|hsl)\(|\b\d+(?:\.\d+)?px\b/i)
  })

  it('typed semantic tokens resolve to the same CSS names as the source table', () => {
    const names = Object.values(THEME_TOKENS)
    expect(names.length).toBeGreaterThan(5)
    for (const name of names) expect(tokens).toContain(`${name}:`)
    expect(themeVar('surface0')).toBe('var(--surface-0)')
  })

  it('appearance switching has one runtime entry', () => {
    expect(appearance).toContain("dataset[APP_APPEARANCE_DATASET_KEY] = mode")
    expect(appearance).not.toContain('createContext')
    expect(appearance).not.toContain('ThemeProvider')
  })
})
