// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { rendererResourceOwnerCounts } from '../src/renderer/src/lib/resource-owner-counts.js'
import { acquireTerminalResourceOwners, terminalAddonOwnerCounts, terminalResourceOwnerCounts } from '../src/renderer/src/lib/terminal-resource-owners.js'
import { readRendererResourceOwnerCounts } from '../src/renderer/src/store'

describe('Renderer resource owner counts', () => {
  it('exposes duplicate WebGL ownership on one View while preserving the public aggregate', () => {
    const active = acquireTerminalResourceOwners({ addons: 1, listeners: 10 })
    const retained = acquireTerminalResourceOwners({ addons: 1, listeners: 10 })
    try {
      const releaseFirst = active.acquireAddon('webgl')
      const releaseSecond = active.acquireAddon('webgl')
      const releaseSearch = retained.acquireAddon()
      expect(terminalResourceOwnerCounts()).toEqual({ terminalViews: 2, terminalAddons: 5, terminalListeners: 20 })
      expect(terminalAddonOwnerCounts()).toEqual({ terminalBaseAddons: 3, terminalWebglAddons: 2, terminalWebglAddonViews: 1 })
      const event = new CustomEvent('agentmux:resource-owner-counts', { detail: { observed: false } })
      window.dispatchEvent(event)
      expect(event.detail).toMatchObject({
        observed: true, terminalViews: 2, terminalAddons: 5, terminalBaseAddons: 3,
        terminalWebglAddons: 2, terminalWebglAddonViews: 1
      })
      expect(readRendererResourceOwnerCounts()).toEqual({
        monacoEditors: null, monacoModels: null, documents: 0, runtimeSubscriptions: 0,
        terminalViews: 2, terminalAddons: 5, terminalListeners: 20
      })
      releaseSearch()
      releaseFirst()
      releaseFirst()
      expect(terminalAddonOwnerCounts()).toEqual({ terminalBaseAddons: 2, terminalWebglAddons: 1, terminalWebglAddonViews: 1 })
      active.release()
      releaseSecond()
      expect(terminalAddonOwnerCounts()).toEqual({ terminalBaseAddons: 1, terminalWebglAddons: 0, terminalWebglAddonViews: 0 })
    } finally {
      active.release()
      retained.release()
    }
    expect(terminalAddonOwnerCounts()).toEqual({ terminalBaseAddons: 0, terminalWebglAddons: 0, terminalWebglAddonViews: 0 })
  })

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
