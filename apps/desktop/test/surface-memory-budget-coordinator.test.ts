import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: () => undefined
}))

import {
  useSurfaceMemoryBudget
} from '../src/renderer/src/lib/surface-memory-budget-coordinator.js'
import { collectSurfaceMemoryCandidates } from '../src/renderer/src/lib/surface-memory-budget-candidates.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

function fileTab(id: string) {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'file',
    workspaceId: 'workspace-1',
    path: `src/${id}.ts`
  })
}

function browserTab(id: string) {
  return createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'browser',
    workspaceId: 'workspace-1',
    browserId: `browser:${id}`,
    navigationId: `navigation:${id}`,
    profileId: 'default',
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    viewport: 'responsive',
    error: null
  })
}

describe('surface memory budget coordinator', () => {
  it('collects Browser and Monaco as separate Region candidates with rebuild proof', () => {
    const file = fileTab('file')
    const browser = browserTab('browser')
    const layout = createWorkspaceLayout('group', [file.id, browser.id])
    const candidates = collectSurfaceMemoryCandidates({
      tabs: { [file.id]: file, [browser.id]: browser },
      layouts: { 'workspace-1': layout },
      sessions: [],
      documents: { 'workspace-1\0src/file.ts': { content: 'const value = 1' } },
      dirtyDocuments: {},
      savingDocuments: {},
      activeWorkspaceId: 'workspace-1',
      workbenchVisible: true
    })
    expect(candidates).toEqual([
      expect.objectContaining({ id: 'region:file', kind: 'monaco', visible: true, canRebuild: true }),
      expect.objectContaining({ id: 'region:browser', kind: 'browser', visible: false, canRebuild: true })
    ])
  })

  it('protects dirty/saving Monaco documents and cross-workspace navigation', () => {
    const file = fileTab('file')
    const layout = createWorkspaceLayout('group', [file.id])
    const dirty = collectSurfaceMemoryCandidates({
      tabs: { [file.id]: file },
      layouts: { 'workspace-1': layout },
      sessions: [],
      documents: { 'workspace-1\0src/file.ts': {} },
      dirtyDocuments: { 'workspace-1\0src/file.ts': true },
      savingDocuments: {},
      activeWorkspaceId: 'workspace-1',
      workbenchVisible: true
    })[0]
    const hidden = collectSurfaceMemoryCandidates({
      tabs: { [file.id]: file },
      layouts: { 'workspace-1': layout },
      sessions: [],
      documents: { 'workspace-1\0src/file.ts': {} },
      dirtyDocuments: {},
      savingDocuments: {},
      activeWorkspaceId: 'another-workspace',
      workbenchVisible: true
    })[0]
    expect(dirty).toMatchObject({ protected: true, canRebuild: true })
    expect(hidden).toMatchObject({ navigationContextActive: false, visible: false })
  })

  it('is safe during partial hydration/static rendering', () => {
    function Probe() {
      const state = useSurfaceMemoryBudget({ workbenchVisible: false })
      return createElement('output', {
        'data-monaco-count': state.monacoRegionIds.size,
        'data-browser-count': state.browserRegionIds.size
      })
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-monaco-count="0"')
  })
})
