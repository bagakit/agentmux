import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, GRAPHITE_THEME, THEME_COLOR_PROPERTIES, resolveThemeDocument } from '@agentmux/client-ui/theme'

const require = createRequire(import.meta.url)
const postcss = createRequire(realpathSync(require.resolve('vite/package.json')))('postcss')
const source = path.resolve(path.dirname(require.resolve('../src/mobile.css')))
const stylesheets = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name))
    : entry.name.endsWith('.css') ? [path.join(dir, entry.name)] : [])
})(source)
const root = postcss.parse(readFileSync(path.join(source, 'mobile.css'), 'utf8'))
function rootValue(name: string, selector = ':root'): string | undefined {
  let value: string | undefined
  root.walkRules(selector, (rule: any) => rule.walkDecls(name, (decl: any) => { value = decl.value }))
  return value
}
function hex(value: string): [number, number, number] {
  const raw = value.replace('#', '')
  return [0, 2, 4].map(index => Number.parseInt(raw.slice(index, index + 2), 16) / 255) as [number, number, number]
}
function luminance(value: string): number {
  const [r, g, b] = hex(value).map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05) }

describe('the compact-mature phone scale', () => {
  it('declares the user-confirmed type scale, gutter and row geometry on the root', () => {
    expect(stylesheets.length).toBeGreaterThan(5)
    expect(Object.fromEntries(['--fs-display', '--fs-title', '--fs-lead', '--fs-body', '--fs-meta', '--fs-micro'].map(name => [name, rootValue(name)])))
      .toEqual({ '--fs-display': '24px', '--fs-title': '16px', '--fs-lead': '15px', '--fs-body': '14px', '--fs-meta': '12.5px', '--fs-micro': '11.5px' })
    expect(rootValue('--mobile-gutter')).toBe('var(--sp-6)')
    expect(rootValue('--sp-6')).toBe('16px')
    expect(rootValue('--mobile-row')).toBe('64px')
  })

  it('keeps every production type size on a token, with 16px only on editable fields', () => {
    const offScale: string[] = [], fields: string[] = []
    for (const file of stylesheets) {
      postcss.parse(readFileSync(file, 'utf8')).walkDecls((decl: any) => {
        if (decl.prop !== 'font-size' && decl.prop !== 'font') return
        const literal = /(^|\s)(\d+(?:\.\d+)?)px/.exec(decl.value)
        if (!literal) return
        const at = `${path.relative(source, file)} ${decl.parent.selector} ${decl.prop}: ${decl.value}`
        if (literal[2] === '16') fields.push(at)
        else offScale.push(at)
      })
    }
    expect(offScale).toEqual([])
    expect(fields.length).toBeGreaterThan(0)
    for (const field of fields) expect(field).toMatch(/input|textarea|select|textbox|contenteditable|tiptap|--mote-thread-input-font/)
  })

  it('derives a visible surface ladder and proportional radii from the shared theme roles', () => {
    expect(BUILTIN_THEMES.some(theme => theme.id === GRAPHITE_THEME.id)).toBe(true)
    for (const mode of ['dark', 'light'] as const) {
      const { variant } = resolveThemeDocument(GRAPHITE_THEME, mode, mode === 'dark')
      const variables: Record<string, string> = Object.fromEntries(Object.entries(THEME_COLOR_PROPERTIES).map(([role, property]) => [property, variant.colors[role as keyof typeof variant.colors]]))
      const selector = mode === 'dark' ? ':root' : ":root[data-appearance='light']"
      const resolve = (value: string | undefined): string => {
        const role = /^var\((--[a-z0-9-]+)\)$/.exec(value ?? '')?.[1]
        expect(role, `${mode} ${value}`).toBeDefined()
        return variables[role!]!
      }
      const page = resolve(rootValue('--mobile-page', selector) ?? rootValue('--mobile-page'))
      const group = resolve(rootValue('--mobile-group', selector))
      const press = resolve(rootValue('--mobile-group-press', selector))
      expect(contrast(page, group), `${mode} page/group`).toBeGreaterThanOrEqual(1.08)
      expect(contrast(group, press), `${mode} group/press`).toBeGreaterThanOrEqual(1.08)
    }
    for (const name of ['--mobile-radius-sm', '--mobile-radius', '--mobile-radius-group', '--mobile-radius-sheet'])
      expect(rootValue(name)).toMatch(/^calc\(var\(--radius, 9px\) \* [\d.]+\)$/)
    let fixed = 0
    for (const file of stylesheets) postcss.parse(readFileSync(file, 'utf8')).walkDecls(/^--mobile-(page|group|group-press|bar)$/, (decl: any) => { if (/#[0-9a-f]{3,8}\b/i.test(decl.value)) fixed++ })
    expect(fixed).toBe(0)
  })
})
