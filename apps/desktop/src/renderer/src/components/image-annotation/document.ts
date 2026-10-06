import { shapeBounds, type NormalizedRect, type ScreenshotPoint, type ScreenshotShape } from './drawing-model'
import type { AnnotationImage } from './types'

export type AnnotationHistoricalSource = {
  url: string | null
  title: string | null
  viewport: { width: number; height: number; deviceScaleFactor: number | null } | null
  viewportWarning: string | null
} | null

/** An editable original can retain pixels and notes hidden by its masks. */
export type EditableAnnotationDocument = {
  schema: 'agentmux.image-annotation.v1'
  image: AnnotationImage
  shapes: ScreenshotShape[]
  crop: NormalizedRect | null
  source: AnnotationHistoricalSource
}

/** The host supplies its actual file and image resource boundaries. */
export type AnnotationDocumentLimits = {
  maxDocumentBytes: number
  maxImageBytes: number
  maxImageDimension: number
  maxImagePixels: number
}

export class AnnotationDocumentError extends Error {
  constructor(public readonly code: 'ANNOTATION_DOCUMENT_INVALID' | 'ANNOTATION_DOCUMENT_VERSION' |
    'ANNOTATION_DOCUMENT_TOO_LARGE' | 'ANNOTATION_IMAGE_INVALID' | 'ANNOTATION_IMAGE_TOO_LARGE', message: string) {
    super(message)
    this.name = 'AnnotationDocumentError'
  }
}

const schema = 'agentmux.image-annotation.v1' as const
function invalid(message: string): never { throw new AnnotationDocumentError('ANNOTATION_DOCUMENT_INVALID', message) }
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('An annotation document field must be an object.')
  const object = value as Record<string, unknown>
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key)))
    invalid('The annotation document contains missing or unsupported fields.')
  return object
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Annotation coordinates and styles must be finite numbers.')
  return value
}
function positive(value: unknown): number {
  const number = finite(value)
  if (number <= 0) invalid('Annotation dimensions and styles must be positive.')
  return number
}
function text(value: unknown): string {
  if (typeof value !== 'string') invalid('Annotation text must be a string.')
  return value
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value) }
function point(value: unknown): ScreenshotPoint {
  const object = record(value, ['x', 'y'])
  return { x: finite(object.x), y: finite(object.y) }
}
function checkLimits(limits: AnnotationDocumentLimits): void {
  if (![limits.maxDocumentBytes, limits.maxImageBytes, limits.maxImageDimension, limits.maxImagePixels]
    .every(value => Number.isSafeInteger(value) && value > 0)) invalid('The host must supply its original file and image limits.')
}
function checkDocumentBytes(content: string, limits: AnnotationDocumentLimits): void {
  if (content.length > limits.maxDocumentBytes || new TextEncoder().encode(content).byteLength > limits.maxDocumentBytes)
    throw new AnnotationDocumentError('ANNOTATION_DOCUMENT_TOO_LARGE', 'The complete editable original exceeds the file byte budget.')
}

function image(value: unknown, limits: AnnotationDocumentLimits): AnnotationImage {
  const object = record(value, ['dataUrl', 'width', 'height'])
  const width = positive(object.width), height = positive(object.height), dataUrl = text(object.dataUrl)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new AnnotationDocumentError('ANNOTATION_IMAGE_INVALID', 'The annotation image must have integer pixel dimensions.')
  if (width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels)
    throw new AnnotationDocumentError('ANNOTATION_IMAGE_TOO_LARGE', 'The annotation image exceeds the original image pixel budget.')
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) throw new AnnotationDocumentError('ANNOTATION_IMAGE_INVALID', 'An editable annotation requires an embedded PNG image.')
  const body = dataUrl.slice(prefix.length)
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  const byteLength = body.length / 4 * 3 - padding
  if (byteLength > limits.maxImageBytes)
    throw new AnnotationDocumentError('ANNOTATION_IMAGE_TOO_LARGE', 'The annotation PNG exceeds the original image byte budget.')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (body.length % 4 !== 0 || byteLength < 33 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body) ||
    padding === 2 && (alphabet.indexOf(body.at(-3)!) & 15) !== 0 ||
    padding === 1 && (alphabet.indexOf(body.at(-2)!) & 3) !== 0)
    throw new AnnotationDocumentError('ANNOTATION_IMAGE_INVALID', 'The embedded PNG base64 is invalid.')
  // Only decode the fixed PNG header here. The host must fully decode before replacing its editor.
  const header = atob(body.slice(0, 44))
  const numberAt = (offset: number) => header.charCodeAt(offset) * 0x1000000 +
    header.charCodeAt(offset + 1) * 0x10000 + header.charCodeAt(offset + 2) * 0x100 + header.charCodeAt(offset + 3)
  if (!header.startsWith('\x89PNG\r\n\x1a\n') || numberAt(8) !== 13 || header.slice(12, 16) !== 'IHDR' ||
    numberAt(16) !== width || numberAt(20) !== height)
    throw new AnnotationDocumentError('ANNOTATION_IMAGE_INVALID', 'The PNG header does not match the saved image dimensions.')
  return { dataUrl, width, height }
}

