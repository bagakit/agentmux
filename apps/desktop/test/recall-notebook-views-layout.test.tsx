const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import recallCss from '../src/renderer/src/styles/recall.css?raw'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotebookHome } from '../src/renderer/src/components/NotebookNavigation'
import { useAppStore } from '../src/renderer/src/store'
import type { Notebook, NotebookPage } from '@agentmux/core/notebook-catalog'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const title = '一个需要保留全部文字的超长笔记标题'.repeat(12)
const hostname = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.') + '.test'
const book: Notebook = { notebookId: 'long-title-book', name: 'Long findings', createdAt: 1 }
const pages: NotebookPage[] = Array.from({ length: 4 }, (_, i) => ({ noteId: `note-${i}`, notebookId: book.notebookId, parentNoteId: null, title: i ? `Original note ${i}` : title, createdAt: 1, updatedAt: 1, resource: { workspaceId: 'original', hostId: 'local', workspacePath: _hygiene_fixturePath("original"), path: `${i}.note.json` }, sources: [{ sourceId: `source-${i}`, url: `https://${hostname}/finding`, title: null, recordedAt: 1 }], topics: [] }))
let host: HTMLDivElement, root: Root, style: HTMLStyleElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); style = document.createElement('style'); style.textContent = recallCss; document.head.append(style); useAppStore.setState({ documents: {}, config: null }) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); style.remove() })

it('bounds real Notebook long-title cards and Graph nodes while keeping original full labels and opening the same page', async () => {
  const open = vi.fn()
  async function render(view: 'cards' | 'graph') { await act(async () => root.render(<NotebookHome notebook={book} pages={pages} query="" pending={false} onCreate={() => {}} onOpen={open} view={view} />)) }
  await render('cards')
  const card = host.querySelector<HTMLButtonElement>('.recall-note-card')!
  expect(card.title).toBe(`${title}\n${hostname}`)
  // happy-dom omits vendor properties; actual Chromium screenshots validate wrapping.
  expect(recallCss.match(/\.recall-note-card strong \{([^}]+)\}/)?.[1]).toContain('-webkit-line-clamp: 3')
  expect(getComputedStyle(card.querySelector('span')!).overflowWrap).toBe('anywhere')
  expect(recallCss.match(/\.recall-note-card span \{([^}]+)\}/)?.[1]).toContain('-webkit-line-clamp: 2')
  await act(async () => card.click()); expect(open).toHaveBeenLastCalledWith(pages[0])
  await render('graph')
  const nodes = [...host.querySelectorAll<HTMLButtonElement>('.recall-graph-node')]
  expect(nodes).toHaveLength(4)
  for (const node of nodes) { expect(getComputedStyle(node).height).toBe('80px'); expect(getComputedStyle(node).boxSizing).toBe('border-box') }
  expect(nodes[0]!.title).toBe(`${title}\n${hostname}`)
  expect(recallCss.match(/\.recall-graph-node strong \{([^}]+)\}/)?.[1]).toContain('-webkit-line-clamp: 2')
  expect(getComputedStyle(nodes[0]!.querySelector('small')!).textOverflow).toBe('ellipsis')
  expect(Number.parseInt(nodes[3]!.style.top) - Number.parseInt(nodes[0]!.style.top)).toBeGreaterThan(80)
  await act(async () => nodes[0]!.click()); expect(open).toHaveBeenLastCalledWith(pages[0])
})
