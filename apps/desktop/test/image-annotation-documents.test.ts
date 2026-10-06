import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { AgentMuxDesktopApi, WorkspaceRecord } from '../src/shared/contracts'
import { ANNOTATION_DOCUMENT_LIMITS, readEditableAnnotationFile, saveEditableAnnotationFile } from '../src/renderer/src/components/browser-screenshot/document-files'
import { AnnotationDocumentError, createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument,
  type AnnotationDocumentLimits, type EditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import type { ScreenshotShape } from '../src/renderer/src/components/image-annotation/drawing-model'

// A complete PNG keeps the codec test honest; full image decoding belongs to the native UI proof.
const image = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
const shapes: ScreenshotShape[] = [
  { id: 'pen', kind: 'pen', color: '#ef4444', width: 3, points: [{ x: .1, y: .2 }, { x: .7, y: .8 }] },
  { id: 'highlight', kind: 'highlight', color: '#eab308', width: 9, points: [{ x: .2, y: .3 }] },
  { id: 'arrow', kind: 'arrow', color: '#ef4444', width: 2, from: { x: .1, y: .2 }, to: { x: .9, y: .8 } },
  { id: 'rect', kind: 'rect', color: '#22c55e', width: 2, from: { x: .1, y: .1 }, to: { x: .8, y: .7 } },
  { id: 'ellipse', kind: 'ellipse', color: '#3b82f6', width: 1, from: { x: .2, y: .2 }, to: { x: .9, y: .8 } },
  { id: 'text', kind: 'text', color: '#ffffff', fontSize: 18, at: { x: .2, y: .3 }, text: 'Existing text' },
  { id: 'note', kind: 'note', color: '#ef4444', width: 2, radius: 12, number: 1, note: 'Editable hidden note 原文', template: 'request', from: { x: .1, y: .1 }, to: { x: .8, y: .8 } },
  { id: 'pixelate', kind: 'pixelate', color: '#000', blockSize: 16, from: { x: .1, y: .1 }, to: { x: .8, y: .8 } },
  { id: 'cover', kind: 'cover', color: '#111827', from: { x: .3, y: .2 }, to: { x: .9, y: .9 } }
]
function original(): EditableAnnotationDocument {
  return createEditableAnnotationDocument({ image, shapes, crop: { x: .1, y: .1, width: .8, height: .8 }, source: {
    url: 'https://example.invalid/historical', title: 'Historical capture', viewport: { width: 400, height: 300, deviceScaleFactor: null }, viewportWarning: 'Historical viewport unavailable'
  } }, ANNOTATION_DOCUMENT_LIMITS)
}
function fails(input: unknown, code: AnnotationDocumentError['code'], limits: AnnotationDocumentLimits = ANNOTATION_DOCUMENT_LIMITS) {
  try { parseEditableAnnotationDocument(JSON.stringify(input), limits); throw new Error('Invalid document was accepted') }
  catch (error) { expect(error).toBeInstanceOf(AnnotationDocumentError); expect(error).toMatchObject({ code }) }
}
type Files = Pick<AgentMuxDesktopApi['files'], 'read' | 'write'>

describe('editable image annotation documents', () => {
  it('round trips every shape, exact pixels, IDs, crop and historical metadata without serializing runtime identity or Undo', () => {
    const before = original(), content = encodeEditableAnnotationDocument(before, ANNOTATION_DOCUMENT_LIMITS)
    const reopened = parseEditableAnnotationDocument(content, ANNOTATION_DOCUMENT_LIMITS)
    expect(reopened).toEqual(before)
    expect(reopened).not.toBe(before); expect(reopened.shapes).not.toBe(before.shapes)
    expect(reopened.shapes.map(shape => shape.kind)).toEqual(['pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'note', 'pixelate', 'cover'])
    expect(reopened.shapes.find(shape => shape.id === 'note')).toMatchObject({ note: 'Editable hidden note 原文', template: 'request' })
    expect(Object.keys(JSON.parse(content))).toEqual(['schema', 'image', 'shapes', 'crop', 'source'])
    expect(Object.keys(reopened.source!)).toEqual(['url', 'title', 'viewport', 'viewportWarning'])
    expect(reopened.image.dataUrl).toBe(image.dataUrl)
  })

  it('keeps unknown historical source explicit and accepts the host byte budget at its exact UTF-8 boundary', () => {
    const doc = { ...original(), source: null }
    const content = encodeEditableAnnotationDocument(doc, ANNOTATION_DOCUMENT_LIMITS)
    const bytes = new TextEncoder().encode(content).byteLength
    expect(parseEditableAnnotationDocument(content, { ...ANNOTATION_DOCUMENT_LIMITS, maxDocumentBytes: bytes })).toEqual(doc)
    fails(doc, 'ANNOTATION_DOCUMENT_TOO_LARGE', { ...ANNOTATION_DOCUMENT_LIMITS, maxDocumentBytes: bytes - 1 })
  })

  it.each([
    ['version', (doc: any) => { doc.schema = 'agentmux.image-annotation.v2' }, 'ANNOTATION_DOCUMENT_VERSION'],
    ['unexpected runtime identity', (doc: any) => { doc.browserId = 'another-owner' }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['duplicate shape identity', (doc: any) => { doc.shapes[1].id = doc.shapes[0].id }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['unsupported note template', (doc: any) => { doc.shapes[6].template = 'invented' }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['transparent cover', (doc: any) => { doc.shapes[8].color = '#11182780' }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['out-of-image crop', (doc: any) => { doc.crop.width = 2 }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['PNG dimension mismatch', (doc: any) => { doc.image.width = 2 }, 'ANNOTATION_IMAGE_INVALID'],
    ['non-PNG bytes', (doc: any) => { doc.image.dataUrl = 'data:image/png;base64,' + btoa('not a png'.repeat(9)) }, 'ANNOTATION_IMAGE_INVALID'],
    ['invalid source viewport', (doc: any) => { doc.source.viewport.width = 0 }, 'ANNOTATION_DOCUMENT_INVALID'],
    ['overflowing shape bounds', (doc: any) => { doc.shapes[5].at.x = 1e308; doc.shapes[5].fontSize = 1e308 }, 'ANNOTATION_DOCUMENT_INVALID']
  ] as const)('rejects %s before any host file operation', (_name, change, code) => {
    const input = JSON.parse(JSON.stringify(original())); change(input); fails(input, code)
  })

  it('enforces image byte, dimension and pixel budgets independently', () => {
    const doc = original()
    fails(doc, 'ANNOTATION_IMAGE_TOO_LARGE', { ...ANNOTATION_DOCUMENT_LIMITS, maxImageBytes: 1 })
    fails({ ...doc, image: { ...image, width: 2 } }, 'ANNOTATION_IMAGE_TOO_LARGE', { ...ANNOTATION_DOCUMENT_LIMITS, maxImageDimension: 1 })
    fails({ ...doc, image: { ...image, width: 2 } }, 'ANNOTATION_IMAGE_TOO_LARGE', { ...ANNOTATION_DOCUMENT_LIMITS, maxImagePixels: 1 })
  })

  it('writes and reopens through the actual WorkspaceFiles owner, retaining revision conflicts and the original file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-annotation-document-'))
    const workspace: WorkspaceRecord = { id: 'annotation-workspace', name: 'Annotation fixture', hostId: 'local', path: directory, kind: 'folder' }
    const owner = new WorkspaceFiles(() => ({ id: 'local', kind: 'local', label: 'Local fixture', run: vi.fn(), dispose: async () => {} } as ExecutionHost))
    const files: Files = {
      read: vi.fn(async (workspaceId, path) => { expect(workspaceId).toBe(workspace.id); return owner.read(workspace, path) }),
      write: vi.fn(async (workspaceId, input) => { expect(workspaceId).toBe(workspace.id); return owner.write(workspace, input) })
    }
    try {
      const doc = original(), path = 'editable.image-annotation.json'
      const created = await saveEditableAnnotationFile(files, { workspaceId: workspace.id, path, document: doc, expectedRevision: null })
      expect(created.status, JSON.stringify(created)).toBe('written'); expect(files.write).toHaveBeenCalledTimes(1); expect(files.read).not.toHaveBeenCalled()
      const content = await readFile(join(directory, path), 'utf8')
      expect(JSON.parse(content)).toEqual(doc)
      const opened = await readEditableAnnotationFile(files, { workspaceId: workspace.id, path })
      expect(opened).toMatchObject({ status: 'read', document: doc, content })
      if (opened.status !== 'read') throw new Error('Actual owner did not reopen its file')
      const changed = { ...doc, shapes: doc.shapes.filter(shape => shape.id !== 'ellipse') }
      const saved = await saveEditableAnnotationFile(files, { workspaceId: workspace.id, path, document: changed, expectedRevision: opened.revision })
      expect(saved.status).toBe('written')
      expect(await saveEditableAnnotationFile(files, { workspaceId: workspace.id, path, document: doc, expectedRevision: opened.revision }))
        .toMatchObject({ status: 'conflict' })
      expect(await saveEditableAnnotationFile(files, { workspaceId: workspace.id, path, document: doc, expectedRevision: null }))
        .toMatchObject({ status: 'conflict' })
      expect(JSON.parse(await readFile(join(directory, path), 'utf8'))).toEqual(changed)
      expect(files.write).toHaveBeenCalledTimes(4); expect(files.read).toHaveBeenCalledTimes(1)
    } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('uses the exact explicit path and revision for one write and never retries an unknown acknowledgement', async () => {
    const files: Files = { read: vi.fn(), write: vi.fn().mockRejectedValue(new Error('Reply channel lost')) }
    const doc = original()
    await expect(saveEditableAnnotationFile(files, { workspaceId: 'original-workspace', path: 'chosen/original.json', document: doc, expectedRevision: 'original-revision' }))
      .resolves.toMatchObject({ status: 'unknown', code: 'ANNOTATION_FILE_WRITE_UNCONFIRMED' })
    expect(files.write).toHaveBeenCalledExactlyOnceWith('original-workspace', {
      path: 'chosen/original.json', content: encodeEditableAnnotationDocument(doc, ANNOTATION_DOCUMENT_LIMITS), expectedRevision: 'original-revision'
    })
    expect(files.read).not.toHaveBeenCalled()
  })

  it('rejects an invalid save before write and preserves the exact read error instead of replacing the document', async () => {
    const error = { status: 'error' as const, code: 'WORKSPACE_UNAVAILABLE', message: 'Original owner unavailable' }
    const files: Files = { read: vi.fn().mockResolvedValue(error), write: vi.fn() }
    await expect(saveEditableAnnotationFile(files, { workspaceId: 'original', path: 'chosen.json', document: { ...original(), crop: { x: 0, y: 0, width: 2, height: 2 } }, expectedRevision: null }))
      .resolves.toMatchObject({ status: 'error', code: 'ANNOTATION_DOCUMENT_INVALID' })
    expect(files.write).not.toHaveBeenCalled()
    await expect(readEditableAnnotationFile(files, { workspaceId: 'original', path: 'chosen.json' })).resolves.toBe(error)
    expect(files.read).toHaveBeenCalledExactlyOnceWith('original', 'chosen.json')
  })

  it.each(['deleted', 'directory', 'binary'] as const)('keeps a %s read scoped to the requested file with no write', async status => {
    const files: Files = { read: vi.fn().mockResolvedValue({ status }), write: vi.fn() }
    await expect(readEditableAnnotationFile(files, { workspaceId: 'original', path: 'chosen.json' }))
      .resolves.toMatchObject({ status: 'error', code: 'ANNOTATION_FILE_' + status.toUpperCase() })
    expect(files.read).toHaveBeenCalledExactlyOnceWith('original', 'chosen.json'); expect(files.write).not.toHaveBeenCalled()
  })
})
