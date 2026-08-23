import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
const component = readFileSync(join(root, 'components', 'FullPageLoadingSurface.tsx'), 'utf8')
const styles = readFileSync(join(root, 'styles', 'full-page-loading.css'), 'utf8')

describe('full-page loading surface contract', () => {
  it('keeps the shared stage, phase hooks, and reduced-motion fallback in source', () => {
    expect(component.length).toBeGreaterThan(0)
    expect(styles.length).toBeGreaterThan(0)
    for (const token of ['data-loading-phase', 'data-loading-scope', 'aria-live', 'full-page-loading__grid', 'prefers-reduced-motion']) {
      expect(`${component}\n${styles}`).toContain(token)
    }
    expect(styles).toContain('@keyframes full-page-loading-sweep')
    const reducedMotion = styles.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(reducedMotion).toContain('animation: none')
    for (const selector of [
      '.full-page-loading__grid::before',
      '.full-page-loading__grid::after',
      '.full-page-loading__signal span',
      '.full-page-loading__signal i'
    ]) {
      expect(reducedMotion).toContain(selector)
    }
  })

  it('uses the shared motion tokens instead of a second duration scale', () => {
    expect(styles.match(/animation:\s*[^;]+/g) ?? []).not.toHaveLength(0)
    expect(styles).toContain('var(--dur-sweep)')
    expect(styles).toContain('var(--dur-breath)')
    expect(styles).not.toMatch(/animation:\s*[^;]+\b\d+ms\b/)
  })
})
