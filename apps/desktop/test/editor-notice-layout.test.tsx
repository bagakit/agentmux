// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { editorPaneStoreState } from './helpers/editor-pane-store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
vi.mock('../src/renderer/src/monaco', () => ({}))
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }))
import { EditorPane } from '../src/renderer/src/components/EditorPane'

let root: Root, container: HTMLDivElement, css: HTMLStyleElement
const surface = { kind: 'file' as const, regionId: 'original-region', workspaceId: 'original-workspace', path: 'original.note.json' }
const key = documentKey(surface.workspaceId, surface.path)
beforeEach(() => {
  fixture.state = { ...editorPaneStoreState(), documents: { [key]: { path: surface.path, content: 'Original draft', revision: 'original-disk' } }, editorRegionModes: { [surface.regionId]: 'preview' } }
  css = document.createElement('style')
  css.textContent = ['workbench.css', 'file-preview.css'].map(name => readFileSync(new URL('../src/renderer/src/styles/' + name, import.meta.url), 'utf8')).join('\n')
  document.head.append(css)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); css.remove() })

it.each([[false, false], [true, false], [false, true], [true, true]] as const)('keeps retained=%s and issue=%s in one intrinsic notice row with the canvas as the only flexible row', async (retained, issue) => {
  if (retained) fixture.state.retainedDocumentDrafts = { [key]: [{ path: surface.path, content: 'Kept original draft', revision: 'old-disk' }] }
  if (issue) fixture.state.documentIssues = { [key]: { kind: 'read-error', code: 'READ_UNCONFIRMED', message: 'Read unconfirmed' } }
  await act(async () => root.render(<EditorPane tabId="original-tab" surface={surface} preview={<article data-note-body>Original Note content</article>} />))
  const pane = container.querySelector<HTMLElement>('.editor-pane')!
  expect(Array.from(pane.children).map(child => child.className)).toEqual(['editor-header', 'editor-file-notices', 'editor-canvas'])
  const notices = pane.children[1]!
  expect(notices.children).toHaveLength(Number(retained) + Number(issue))
  expect(notices.querySelector('[role="status"]')).toBe(retained ? notices.firstElementChild : null)
  expect(notices.querySelector('[role="alert"]') !== null).toBe(issue)
  expect(getComputedStyle(pane).gridTemplateRows).toBe('30px auto minmax(0, 1fr)')
  expect(pane.children[2]!.querySelector('[data-note-body]')?.textContent).toBe('Original Note content')
  expect(fixture.state.documents).toEqual({ [key]: { path: surface.path, content: 'Original draft', revision: 'original-disk' } })
})
