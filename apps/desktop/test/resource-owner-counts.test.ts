import { describe, expect, it, vi } from 'vitest'
import { rendererResourceOwnerCounts } from '../src/renderer/src/lib/resource-owner-counts.js'

describe('Renderer resource owner counts', () => {
  it('reports explicit document, watcher, subscription, and Monaco owners', () => {
    const monacoEditorCount = vi.fn(() => 1)
    const monacoModelCount = vi.fn(() => 2)
    expect(rendererResourceOwnerCounts({
      documentCount: 3,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 1, terminalAddons: 4, terminalListeners: 6 },
      monacoEditorCount,
      monacoModelCount
    })).toEqual({
      monacoEditors: 1,
      monacoModels: 2,
      documents: 3,
      runtimeSubscriptions: 2,
      terminalViews: 1,
      terminalAddons: 4,
      terminalListeners: 6
    })
    expect(monacoEditorCount).toHaveBeenCalledOnce()
    expect(monacoModelCount).toHaveBeenCalledOnce()
  })

  it('reports zero Monaco owners before the lazy editor module installs its counter', () => {
    expect(rendererResourceOwnerCounts({
      documentCount: 0,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }
    })).toMatchObject({ monacoEditors: 0, monacoModels: 0 })
  })
})
