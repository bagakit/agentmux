// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { ScreenshotEditor } from '../src/renderer/src/components/browser-screenshot/ScreenshotEditor'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import type { ImageAnnotationInput } from '../src/renderer/src/components/image-annotation/types'
import type { NoteShape, ScreenshotShape, TextShape } from '../src/renderer/src/components/image-annotation/drawing-model'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'
import { formatScreenshotContext } from '../src/renderer/src/components/browser-screenshot/context'
import { api } from '../src/renderer/src/lib/api'

// These tests exercise actual string/document/host consumers. Image decode and raster pixels
// are separate native proof boundaries; neither substitute decides the text assertions.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer: vi.fn(), renderScreenshotScene: vi.fn() }))
const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', width: 1, height: 1 }
const text: TextShape = { id: 'original-text', kind: 'text', color: '#ef4444', fontSize: .05, at: { x: .1, y: .1 }, text: '  ' + '字'.repeat(501) + '\t ' }
const note: NoteShape = { id: 'original-note', kind: 'note', color: '#3b82f6', radius: .03, width: .01,
  from: { x: .1, y: .1 }, to: { x: .5, y: .5 }, number: 7, note: '\r\n  ' + '注'.repeat(1001) + '  \r\n', template: 'observation' }
const source = { url: 'https://example.invalid/original', title: 'Original source', viewport: null, viewportWarning: null }
function original(shapes: ScreenshotShape[]) { return createEditableAnnotationDocument({ image, shapes, crop: null, source }, ANNOTATION_DOCUMENT_LIMITS) }
class Decoder {
  naturalWidth = 1; naturalHeight = 1
  onload: (() => void) | null = null
  set src(_value: string) { queueMicrotask(() => this.onload?.()) }
}
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement, frames: Map<number, FrameRequestCallback>, nextFrame: number
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('Image', Decoder)
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function editor() { const found = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]'); expect(found).not.toBeNull(); return found! }
function button(scope: ParentNode, name: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
  expect(found, name).toBeDefined(); return found!
}
async function click(name: string) {
  if (name === 'Save original') {
    await act(async () => { const trigger = button(editor(), 'Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Save original…')
    expect(item).toBeDefined(); await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  } else await act(async () => button(editor(), name).click())
  await frame()
}
function change(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
async function loaded() { await act(async () => editor().querySelector('img')!.dispatchEvent(new Event('load'))); await frame() }
async function mount(shapes: ScreenshotShape[]) {
  const document = original(shapes), complete = vi.fn<(input: ImageAnnotationInput) => void>()
  await act(async () => root.render(<ImageAnnotationEditor image={document.image} initialState={document} busy={false} onCancel={vi.fn()}
    onComplete={complete} onCopyContext={complete} onSaveOriginal={complete} />))
  await frame(); await loaded()
  const canvas = editor().querySelector('canvas')!; canvas.setPointerCapture = vi.fn()
  const pointer = async () => { await act(async () => {
    for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 82, clientY: 32 }))
  }); await frame() }
  const output = async (action = 'Copy PNG') => { await click(action); expect(complete).toHaveBeenCalled(); return complete.mock.lastCall![0].shapes }
  return { pointer, output }
}
async function editExistingText(pointer: () => Promise<void>) { await click('Select'); await pointer(); await click('Edit text')
  const field = editor().querySelector<HTMLInputElement>('[aria-label="Screenshot text"]'); expect(field).not.toBeNull(); return field! }
async function submitOriginal(path: string) {
  const modal = document.querySelector<HTMLElement>('.annotation-file-dialog')!; expect(modal).not.toBeNull()
  await act(async () => change(modal.querySelector('input')!, path))
  await act(async () => modal.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); await frame()
}

