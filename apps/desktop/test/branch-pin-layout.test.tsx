// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles.js'

const rules = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
  .map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }))
  .filter(({ selector }) => selector.includes('branch-row__pin'))

function matchingRule(selector: string): string {
  const found = rules.filter((rule) => rule.selector.split(',').some((part) => part.trim() === selector))
  expect(found.length, `No rule matched ${selector}`).toBeGreaterThan(0)
  return found.map((rule) => rule.body).join(';')
}

describe('compact branch Pin action', () => {
  it('returns its whole footprint to the title while idle', () => {
    const body = matchingRule('.branch-row__pin')
    expect(body).toMatch(/position:\s*absolute/)
    expect(body).toMatch(/pointer-events:\s*none/)
    expect(body).toMatch(/opacity:\s*0/)
    const size = Number(body.match(/width:\s*(\d+)px/)?.[1])
    expect(size).toBeGreaterThanOrEqual(16)
    expect(size).toBeLessThan(22)
    expect(body).toMatch(/padding:\s*0/)
  })

  it.each(['.branch-row:hover .branch-row__pin', '.branch-row:focus-within .branch-row__pin'])('%s restores a usable in-flow action', (selector) => {
    const body = matchingRule(selector)
    expect(body).toMatch(/position:\s*static/)
    expect(body).toMatch(/pointer-events:\s*auto/)
    expect(Number(body.match(/opacity:\s*([\d.]+)/)?.[1])).toBeGreaterThan(0)
  })
})
