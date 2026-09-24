import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { createWorkspaceLayout, moveTabToNewGroup, type SplitDirection } from '@agentmux/layout'
import type { BrowserSnapshot } from '../src/shared/contracts'
import { reduceBrowserEvent } from '../src/renderer/src/lib/browser-state'
import { addWorkbenchRegion, createWorkbenchTab, type BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

function browser(regionId: string, browserId: string): BrowserWorkbenchSurface {
  return {
    regionId, browserId, id: browserId, kind: 'browser', workspaceId: 'workspace',
    navigationId: `navigation-${browserId}`, url: 'https://example.test/original', title: 'Original',
    profileId: 'original-profile', driving: false, appLinkPrompt: null,
    loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null
  }
}
const agent = (regionId: string) => ({
  regionId, kind: 'agent' as const, phase: 'attached' as const,
  workspaceId: 'workspace', sessionId: `session-${regionId}`
})
function fixture(direction: SplitDirection) {
  const primary = { ...browser('primary', 'related'), bookmarkOrigin: { path: '/workspace/page.html', binary: false } }
  let mixed = createWorkbenchTab('mixed', primary, 'Original tab')
  mixed = addWorkbenchRegion(mixed, 'primary', direction, agent('agent-mixed'))
  mixed = addWorkbenchRegion(mixed, 'agent-mixed', 'down', browser('unrelated-mixed', 'other'))
  mixed = addWorkbenchRegion(mixed, 'primary', 'down', browser('mirror', 'related'))
  const related = createWorkbenchTab('related-tab', browser('second-tab', 'related'))
  let unrelated = createWorkbenchTab('unrelated-tab', browser('unrelated-tab-region', 'third'))
  unrelated = addWorkbenchRegion(unrelated, 'unrelated-tab-region', direction, agent('agent-unrelated'))
  const agentOnly = createWorkbenchTab('agent-tab', agent('agent-only'))
  const tabs = { mixed, 'related-tab': related, 'unrelated-tab': unrelated, 'agent-tab': agentOnly }
  let layout = createWorkspaceLayout('group', Object.keys(tabs))
  layout = moveTabToNewGroup(layout, 'unrelated-tab', 'group', 'group', direction, 'other-group')
  const state = { tabs, layouts: { workspace: layout } }
  const updated: BrowserSnapshot = {
    id: 'related', navigationId: 'navigation-new', url: 'https://example.test/updated', title: 'Updated',
    profileId: 'selected-profile', driving: true, appLinkPrompt: null,
    loading: true, canGoBack: true, canGoForward: false, viewport: 'responsive', error: null
  }
  return { state, updated }
}

describe('Browser updated projection preserves unrelated work surfaces', () => {
  for (const direction of ['right', 'down'] as const) {
    it(`updates every owning Region while preserving unrelated references in a ${direction} split`, () => {
      const { state, updated } = fixture(direction)
      expect(Object.keys(state.tabs)).toEqual(['mixed', 'related-tab', 'unrelated-tab', 'agent-tab'])
      expect(Object.keys(state.tabs.mixed.regions)).toEqual(['primary', 'agent-mixed', 'unrelated-mixed', 'mirror'])
      expect(state.layouts.workspace.root).toMatchObject({ type: 'split', direction: direction === 'right' ? 'horizontal' : 'vertical' })
      expect(state.layouts.workspace.groups.map(group => group.id)).toEqual(['group', 'other-group'])
      const next = reduceBrowserEvent(state, { type: 'updated', browser: updated })
      expect(next).not.toBe(state)
      expect(next.tabs).not.toBe(state.tabs)
      for (const [tabId, regionId] of [['mixed', 'primary'], ['mixed', 'mirror'], ['related-tab', 'second-tab']] as const) {
        const previous = state.tabs[tabId].regions[regionId]!
        const current = next.tabs[tabId]!.regions[regionId]!
        expect(current).not.toBe(previous)
        expect(current).toMatchObject({ ...updated, browserId: 'related', regionId, workspaceId: 'workspace', kind: 'browser' })
      }
      expect(next.tabs.mixed!.regions.primary).toMatchObject({ bookmarkOrigin: { path: '/workspace/page.html', binary: false } })
      expect(next.tabs.mixed!.regions['agent-mixed']).toBe(state.tabs.mixed.regions['agent-mixed'])
      expect(next.tabs.mixed!.regions['unrelated-mixed']).toBe(state.tabs.mixed.regions['unrelated-mixed'])
      for (const tabId of ['unrelated-tab', 'agent-tab'] as const) {
        expect(next.tabs[tabId]).toBe(state.tabs[tabId])
        expect(next.tabs[tabId]!.regions).toBe(state.tabs[tabId].regions)
        expect(next.tabs[tabId]!.layout).toBe(state.tabs[tabId].layout)
      }
      expect(next.tabs.mixed!.layout).toBe(state.tabs.mixed.layout)
      expect(next.layouts).toBe(state.layouts)
      expect(state.tabs.mixed.regions.primary).toMatchObject({ title: 'Original', loading: false })
    })
  }

  it('returns the exact nonempty original state for an unknown Browser', () => {
    const { state, updated } = fixture('right')
    expect(Object.keys(state.tabs)).toEqual(['mixed', 'related-tab', 'unrelated-tab', 'agent-tab'])
    expect(state.tabs['agent-tab'].regions['agent-only']).toMatchObject({ kind: 'agent', sessionId: 'session-agent-only' })
    expect(reduceBrowserEvent(state, { type: 'updated', browser: { ...updated, id: 'unknown' } })).toBe(state)
  })

  it('preserves every reference when a repeated snapshot has no changed shallow facts', () => {
    const { state, updated } = fixture('down')
    expect(Object.keys(state.tabs.mixed.regions)).toEqual(['primary', 'agent-mixed', 'unrelated-mixed', 'mirror'])
    const current = reduceBrowserEvent(state, { type: 'updated', browser: updated })
    expect(current.tabs.mixed!.regions.primary).toMatchObject({ title: 'Updated', navigationId: 'navigation-new' })
    expect(reduceBrowserEvent(current, { type: 'updated', browser: { ...updated } })).toBe(current)
  })

  it('executes the actual definition-excluded Store applyBrowserEvent body with the real reducer', () => {
    // AST extraction isolates this product glue. set is a synchronous double; no Renderer/App/healthy Run is launched.
    const source = readFileSync(new URL('../src/renderer/src/store.ts', import.meta.url), 'utf8')
    const file = ts.createSourceFile('store.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    expect((file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics).toEqual([])
    const methods: ts.MethodDeclaration[] = []
    const visit = (node: ts.Node) => {
      if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'applyBrowserEvent') methods.push(node)
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(methods).toHaveLength(1)
    const body = methods[0]!.body
    expect(body).toBeDefined()
    const calls: string[] = []
    const findCalls = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text)
      ts.forEachChild(node, findCalls)
    }
    findCalls(body!)
    expect(calls).toContain('reduceBrowserEvent')
    const { state, updated } = fixture('right')
    let projected = state
    const set = (update: (current: typeof state) => typeof state) => { projected = update(state) }
    const apply = new Function('set', 'reduceBrowserEvent', `return function(event) ${body!.getText(file)}`)(set, reduceBrowserEvent)
    apply({ type: 'updated', browser: updated })
    expect(projected.tabs.mixed.regions.primary).toMatchObject({ title: 'Updated' })
    expect(projected.tabs['unrelated-tab']).toBe(state.tabs['unrelated-tab'])
    expect(projected.tabs['agent-tab']).toBe(state.tabs['agent-tab'])
    expect(projected.layouts).toBe(state.layouts)
  })
})