describe('complete editable annotation text', () => {
  it('preserves codec-accepted existing text when Enter or Blur submits it unchanged', async () => {
    const { pointer, output } = await mount([text])
    for (const method of ['Enter', 'Blur']) {
      const field = await editExistingText(pointer)
      expect(field.value).toBe(text.text)
      await act(async () => method === 'Enter'
        ? field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        : field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
      await frame()
      expect((await output())[0], 'unchanged original text remains exact').toEqual(text)
      expect(button(editor(), 'Undo').disabled, 'unchanged submission is not an edit').toBe(true)
    }
  })

  it('keeps untouched control-normalized text in pending Copy and Save snapshots', async () => {
    const multiline = { ...text, text: '  Original\r\nsecond\rthird\n  ' }, { pointer, output } = await mount([multiline])
    const field = await editExistingText(pointer)
    expect(field.value, 'the actual single-line control normalizes the loaded value').toBe(multiline.text.replace(/[\r\n]/g, ''))
    expect(await output('Copy PNG'), 'pending untouched text keeps its original string').toEqual([multiline])
    expect(await output('Copy context')).toEqual([multiline])
    expect(await output('Save original')).toEqual([multiline])
    expect(button(editor(), 'Undo').disabled).toBe(true)
  })

  it('preserves the selected original note through real file save and context output', async () => {
    const document = original([text, note]), content = encodeEditableAnnotationDocument(document, ANNOTATION_DOCUMENT_LIMITS)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'original.json', content, revision: 'original-revision' } })
    const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-revision' }), contexts: string[] = []
    await act(async () => root.render(<ScreenshotEditor workspaceId="original-workspace" busy={false} onCancel={vi.fn()} onComplete={vi.fn()}
      onCopyContext={input => contexts.push(formatScreenshotContext(input.capture, input, { mimeType: 'image/png', ...image, byteLength: 68 }, input.source))} />))
    await frame(); await submitOriginal('original.json'); await loaded()
    expect(read).toHaveBeenCalledExactlyOnceWith('original-workspace', 'original.json')
    await click('Note 7')
    // happy-dom retains CRLF in textarea.value; real browsers normalize it without an input edit.
    // The returned document/context below must retain the original bytes in either environment.
    expect(editor().querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!.value.replace(/\r\n/g, '\n')).toBe(note.note.replace(/\r\n/g, '\n'))
    await click('Copy context')
    const context = JSON.parse(contexts[0]!.slice(contexts[0]!.indexOf('{')))
    expect(context.annotations.find((shape: { id: string }) => shape.id === note.id).note, 'selected original note output remains exact').toBe(note.note)
    expect(context.source).toEqual(source); expect(context.browserId).toBeNull()
    await click('Save original'); await submitOriginal('original.json')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.lastCall![0]).toBe('original-workspace'); expect(write.mock.lastCall![1].expectedRevision).toBe('original-revision')
    expect(parseEditableAnnotationDocument(write.mock.lastCall![1].content, ANNOTATION_DOCUMENT_LIMITS), 'save preserves the complete accepted original').toEqual(document)
    const template = editor().querySelector<HTMLSelectElement>('[aria-label="Note template"]')!
    await act(async () => { template.value = 'expected'; template.dispatchEvent(new Event('change', { bubbles: true })) })
    await click('Save original'); await submitOriginal('original.json')
    expect(parseEditableAnnotationDocument(write.mock.lastCall![1].content, ANNOTATION_DOCUMENT_LIMITS).shapes).toEqual([text, { ...note, template: 'expected' }])
  })

  it('keeps explicit long text and note edits complete and Undoable without character caps', async () => {
    const { pointer, output } = await mount([{ ...text, text: 'Before' }, { ...note, from: { x: .6, y: .6 }, to: { x: .9, y: .9 }, note: 'Before note' }])
    const field = await editExistingText(pointer)
    expect(field.hasAttribute('maxlength'), 'the text control admits the document format').toBe(false)
    await act(async () => { change(field, text.text); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await frame()
    expect((await output())[0], 'explicit text edit remains exact').toEqual(text)
    await click('Undo'); expect((await output())[0]).toEqual({ ...text, text: 'Before' }); await click('Redo')
    await click('Note 7'); const draft = editor().querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!
    expect(draft.hasAttribute('maxlength'), 'the note control admits the document format').toBe(false)
    const editedNote = note.note.replace(/\r\n/g, '\n')
    await act(async () => { change(draft, editedNote); draft.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }); await frame()
    expect((await output())[1]).toMatchObject({ note: editedNote })
    await click('Undo'); expect((await output())[1]).toMatchObject({ note: 'Before note' })
  })

  it('preserves an unchanged whitespace original and only removes text after an explicit clear', async () => {
    const whitespace = { ...text, text: '  \t  ' }, { pointer, output } = await mount([whitespace])
    let field = await editExistingText(pointer)
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); await frame()
    expect(await output()).toEqual([whitespace]); expect(button(editor(), 'Undo').disabled).toBe(true)
    field = await editExistingText(pointer)
    await act(async () => { change(field, ''); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await frame()
    expect(await output()).toEqual([])
    await click('Undo'); expect(await output()).toEqual([whitespace])
    await click('Text'); await pointer()
    field = editor().querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
    await act(async () => { change(field, ' \t '); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await frame()
    expect(await output(), 'blank new text creates no annotation').toEqual([whitespace])
  })
})
