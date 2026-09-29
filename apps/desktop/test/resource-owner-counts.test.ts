import { describe, expect, it, vi } from 'vitest'
import { rendererResourceOwnerCounts } from '../src/renderer/src/lib/resource-owner-counts.js'

describe('Renderer resource owner counts', () => {
  it('reports explicit document, watcher, subscription, and Monaco owners', () => {
    const monacoEditorCount = vi.fn(() => 1)
    const monacoModelCount = vi.fn(() => 2)
    expect(rendererResourceOwnerCounts({
      documentCount: 3,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 1, terminalAddons: 4, terminalListeners: 7 },
      monacoEditorCount,
      monacoModelCount
    })).toEqual({
      monacoEditors: 1,
      monacoModels: 2,
      documents: 3,
      runtimeSubscriptions: 2,
      terminalViews: 1,
      terminalAddons: 4,
      terminalListeners: 7
    })
    expect(monacoEditorCount).toHaveBeenCalledOnce()
    expect(monacoModelCount).toHaveBeenCalledOnce()
  })

  it('keeps missing Monaco getters unknown while established true zero remains zero', () => {
    expect(rendererResourceOwnerCounts({
      documentCount: 0,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }
    })).toMatchObject({ monacoEditors: null, monacoModels: null, runtimeSubscriptions: 2 })
    expect(rendererResourceOwnerCounts({ documentCount: 6, runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 1, terminalAddons: 3, terminalListeners: 4 },
      monacoModelCount: () => 0
    })).toEqual({ monacoEditors: null, monacoModels: 0, documents: 6, runtimeSubscriptions: 2,
      terminalViews: 1, terminalAddons: 3, terminalListeners: 4 })
    expect(rendererResourceOwnerCounts({ documentCount: 6, runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 1, terminalAddons: 3, terminalListeners: 4 },
      monacoEditorCount: () => { throw new Error('not ready') }, monacoModelCount: () => 3
    })).toMatchObject({ monacoEditors: null, monacoModels: 3, documents: 6 })
  })
})
