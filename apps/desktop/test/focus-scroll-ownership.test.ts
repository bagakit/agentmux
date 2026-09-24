import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { allStyleRules } from './helpers/styles'

const require = createRequire(import.meta.url)
type StyleParent = { name?: string; params?: string; parent?: StyleParent }
const postcss = createRequire(require.resolve('vite'))('postcss') as { parse(css: string): { walkRules(fn: (rule: { selectors: string[]; parent?: StyleParent; walkDecls(fn: (declaration: { prop: string; value: string }) => void): void }) => void): void } }
const rules = postcss.parse(allStyleRules())
function declarations(selector: string, container?: string): Record<string, string> {
  const result: Record<string, string> = {}
  let found = 0
  rules.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return
    if (container) {
      let parent = rule.parent
      while (parent && !(parent.name === 'container' && parent.params === container)) parent = parent.parent
      if (!parent) return
    }
    found++
    rule.walkDecls(declaration => { result[declaration.prop] = declaration.value })
  })
  expect(found, `A stylesheet must actually define ${selector}${container ? ` inside @container ${container}` : ''}`).toBeGreaterThan(0)
  return result
}

describe('Focus scroll and right workspace geometry ownership', () => {
  it('bounds recent tracks while giving lanes the remaining scrollable height', () => {
    expect(declarations('.recent-focus__viewport')).toMatchObject({ flex: '1', 'min-height': '0', overflow: 'auto', 'overscroll-behavior': 'contain' })
    expect(declarations('.focus-project-lanes__rows')).toMatchObject({ flex: '1 1 auto', 'min-height': '0', overflow: 'auto' })
    expect(declarations('.global-focus-surface .global-focus-main .global-board-columns')).toMatchObject({ 'min-height': '0', flex: '1 1 auto' })
  })

  it('allows the complete status matrix to be reached at narrow widths', () => {
    expect(declarations('.focus-project-lanes__track')).toMatchObject({ overflow: 'hidden' })
    expect(declarations('.focus-context-group')).toMatchObject({ 'min-width': '0' })
    expect(declarations('.focus-project-lanes__groups', '(max-width: 680px)')).toMatchObject({ display: 'flex', 'flex-direction': 'column' })
    expect(declarations('.focus-project-lanes__row', '(max-width: 680px)')['grid-template-columns']).toBe('minmax(0, 1fr)')
  })

  it('keeps empty portal registry shells outside the input hit tree', () => {
    expect(declarations('.workspace-workbench-registry')).toMatchObject({ 'pointer-events': 'none' })
    expect(declarations('.workspace-workbench-slot:not(.workspace-workbench-slot--parked):empty')).toMatchObject({ 'pointer-events': 'none' })
    expect(declarations('.workspace-workbench-slot:not(.workspace-workbench-slot--parked)')).toMatchObject({ 'pointer-events': 'auto' })
  })

  it('the retained Focus host occupies the complete Region area', () => {
    expect(declarations('.retained-workbench-view')).toMatchObject({ height: '100%', 'min-height': '0' })
    expect(declarations('.workspace-workbench-slot.workspace-workbench-slot--focus-source')).toMatchObject({ visibility: 'hidden', 'pointer-events': 'none' })
  })
})
