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
    for (const token of ['data-loading-phase', 'data-loading-scope', 'aria-live', 'full-page-loading__atmosphere', 'prefers-reduced-motion']) {
      expect(`${component}\n${styles}`).toContain(token)
    }
    const animatedNames = [...styles.matchAll(/animation:\s*(full-page-loading-[\w-]+)/g)].map(match => match[1])
    expect(animatedNames.length).toBeGreaterThan(0)
    for (const name of animatedNames) expect(styles).toContain(`@keyframes ${name}`)
    const reducedMotion = styles.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(reducedMotion).toContain('animation: none')
    expect(reducedMotion.length).toBeGreaterThan(0)
    const animatedTargets = [...styles.matchAll(/([^{}]+)\{[^{}]*animation:\s*full-page-loading-[^{}]+\}/g)]
      .flatMap(match => [...match[1].matchAll(/\.full-page-loading__[\w-]+(?:\s+i)?/g)].map(target => target[0]))
    expect(animatedTargets.length).toBeGreaterThan(0)
    for (const target of animatedTargets) expect(reducedMotion).toContain(target)
  })

  it('uses the shared motion tokens instead of a second duration scale', () => {
    expect(styles.match(/animation:\s*[^;]+/g) ?? []).not.toHaveLength(0)
    expect(styles).toContain('var(--dur-enter)')
    expect(styles).not.toMatch(/animation:\s*[^;]+\binfinite\b/)
    expect(styles).not.toMatch(/animation:\s*[^;]+\b\d+ms\b/)
  })
})
