import { describe, expect, it, vi } from 'vitest'
import { rendererResourceOwnerCounts } from '../src/renderer/src/lib/resource-owner-counts.js'

describe('Renderer resource owner counts', () => {
  it('reports explicit document, watcher, subscription, and Monaco owners', () => {
    const monacoModelCount = vi.fn(() => 2)
    expect(rendererResourceOwnerCounts({
      documentCount: 3,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 1, terminalAddons: 4, terminalListeners: 6 },
      monacoModelCount
    })).toEqual({
      monacoModels: 2,
      documents: 3,
      runtimeSubscriptions: 2,
      terminalViews: 1,
      terminalAddons: 4,
      terminalListeners: 6
    })
    expect(monacoModelCount).toHaveBeenCalledOnce()
  })

  it('reports zero Monaco owners before the lazy editor module installs its counter', () => {
    expect(rendererResourceOwnerCounts({
      documentCount: 0,
      runtimeSubscriptionCount: 2,
      terminalOwners: { terminalViews: 0, terminalAddons: 0, terminalListeners: 0 }
    }).monacoModels).toBe(0)
  })
})
