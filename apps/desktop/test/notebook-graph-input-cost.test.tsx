const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import type { FileDocument } from '../src/shared/contracts'
import { newNoteDocument } from '../src/shared/note-document'

// Observe the real derivation and real knowledge implementation, not mocked results.
const work = vi.hoisted(() => ({ subsets: 0, indexes: 0, latestText: '' }))
vi.mock('../src/renderer/src/lib/note-knowledge', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/src/lib/note-knowledge')>()
  return { ...actual,
    noteFilesFromDocuments: (...args: Parameters<typeof actual.noteFilesFromDocuments>) => { work.subsets++; return actual.noteFilesFromDocuments(...args) },
    noteKnowledge: (...args: Parameters<typeof actual.noteKnowledge>) => {
      work.indexes++
      const result = actual.noteKnowledge(...args)
      work.latestText = [...(result.sources[0]?.blocks.values() ?? [])].map(block => block.text).join(' ')
      return result
    }
  }
})
import { NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
import { useAppStore } from '../src/renderer/src/store'

const noteId = '01ARZ3NDEKTSV4RRFFQ69G5FAV', blockId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const noteKey = 'work\0original.note.json'
const notebook = { notebookId: 'original-book', name: 'Original notebook', createdAt: 1 }
const pages: NotebookPage[] = [{ noteId, notebookId: notebook.notebookId, parentNoteId: null, title: 'Original page',
  resource: { hostId: 'local', workspaceId: 'work', workspacePath: _hygiene_fixturePath("work"), path: 'original.note.json' }, sources: [], topics: [], createdAt: 1, updatedAt: 1 }]
function note(text: string, withReference = false): FileDocument {
  const body = newNoteDocument(text, noteId, blockId)
  if (withReference) body.content.content!.push({ type: 'blockReference', attrs: { blockId: 'reference-block', referenceId: 'original-reference', target: { noteId, blockId }, mode: 'reference' } })
  return { path: 'original.note.json', content: JSON.stringify(body), revision: text }
}
let root: Root, container: HTMLDivElement
const initialState = useAppStore.getState()
async function render(active: boolean) {
  await act(async () => root.render(<div hidden={!active}><NotebookHome notebook={notebook} pages={pages} pending={false} onCreate={() => {}} onOpen={() => {}} query="" onQuery={() => {}} view="graph" active={active} /></div>))
}
async function replaceDocument(key: string, document: FileDocument) {
  await act(async () => useAppStore.setState({ documents: { ...useAppStore.getState().documents, [key]: document } }))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  work.subsets = 0; work.indexes = 0; work.latestText = ''
  useAppStore.setState({ config: { workspaces: [{ id: 'work', hostId: 'local', path: _hygiene_fixturePath("work") }] } as never, documents: { [noteKey]: note('Original text') } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initialState, true); vi.unstubAllGlobals() })

describe('Notebook Graph subscribes only to active Note inputs', () => {
  it('active Graph ignores unrelated Session and ordinary-file changes with the original Note object intact', async () => {
    await render(true)
    const indexes = work.indexes, original = useAppStore.getState().documents[noteKey]
    expect(indexes).toBeGreaterThan(0)
    expect(container.querySelector('.recall-graph-coverage')!.textContent).toContain('1 of 1')
    await act(async () => useAppStore.setState({ sessions: [...useAppStore.getState().sessions] }))
    expect(work.indexes).toBe(indexes)
    await replaceDocument('work\0unrelated.txt', { path: 'unrelated.txt', content: 'First ordinary edit', revision: 'one' })
    await replaceDocument('work\0unrelated.txt', { path: 'unrelated.txt', content: 'Later ordinary edit', revision: 'two' })
    expect(useAppStore.getState().documents[noteKey]).toBe(original)
    expect(work.indexes).toBe(indexes)
  })

  it('inactive Home neither selects Note files nor rebuilds knowledge, then reads the latest original Note without replacing its DOM', async () => {
    await render(true)
    const home = container.querySelector('.survey-notebook-home'), input = container.querySelector('input'), scroll = container.querySelector('.recall-graph-scroll') as HTMLElement
    expect(home).not.toBeNull(); expect(input).not.toBeNull(); expect(scroll).not.toBeNull()
    scroll.scrollTop = 37
    await render(false)
    const subsets = work.subsets, indexes = work.indexes
    await replaceDocument('work\0unrelated.txt', { path: 'unrelated.txt', content: 'Hidden Work edit', revision: 'one' })
    await replaceDocument(noteKey, note('Latest hidden original text', true))
    expect(work.subsets).toBe(subsets)
    expect(work.indexes).toBe(indexes)
    expect(container.querySelector('[data-edge-kind="reference"]')).toBeNull()
    await render(true)
    expect(work.indexes).toBeGreaterThan(indexes)
    expect(work.latestText).toContain('Latest hidden original text')
    expect(container.querySelector('[data-edge-kind="reference"]')).not.toBeNull()
    expect(container.querySelector('.survey-notebook-home')).toBe(home)
    expect(container.querySelector('input')).toBe(input)
    expect(container.querySelector('.recall-graph-scroll')).toBe(scroll)
    expect(scroll.scrollTop).toBe(37)
  })

  it('active Note body updates still rebuild knowledge and update confirmed edges for the same page', async () => {
    await render(true)
    const indexes = work.indexes, pageNode = container.querySelector(`[data-note-id="${noteId}"]`)
    expect(container.querySelector('[data-edge-kind="reference"]')).toBeNull()
    await replaceDocument(noteKey, note('Relevant changed body', true))
    expect(work.indexes).toBe(indexes + 1)
    expect(work.latestText).toContain('Relevant changed body')
    const edge = container.querySelector('[data-edge-kind="reference"]')!
    expect(edge).not.toBeNull(); expect(edge.getAttribute('data-edge-from')).toBe(noteId); expect(edge.getAttribute('data-edge-to')).toBe(noteId)
    expect(container.querySelector(`[data-note-id="${noteId}"]`)).toBe(pageNode)
  })
})
