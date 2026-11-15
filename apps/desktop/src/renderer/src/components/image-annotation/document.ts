import { ADJUST_FACTOR_RANGE, ADJUST_SHARPEN_RANGE, BLUR_RADIUS_RANGE, CALLOUT_ZOOM_RANGE, OUTLINE_LIMITS, SPOTLIGHT_DIM_RANGE, isAxisAlignedOutline, normalizeRect, outlineExtent, shapeBounds,
  type NormalizedRect, type ScreenshotOutline, type ScreenshotPoint, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'
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
function inRange(value: unknown, range: { min: number; max: number }, message: string): number {
  const number = finite(value)
  if (number < range.min || number > range.max) invalid(message)
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
/** A wand outline: closed rings of at least three points within the limits, lying inside from/to so bounds, hits and
 * note filtering cover it. Over the limits it is refused, never truncated: a cut ring would redact less than the selection. */
function outline(value: unknown, from: ScreenshotPoint, to: ScreenshotPoint): { outline?: ScreenshotOutline } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || !value.length) invalid('A region outline must contain closed rings.')
  if (value.length > OUTLINE_LIMITS.rings) invalid('The region outline has too many rings.')
  let points = 0
  const rings = value.map(ring => {
    if (!Array.isArray(ring) || ring.length < 3) invalid('Each region outline ring must contain at least three points.')
    points += ring.length
    if (points > OUTLINE_LIMITS.points) invalid('The region outline has too many points.')
    return ring.map(point)
  })
  const extent = outlineExtent(rings), region = normalizeRect(from, to)
  if (!extent || extent.from.x < region.x || extent.from.y < region.y || extent.to.x > region.x + region.width || extent.to.y > region.y + region.height)
    invalid('A region outline must have an area and lie inside its region.')
  // The renderer covers every canvas pixel an outline touches only for horizontal and vertical edges, which a wand outline always has.
  if (!isAxisAlignedOutline(rings)) invalid('Each region outline edge must be horizontal or vertical.')
  return { outline: rings }
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
  const base = record(value, ['kind', 'id', 'color'], ['points', 'width', 'from', 'to', 'at', 'text', 'fontSize', 'radius', 'number', 'note', 'blockSize', 'template', 'dim', 'zoom', 'locked', 'outline',
    'brightness', 'contrast', 'saturation', 'sharpen'])
  const kind = text(base.kind), id = text(base.id), color = text(base.color)
  if (!id || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) invalid('Annotation IDs must be nonempty and colors must be opaque hexadecimal colors.')
  if (base.locked !== undefined && base.locked !== true) invalid('A locked annotation must record locked as true.')
  const common = { id, color, ...(base.locked ? { locked: true as const } : {}) }
  const fields = ['kind', 'id', 'color'], lockable = ['locked']
  if (kind === 'pen' || kind === 'highlight' || kind === 'pixelate-brush') {
    record(value, [...fields, 'points', 'width', ...(kind === 'pixelate-brush' ? ['blockSize'] : [])], lockable)
    if (!Array.isArray(base.points) || !base.points.length) invalid('A stroke must contain its original points.')
    const stroke = { ...common, points: base.points.map(point), width: positive(base.width) }
    return kind === 'pixelate-brush' ? { ...stroke, kind, blockSize: positive(base.blockSize) } : { ...stroke, kind }
  }
  if (kind === 'text') {
    record(value, [...fields, 'at', 'text', 'fontSize'], lockable)
    return { ...common, kind, at: point(base.at), text: text(base.text), fontSize: positive(base.fontSize) }
  }
  if (kind === 'note') {
    record(value, [...fields, 'from', 'to', 'width', 'radius', 'number', 'note'], ['template', ...lockable])
    const number = positive(base.number)
    if (!Number.isSafeInteger(number)) invalid('A numbered note must have a positive integer number.')
    if (base.template !== undefined && !['observation', 'expected', 'request'].includes(text(base.template))) invalid('The note template is unsupported.')
    return { ...common, kind, from: point(base.from), to: point(base.to), width: positive(base.width),
      radius: positive(base.radius), number, note: text(base.note),
      ...(base.template === undefined ? {} : { template: base.template as 'observation' | 'expected' | 'request' }) }
  }
  if (kind === 'pixelate') {
    record(value, [...fields, 'from', 'to', 'blockSize'], [...lockable, 'outline'])
    const from = point(base.from), to = point(base.to)
    return { ...common, kind, from, to, ...outline(base.outline, from, to), blockSize: positive(base.blockSize) }
  }
  if (kind === 'blur') {
    record(value, [...fields, 'from', 'to', 'radius'], [...lockable, 'outline'])
    const from = point(base.from), to = point(base.to)
    return { ...common, kind, from, to, ...outline(base.outline, from, to), radius: inRange(base.radius, BLUR_RADIUS_RANGE, 'The blur strength is out of range.') }
  }
  if (kind === 'spotlight') {
    record(value, [...fields, 'from', 'to', 'dim'], [...lockable, 'outline'])
    const from = point(base.from), to = point(base.to)
    return { ...common, kind, from, to, ...outline(base.outline, from, to), dim: inRange(base.dim, SPOTLIGHT_DIM_RANGE, 'The spotlight dimming is out of range.') }
  }
  if (kind === 'callout') {
    record(value, [...fields, 'from', 'to', 'at', 'zoom'], lockable)
    return { ...common, kind, from: point(base.from), to: point(base.to), at: point(base.at), zoom: inRange(base.zoom, CALLOUT_ZOOM_RANGE, 'The callout zoom is out of range.') }
  }
  if (kind === 'cover' || kind === 'region-highlight') {
    record(value, [...fields, 'from', 'to'], [...lockable, 'outline'])
    const from = point(base.from), to = point(base.to)
    return { ...common, kind, from, to, ...outline(base.outline, from, to) }
  }
  if (kind === 'adjust') {
    record(value, [...fields, 'from', 'to', 'brightness', 'contrast', 'saturation', 'sharpen'], [...lockable, 'outline'])
    const from = point(base.from), to = point(base.to), factor = (field: unknown) => inRange(field, ADJUST_FACTOR_RANGE, 'The adjustment is out of range.')
    return { ...common, kind, from, to, ...outline(base.outline, from, to), brightness: factor(base.brightness), contrast: factor(base.contrast),
      saturation: factor(base.saturation), sharpen: inRange(base.sharpen, ADJUST_SHARPEN_RANGE, 'The adjustment is out of range.') }
  }
  if (kind === 'rect' || kind === 'ellipse' || kind === 'arrow') {
    record(value, [...fields, 'from', 'to', 'width'], lockable)
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
