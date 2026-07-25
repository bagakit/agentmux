import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { BrowserAnnotation } from '../src/renderer/src/lib/browser-annotations.js'
import { useAppStore } from '../src/renderer/src/store.js'

const initialState = useAppStore.getState()

const annotation: BrowserAnnotation = {
  id: 'annotation-1',
  workspaceId: 'workspace-1',
  browserId: 'browser-1',
  navigationId: 'navigation-1',
  note: 'Explain this control',
  selection: {
    browserId: 'browser-1',
    navigationId: 'navigation-1',
    pageTitle: 'Docs',
    pageUrl: 'https://example.com/docs',
    tagName: 'button',
    role: 'button',
    accessibleName: 'Open settings',
    selector: 'button.settings',
    text: 'Settings',
    nearbyText: [],
    attributes: {},
    html: '<button>Settings</button>',
    rectViewport: { x: 1, y: 2, width: 3, height: 4 },
    rectPage: { x: 1, y: 2, width: 3, height: 4 },
    isFixed: false
  }
}

afterEach(() => useAppStore.setState(initialState, true))

describe('Browser annotation and Composer draft owners', () => {
  it('keeps annotations as explicit Desktop drafts and removes them with Browser close', () => {
    const state = useAppStore.getState()
    state.addBrowserAnnotation(annotation)
    state.addBrowserAnnotation(annotation)
    expect(useAppStore.getState().browserAnnotationsByBrowserId).toEqual({
      'browser-1': [annotation]
    })

    useAppStore.getState().applyBrowserEvent({ type: 'closed', id: 'browser-1' })
    expect(useAppStore.getState().browserAnnotationsByBrowserId).toEqual({})
  })

  it('appends Browser context without overwriting a Composer draft', () => {
    const state = useAppStore.getState()
    state.setAgentComposerDraft('agent-1', 'Existing prompt')
    state.appendAgentComposerDraft('agent-1', 'Browser element context')

    expect(useAppStore.getState().agentComposerDrafts['agent-1'])
      .toBe('Existing prompt\n\nBrowser element context')
  })

  it('clears a submitted snapshot only when no later context was appended', () => {
    const state = useAppStore.getState()
    state.setAgentComposerDraft('agent-1', 'First')
    state.appendAgentComposerDraft('agent-1', 'Second')
    state.clearAgentComposerDraftIfUnchanged('agent-1', 'First')
    expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('First\n\nSecond')

    state.clearAgentComposerDraftIfUnchanged('agent-1', 'First\n\nSecond')
    expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBeUndefined()
  })

  it('deletes one annotation without touching another Browser owner', () => {
    const state = useAppStore.getState()
    state.addBrowserAnnotation(annotation)
    const second = {
      ...annotation,
      id: 'annotation-2',
      browserId: 'browser-2',
      selection: { ...annotation.selection, browserId: 'browser-2' }
    }
    state.addBrowserAnnotation(second)
    state.deleteBrowserAnnotation('browser-1', annotation.id)

    expect(useAppStore.getState().browserAnnotationsByBrowserId).toEqual({
      'browser-2': [second]
    })
  })

  it('rejects an annotation whose draft identity disagrees with the Main-owned selection', () => {
    expect(() => useAppStore.getState().addBrowserAnnotation({
      ...annotation,
      browserId: 'browser-2'
    })).toThrow('identity does not match')
  })
})