function shape(value: unknown): ScreenshotShape {
  const base = record(value, ['kind', 'id', 'color'], ['points', 'width', 'from', 'to', 'at', 'text', 'fontSize', 'radius', 'number', 'note', 'blockSize', 'template'])
  const kind = text(base.kind), id = text(base.id), color = text(base.color)
  if (!id || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) invalid('Annotation IDs must be nonempty and colors must be opaque hexadecimal colors.')
  const common = { id, color }
  const fields = ['kind', 'id', 'color']
  if (kind === 'pen' || kind === 'highlight') {
    record(value, [...fields, 'points', 'width'])
    if (!Array.isArray(base.points) || !base.points.length) invalid('A stroke must contain its original points.')
    return { ...common, kind, points: base.points.map(point), width: positive(base.width) }
  }
  if (kind === 'text') {
    record(value, [...fields, 'at', 'text', 'fontSize'])
    return { ...common, kind, at: point(base.at), text: text(base.text), fontSize: positive(base.fontSize) }
  }
  if (kind === 'note') {
    record(value, [...fields, 'from', 'to', 'width', 'radius', 'number', 'note'], ['template'])
    const number = positive(base.number)
    if (!Number.isSafeInteger(number)) invalid('A numbered note must have a positive integer number.')
    if (base.template !== undefined && !['observation', 'expected', 'request'].includes(text(base.template))) invalid('The note template is unsupported.')
    return { ...common, kind, from: point(base.from), to: point(base.to), width: positive(base.width),
      radius: positive(base.radius), number, note: text(base.note),
      ...(base.template === undefined ? {} : { template: base.template as 'observation' | 'expected' | 'request' }) }
  }
  if (kind === 'pixelate') {
    record(value, [...fields, 'from', 'to', 'blockSize'])
    return { ...common, kind, from: point(base.from), to: point(base.to), blockSize: positive(base.blockSize) }
  }
  if (kind === 'cover') {
    record(value, [...fields, 'from', 'to'])
    return { ...common, kind, from: point(base.from), to: point(base.to) }
  }
  if (kind === 'rect' || kind === 'ellipse' || kind === 'arrow') {
    record(value, [...fields, 'from', 'to', 'width'])
    return { ...common, kind, from: point(base.from), to: point(base.to), width: positive(base.width) }
  }
  return invalid('The annotation shape kind is unsupported.')
}

function historicalSource(value: unknown): AnnotationHistoricalSource {
  if (value === null) return null
  const source = record(value, ['url', 'title', 'viewport', 'viewportWarning'])
  let viewport: NonNullable<AnnotationHistoricalSource>['viewport'] = null
  if (source.viewport !== null) {
    const observed = record(source.viewport, ['width', 'height', 'deviceScaleFactor'])
    viewport = { width: positive(observed.width), height: positive(observed.height),
      deviceScaleFactor: observed.deviceScaleFactor === null ? null : positive(observed.deviceScaleFactor) }
  }
  return { url: nullableText(source.url), title: nullableText(source.title), viewport, viewportWarning: nullableText(source.viewportWarning) }
}

function documentValue(value: unknown, limits: AnnotationDocumentLimits): EditableAnnotationDocument {
  checkLimits(limits)
  const object = record(value, ['schema', 'image', 'shapes', 'crop', 'source'])
  if (object.schema !== schema) throw new AnnotationDocumentError('ANNOTATION_DOCUMENT_VERSION', 'The editable annotation document version is unsupported.')
  const original = image(object.image, limits)
  if (!Array.isArray(object.shapes)) invalid('The annotation document must contain a shape list.')
  const shapes = object.shapes.map(shape), ids = new Set(shapes.map(item => item.id))
  if (ids.size !== shapes.length) invalid('The annotation document contains duplicate shape IDs.')
  for (const shape of shapes) {
    const bounds = shapeBounds(shape)
    if (![bounds.x, bounds.y, bounds.width, bounds.height, bounds.x + bounds.width, bounds.y + bounds.height].every(Number.isFinite))
      invalid('Annotation geometry must remain finite when its bounds are calculated.')
  }
  let crop: NormalizedRect | null = null
  if (object.crop !== null) {
    const rectangle = record(object.crop, ['x', 'y', 'width', 'height'])
    crop = { x: finite(rectangle.x), y: finite(rectangle.y), width: positive(rectangle.width), height: positive(rectangle.height) }
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > original.width || crop.y + crop.height > original.height)
      invalid('The saved crop must be within the original image pixels.')
  }
  return { schema, image: original, shapes, crop, source: historicalSource(object.source) }
}

export function createEditableAnnotationDocument(input: Omit<EditableAnnotationDocument, 'schema'>, limits: AnnotationDocumentLimits): EditableAnnotationDocument {
  const document = documentValue({ schema, ...input }, limits)
  checkDocumentBytes(JSON.stringify(document), limits)
  return document
}

export function encodeEditableAnnotationDocument(document: EditableAnnotationDocument, limits: AnnotationDocumentLimits): string {
  const content = JSON.stringify(documentValue(document, limits))
  checkDocumentBytes(content, limits)
  return content
}

export function parseEditableAnnotationDocument(content: string, limits: AnnotationDocumentLimits): EditableAnnotationDocument {
  checkLimits(limits)
  checkDocumentBytes(content, limits)
  let value: unknown
  try { value = JSON.parse(content) } catch { return invalid('The editable annotation file is not valid JSON.') }
  return documentValue(value, limits)
}
