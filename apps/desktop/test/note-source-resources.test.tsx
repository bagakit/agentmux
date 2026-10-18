// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { NoteFileContext, resolveNoteSourceResource } from '@agentmux/client-ui/components/NoteFileContext'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { fileUploadRevision } from '@agentmux/core/files'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const resource = { hostId: 'original-host', workspaceId: 'original-workspace', workspacePath: new URL("original", new URL('/', import.meta.url)).pathname, path: 'reading/host.note.md' }
function platform(open = vi.fn(async () => true)) {
  return { open, value: { openNoteLink: open, renderNoteImage: input => <span data-image-source={JSON.stringify(input.resource)}>{input.alt}</span>, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, copyText: async () => true } as unknown as ClientUiPlatform }
}
function attachment() {
  const note = newNoteDocument('', 'attachment-host', 'original')
  note.content.content![0]!.content = [{ type: 'text', text: 'Read the attachment', marks: [{ type: 'link', attrs: { href: './result.txt' } }] }]
  return note
}
afterEach(async () => { await dom.render(null); vi.unstubAllGlobals() })
function prepare() { installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker) }

it('opens an attachment from the original Note with a modified click and preserves normal editing clicks', async () => {
  prepare(); const adapter = platform(), note = attachment()
  await dom.render(<StrictMode><ClientUiProvider platform={adapter.value}><NoteFileContext.Provider value={resource}><NoteBlockEditor note={note} knowledge={noteKnowledge([])} onChange={() => {}} onSave={() => {}} onIssue={() => {}} onOpen={() => {}} /></NoteFileContext.Provider></ClientUiProvider></StrictMode>)
  const anchor = dom.container.querySelector<HTMLAnchorElement>('.ProseMirror a')!
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(adapter.open).not.toHaveBeenCalled()
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })))
  expect(adapter.open).toHaveBeenCalledWith(resource, './result.txt')
  expect(adapter.open).toHaveBeenCalledTimes(1)
})

it('uses the same original attachment action on a read-only Note and keeps local errors recoverable', async () => {
  prepare(); const note = attachment(), content = serializeNoteDocument(note), adapter = platform(vi.fn(async () => { throw Error('The original attachment changed') }))
  await dom.render(<StrictMode><ClientUiProvider platform={adapter.value}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={content} revision="original" /></ClientUiProvider></StrictMode>)
  const anchor = dom.container.querySelector<HTMLAnchorElement>('.ProseMirror a')!
  await act(async () => anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(adapter.open).toHaveBeenCalledWith(resource, './result.txt')
  expect(dom.container.textContent).toContain('The original attachment changed')
  expect(dom.container.querySelector('.ProseMirror')).not.toBeNull()
  expect(dom.container.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe('false')
})

it('changes image context to the original shared file instead of the host Note directory', async () => {
  prepare(); const adapter = platform()
  const shared = { ...newNoteDocument('', 'shared-image', 'shared-paragraph'), kind: 'shared-block' as const }
  shared.content.content![0]!.content = [{ type: 'image', attrs: { src: './visual.png', alt: 'Shared illustration', title: null } }]
  const sharedContent = serializeNoteDocument(shared), sharedPath = 'shared/source.note.md', revision = fileUploadRevision(new TextEncoder().encode(sharedContent))
  const host = newNoteDocument('', 'host-note', 'intro')
  host.content.content!.push({ type: 'noteInclude', attrs: { blockId: 'include', referenceId: 'include-reference', noteId: shared.noteId, path: sharedPath } })
  const originalShared = { ...resource, path: sharedPath }
  const graph = { observations: [{ status: 'read', fileIdentity: 'confirmed', kind: 'shared-block', noteId: shared.noteId, resource: originalShared, revision }], duplicateNoteIds: [] } as never
  await dom.render(<StrictMode><ClientUiProvider platform={adapter.value}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={serializeNoteDocument(host)} revision="host-revision" graph={graph} documents={[{ location: { workspaceId: resource.workspaceId, path: sharedPath }, document: { path: sharedPath, content: sharedContent, revision } }]} /></ClientUiProvider></StrictMode>)
  const image = dom.container.querySelector<HTMLElement>('[data-image-source]')!
  expect(image).not.toBeNull(); expect(JSON.parse(image.dataset.imageSource!)).toEqual(originalShared)
  expect(image.textContent).toBe('Shared illustration')
  expect(dom.container.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe('false')
})

it('does not invent another Workspace resource or select one duplicate source', () => {
  expect(resolveNoteSourceResource(resource, { workspaceId: 'another', path: 'source.note.md' })).toBeNull()
  const original = { ...resource, path: 'shared/source.note.md' }
  const location = { workspaceId: resource.workspaceId, path: original.path }
  const row = { status: 'read', fileIdentity: 'confirmed', resource: original }
  expect(resolveNoteSourceResource(resource, location, { observations: [row, row] } as never)).toBeNull()
  expect(resolveNoteSourceResource(resource, location)).toEqual(original)
})

it('binds attachment actions only to the original mounted view and rebinds after a retained editor moves', async () => {
  prepare()
  const { Editor } = await import('@tiptap/core')
  const { noteRichContentExtensions } = await import('@agentmux/client-ui/components/NoteRichContent')
  const { NoteLinkActions } = await import('@agentmux/client-ui/components/NoteLinkActions')
  const editor = new Editor({ element: null, extensions: noteRichContentExtensions(), content: attachment().content })
  const adapter = platform(), first = document.createElement('div'), second = document.createElement('div')
  document.body.append(first, second)
  try {
    await dom.render(<ClientUiProvider platform={adapter.value}><NoteFileContext.Provider value={resource}><NoteLinkActions editor={editor} /></NoteFileContext.Provider></ClientUiProvider>)
    await act(async () => editor.mount(first))
    const originalAnchor = first.querySelector('a')!
    await act(async () => originalAnchor.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, cancelable: true })))
    expect(adapter.open).toHaveBeenCalledTimes(1)
    await act(async () => editor.unmount())
    const staleClick = new MouseEvent('click', { bubbles: true, metaKey: true, cancelable: true })
    staleClick.preventDefault()
    await act(async () => originalAnchor.dispatchEvent(staleClick))
    expect(adapter.open).toHaveBeenCalledTimes(1)
    await act(async () => editor.mount(second))
    await act(async () => second.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, cancelable: true })))
    expect(adapter.open).toHaveBeenCalledTimes(2)
  } finally { await dom.render(null); editor.destroy(); first.remove(); second.remove() }
})

it('captures a middle-click attachment through the original opener exactly once', async () => {
  prepare(); const adapter = platform(), note = attachment()
  await dom.render(<ClientUiProvider platform={adapter.value}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={serializeNoteDocument(note)} revision="original" /></ClientUiProvider>)
  const event = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
  await act(async () => dom.container.querySelector<HTMLAnchorElement>('.ProseMirror a')!.dispatchEvent(event))
  expect(event.defaultPrevented).toBe(true)
  expect(adapter.open).toHaveBeenCalledExactlyOnceWith(resource, './result.txt')
})

it('keeps relative attachments local when a standalone reader has no opener, while ordinary web links remain usable', async () => {
  prepare(); const note = attachment()
  const { openNoteLink: _openNoteLink, ...standalone } = platform().value
  note.content.content![0]!.content!.push({ type: 'text', text: 'Web reference', marks: [{ type: 'link', attrs: { href: 'https://example.com/reference' } }] })
  await dom.render(<ClientUiProvider platform={standalone}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={serializeNoteDocument(note)} revision="original" /></ClientUiProvider>)
  const anchors = [...dom.container.querySelectorAll<HTMLAnchorElement>('.ProseMirror a')]
  const relative = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => anchors[0]!.dispatchEvent(relative))
  expect(relative.defaultPrevented).toBe(true)
  expect(anchors[0]!.getAttribute('href')).toBe('./result.txt')
  expect(dom.container.querySelector('[role="status"]')).not.toBeNull()
  const external = new MouseEvent('click', { bubbles: true, cancelable: true })
  expect(anchors[1]!.getAttribute('href')).toBe('https://example.com/reference')
  await act(async () => anchors[1]!.dispatchEvent(external))
  expect(external.defaultPrevented).toBe(false)
  expect(anchors[1]!.getAttribute('href')).toBe('https://example.com/reference')
})

it('opens read-only authors independently from the adjacent attachment link', async () => {
  prepare(); const adapter = platform(), note = attachment()
  await dom.render(<ClientUiProvider platform={adapter.value}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={serializeNoteDocument(note)} revision="original" /></ClientUiProvider>)
  const author = dom.container.querySelector<HTMLButtonElement>('.note-block-author')!
  expect(author).not.toBeNull()
  const before = dom.container.querySelector<HTMLElement>('.ProseMirror')!.innerHTML
  await act(async () => author.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  expect(adapter.open).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"][aria-label="Block authors"]')).not.toBeNull()
  expect(author.closest('a')).toBeNull()
  expect(dom.container.querySelector('.ProseMirror')!.getAttribute('contenteditable')).toBe('false')
  expect(before).toContain('Read the attachment')
})

it('keeps image controls inside a linked image separate from attachment activation', async () => {
  prepare(); const adapter = platform(), note = attachment(), retry = vi.fn()
  adapter.value.renderNoteImage = () => <button type="button" data-image-retry="" onClick={retry}>Retry original image</button>
  note.content.content![0]!.content = [{ type: 'image', attrs: { src: './visual.png', alt: 'Original visual' }, marks: [{ type: 'link', attrs: { href: './result.txt' } }] }]
  await dom.render(<ClientUiProvider platform={adapter.value}><NoteReader resource={resource} workspaceId={resource.workspaceId} path={resource.path} content={serializeNoteDocument(note)} revision="original" /></ClientUiProvider>)
  const button = dom.container.querySelector<HTMLButtonElement>('[data-image-retry]')!
  expect(button.closest('a')).not.toBeNull()
  const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  await act(async () => button.dispatchEvent(key))
  expect(key.defaultPrevented).toBe(false)
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => button.dispatchEvent(click))
  expect(click.defaultPrevented).toBe(true)
  expect(retry).toHaveBeenCalledTimes(1)
  expect(adapter.open).not.toHaveBeenCalled()
})
