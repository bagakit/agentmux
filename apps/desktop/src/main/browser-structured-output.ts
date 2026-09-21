import { z } from 'zod'
import { BROWSER_RESULT_MAX_READ_BYTES, type BrowserResultArtifactReference } from '../shared/browser-result-artifact.js'
import { BROWSER_STRUCTURED_LIMITS, type BrowserStructuredDocument, type BrowserStructuredField,
  type BrowserStructuredFieldSummary, type BrowserStructuredOutputReceipt, type BrowserStructuredOutputRequest,
  type BrowserStructuredSource, type BrowserStructuredWork } from '../shared/browser-structured-output.js'

const selector = z.string().min(1).max(BROWSER_STRUCTURED_LIMITS.selectorCharacters).refine(value => value.trim().length > 0)
const attribute = z.string().max(64).refine(value =>
  /^(?:aria-[a-z-]+|data-[a-z0-9_.:-]+|id|role|title|name|type|value|href|src|alt|checked|disabled|datetime|rel)$/.test(value))
const fieldSchema = z.object({
  key: z.string().min(1).max(64).refine(value => value.trim().length > 0),
  type: z.enum(['string', 'number', 'boolean']),
  source: z.object({ selector, read: z.enum(['text', 'value', 'checked', 'attribute']), attribute: attribute.optional() }).strict()
    .refine(source => source.read === 'attribute' ? source.attribute !== undefined : source.attribute === undefined,
      'attribute is required only for attribute reads')
}).strict()
const requestSchema = z.object({
  within: selector.optional(), withinRef: z.string().regex(/^@e\d+$/).max(64).optional(),
  fields: z.array(fieldSchema).min(1).max(BROWSER_STRUCTURED_LIMITS.fields)
}).strict().refine(request => !(request.within && request.withinRef), 'within and withinRef are mutually exclusive')
  .refine(request => new Set(request.fields.map(field => field.key)).size === request.fields.length, 'field keys must be unique')

export function parseBrowserStructuredOutputRequest(value: unknown): BrowserStructuredOutputRequest {
  const parsed = requestSchema.parse(value)
  return { ...(parsed.within !== undefined ? { within: parsed.within } : {}),
    ...(parsed.withinRef !== undefined ? { withinRef: parsed.withinRef } : {}),
    fields: parsed.fields.map(field => ({ key: field.key, type: field.type,
      source: { selector: field.source.selector, read: field.source.read,
        ...(field.source.attribute !== undefined ? { attribute: field.source.attribute } : {}) } })) }
}

type DomField = { key: string; status: 'read'; value: string | boolean } | {
  key: string; status: 'missing' | 'ambiguous' | 'unavailable' | 'truncated'; detail: string; preview?: string | undefined
}
type DomRead = { documentUrl: string; current: boolean; complete: boolean; fields: DomField[]; work: BrowserStructuredWork }

/** Self-contained: executed on the existing T002-resolved Document/Element in its actual frame. */
function readStructuredDom(this: Document | Element, request: BrowserStructuredOutputRequest, limits: typeof BROWSER_STRUCTURED_LIMITS): DomRead {
  const root = this
  const doc = root.nodeType === 9 ? root as Document : root.ownerDocument!
  const documentUrl = doc.URL
  const current = () => root.isConnected && doc.defaultView?.document === doc && doc.URL === documentUrl
  const work: BrowserStructuredWork = { visitedElements: 0, elementWalkSteps: 0, selectorChecks: 0, textNodes: 0, textWalkSteps: 0, reads: 0, readBytes: 0 }
  const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 256)
  const matches: Element[][] = request.fields.map(() => [])
  const errors = new Map<number, string>()
  for (let index = 0; index < request.fields.length; index += 1) {
    try { work.selectorChecks += 1; doc.documentElement.matches(request.fields[index]!.source.selector) }
    catch (error) { errors.set(index, message(error)) }
  }
  const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */)
  const next = () => { work.elementWalkSteps += 1; return walker.nextNode() as Element | null }
  let element = root.nodeType === 1 ? root as Element : next()
  while (element && work.visitedElements < limits.elements) {
    work.visitedElements += 1
    for (let index = 0; index < request.fields.length; index += 1) {
      if (errors.has(index) || matches[index]!.length >= 2) continue
      try {
        work.selectorChecks += 1
        if (element.matches(request.fields[index]!.source.selector)) matches[index]!.push(element)
      } catch (error) { errors.set(index, message(error)) }
    }
    element = next()
  }
  const complete = element === null
  const readString = (value: string, state: { text: string; bytes: number }): boolean => {
    for (const char of value) {
      const code = char.codePointAt(0)!
      const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
      if (state.bytes + bytes > limits.fieldBytes || work.readBytes + bytes > limits.totalBytes) return false
      state.text += char; state.bytes += bytes; work.readBytes += bytes
    }
    return true
  }
  const fields: DomField[] = request.fields.map((field, index) => {
    const identity = { key: field.key }
    if (errors.has(index)) return { ...identity, status: 'unavailable', detail: `Invalid selector: ${errors.get(index)}` }
    const found = matches[index]!
    if (found.length >= 2) return { ...identity, status: 'ambiguous', detail: 'At least two elements matched.' }
    if (!complete) return { ...identity, status: 'truncated', detail: 'Element scan budget ended before uniqueness or absence was established.' }
    if (found.length === 0) return { ...identity, status: 'missing', detail: 'No element matched in the complete rooted scan.' }
    const target = found[0]!
    const state = { text: '', bytes: 0 }
    work.reads += 1
    try {
      if (field.source.read === 'checked') {
        if (target.tagName !== 'INPUT') return { ...identity, status: 'unavailable', detail: 'checked requires an input element.' }
        return { ...identity, status: 'read', value: (target as HTMLInputElement).checked }
      }
      if (field.source.read === 'text') {
        const text = doc.createTreeWalker(target, 4 /* SHOW_TEXT */)
        for (;;) {
          if (work.textNodes >= limits.textNodes) return { ...identity, status: 'truncated', detail: 'Text node budget ended.', preview: state.text }
          work.textWalkSteps += 1
          const node = text.nextNode()
          if (!node) break
          work.textNodes += 1
          if (!readString(node.nodeValue ?? '', state)) return { ...identity, status: 'truncated', detail: 'Field or total byte budget ended.', preview: state.text }
        }
      } else {
        let value: string | null
        if (field.source.read === 'attribute') value = target.getAttribute(field.source.attribute!)
        else {
          if (!['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON'].includes(target.tagName)) return { ...identity, status: 'unavailable', detail: 'value is unavailable on this element.' }
          value = (target as HTMLInputElement).value
        }
        if (value === null) return { ...identity, status: 'missing', detail: 'The matched element has no requested attribute.' }
        if (!readString(value, state)) return { ...identity, status: 'truncated', detail: 'Field or total byte budget ended.', preview: state.text }
      }
      return { ...identity, status: 'read', value: state.text }
    } catch (error) { return { ...identity, status: 'unavailable', detail: `Read failed: ${message(error)}` } }
  })
  return { documentUrl, current: current(), complete, fields, work }
}

/** Budgets are trusted constants embedded by Main, not extra script options. */
export function buildBrowserStructuredReadDeclaration(): string {
  return `function(request) { return (${readStructuredDom.toString()}).call(this, request, ${JSON.stringify(BROWSER_STRUCTURED_LIMITS)}); }`
}

const workSchema = z.object({
  visitedElements: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.elements),
  elementWalkSteps: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.elements + 1),
  selectorChecks: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.fields * (BROWSER_STRUCTURED_LIMITS.elements + 1)),
  textNodes: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.textNodes),
  textWalkSteps: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.textNodes + BROWSER_STRUCTURED_LIMITS.fields),
  reads: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.fields),
  readBytes: z.number().int().min(0).max(BROWSER_STRUCTURED_LIMITS.totalBytes)
}).strict()
const boundedValue = z.union([z.string().refine(value => Buffer.byteLength(value) <= BROWSER_STRUCTURED_LIMITS.fieldBytes), z.boolean()])
const identityString = z.string().min(1).max(128)
const capturedSourceSchema = z.object({
  workspaceId: identityString.nullable(), browserId: identityString, operationId: identityString, navigationId: identityString,
  url: z.string().min(1).max(16 * 1024), document: identityString, documentUrl: z.string().min(1).max(16 * 1024),
  scope: z.object({ kind: z.enum(['page', 'subtree']), within: selector.optional(), withinRef: z.string().regex(/^@e\d+$/).max(64).optional() }).strict()
}).strict()
const capturedFieldSchema = z.union([
  fieldSchema.extend({ status: z.literal('observed'), value: z.union([boundedValue, z.number().finite()]) }).strict()
    .refine(field => typeof field.value === field.type, 'Observed scalar must match the declared type'),
  fieldSchema.extend({ status: z.literal('type-error'), actual: boundedValue, detail: z.string().min(1).max(512) }).strict(),
  fieldSchema.extend({ status: z.literal('truncated'), detail: z.string().min(1).max(512), preview: z.string()
    .refine(value => Buffer.byteLength(value) <= BROWSER_STRUCTURED_LIMITS.fieldBytes).optional() }).strict(),
  fieldSchema.extend({ status: z.enum(['missing', 'ambiguous', 'unavailable', 'page-changed']), detail: z.string().min(1).max(512) }).strict()
])
const capturedDocumentSchema = z.object({
  schema: z.literal('browser-structured-output.v1'), request: requestSchema, source: capturedSourceSchema,
  fields: z.array(capturedFieldSchema).min(1).max(BROWSER_STRUCTURED_LIMITS.fields), work: workSchema
}).strict().refine(document => document.fields.length === document.request.fields.length && document.fields.every((field, index) => {
  const requested = document.request.fields[index]!
  return field.key === requested.key && field.type === requested.type && field.source.selector === requested.source.selector &&
    field.source.read === requested.source.read && field.source.attribute === requested.source.attribute
}), 'Captured fields must retain the exact requested schema and sources')
  .refine(document => document.source.scope.kind === (document.request.within || document.request.withinRef ? 'subtree' : 'page') &&
    document.source.scope.within === document.request.within && document.source.scope.withinRef === document.request.withinRef,
  'Captured document scope must match the request')

/** Shape validation only. T009 must also verify Main's trusted T003 extraction provenance. */
export function parseBrowserStructuredOutputDocument(value: unknown): BrowserStructuredDocument {
  const parsed = capturedDocumentSchema.parse(value)
  const request = parseBrowserStructuredOutputRequest(parsed.request)
  const fields: BrowserStructuredField[] = parsed.fields.map((field, index) => {
    const identity = request.fields[index]!
    if (field.status === 'observed') return { ...identity, status: field.status, value: field.value }
    if (field.status === 'type-error') return { ...identity, status: field.status, actual: field.actual, detail: field.detail }
    return { ...identity, status: field.status, detail: field.detail,
      ...(field.status === 'truncated' && field.preview !== undefined ? { preview: field.preview } : {}) }
  })
  return { schema: parsed.schema, request, fields, work: parsed.work, source: { ...parsed.source,
    scope: { kind: parsed.source.scope.kind, ...(parsed.source.scope.within !== undefined ? { within: parsed.source.scope.within } : {}),
      ...(parsed.source.scope.withinRef !== undefined ? { withinRef: parsed.source.scope.withinRef } : {}) } } }
}

const domReadSchema = z.object({
  documentUrl: z.string().max(16 * 1024), current: z.boolean(), complete: z.boolean(), work: workSchema,
  fields: z.array(z.union([
    z.object({ key: z.string(), status: z.literal('read'), value: boundedValue }).strict(),
    z.object({ key: z.string(), status: z.enum(['missing', 'ambiguous', 'unavailable', 'truncated']), detail: z.string().max(512),
      preview: z.string().refine(value => Buffer.byteLength(value) <= BROWSER_STRUCTURED_LIMITS.fieldBytes).optional() }).strict()
  ])).max(BROWSER_STRUCTURED_LIMITS.fields)
}).strict()

function typedField(field: BrowserStructuredOutputRequest['fields'][number], observed: DomField): BrowserStructuredField {
  if (observed.status !== 'read') return { ...field, status: observed.status, detail: observed.detail,
    ...(observed.status === 'truncated' && observed.preview !== undefined ? { preview: observed.preview } : {}) }
  let value: unknown = observed.value
  if (field.type !== 'string' && typeof value === 'string') {
    try { value = JSON.parse(value.trim()) } catch { value = undefined }
  }
  const valid = field.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === field.type
  if (!valid) return { ...field, status: 'type-error', actual: observed.value, detail: `Observed value is not a ${field.type}; no default or coercion was applied.` }
  return { ...field, status: 'observed', value: value as string | number | boolean }
}

function preview(value: string): string {
  let text = '', bytes = 0
  for (const char of value) {
    const size = Buffer.byteLength(char)
    if (bytes + size > BROWSER_STRUCTURED_LIMITS.previewBytes) break
    text += char; bytes += size
  }
  return text
}
function summarize(field: BrowserStructuredField): BrowserStructuredFieldSummary {
  const identity = { key: field.key, type: field.type, source: field.source }
  if (field.status === 'observed' || field.status === 'type-error') {
    const value = field.status === 'observed' ? field.value : field.actual
    const valueBytes = typeof value === 'string' ? Buffer.byteLength(value) : Buffer.byteLength(JSON.stringify(value))
    const inline = valueBytes <= BROWSER_STRUCTURED_LIMITS.previewBytes
    return { ...identity, status: field.status, inline, valueBytes,
      ...(inline ? field.status === 'observed' ? { value } : { actual: value as string | boolean } : { preview: preview(value as string) }),
      ...(field.status === 'type-error' ? { detail: field.detail } : {}) }
  }
  return { ...identity, status: field.status, inline: false, detail: field.detail,
    ...(field.status === 'truncated' && field.preview !== undefined ? { preview: preview(field.preview) } : {}) }
}

export type BrowserStructuredOutputContext = {
  source: Omit<BrowserStructuredSource, 'documentUrl'>
  /** Existing authorized rooted target and frame sender; CDP exceptions must throw. */
  read(declaration: string, request: BrowserStructuredOutputRequest): Promise<unknown>
  /** Actual current entry/view/navigation and resolved document, checked before and after work. */
  isCurrent(): boolean
  /** The sole T003 Owner imports this exact document and returns its bound reference. */
  register(document: BrowserStructuredDocument, source: BrowserStructuredSource): Promise<BrowserResultArtifactReference>
}

export async function extractBrowserStructuredOutput(input: unknown, context: BrowserStructuredOutputContext): Promise<BrowserStructuredOutputReceipt> {
  const request = parseBrowserStructuredOutputRequest(input)
  // Copy trusted owner facts once: mutable caller projections cannot relabel the captured document.
  const owner = structuredClone(context.source)
  let source: BrowserStructuredSource = { ...owner, documentUrl: null }
  const failed = (status: 'page-changed' | 'unavailable', warning: string, work: BrowserStructuredWork | null = null): BrowserStructuredOutputReceipt => ({
    kind: 'browser-structured-output', status, source, work, artifactStatus: 'not-recorded', warning,
    fields: request.fields.map(field => ({ ...field, status, inline: false, detail: warning }))
  })
  if (owner.scope.kind !== (request.within || request.withinRef ? 'subtree' : 'page') ||
    owner.scope.within !== request.within || owner.scope.withinRef !== request.withinRef) {
    return failed('unavailable', 'The resolved document scope does not match the requested scope; no fields were read.')
  }
  if (!context.isCurrent()) return failed('page-changed', 'The Browser document changed before extraction; no fields were read.')
  let read: DomRead
  try {
    read = domReadSchema.parse(await context.read(buildBrowserStructuredReadDeclaration(), request))
    if (read.fields.length !== request.fields.length || read.fields.some((field, index) => field.key !== request.fields[index]!.key)) throw new Error('DOM field identities do not match the requested schema.')
  } catch (error) {
    if (!context.isCurrent()) return failed('page-changed', 'The Browser document changed before the DOM read could be verified.')
    return failed('unavailable', `Structured DOM read is unavailable: ${String(error instanceof Error ? error.message : error).slice(0, 512)}`)
  }
  source = { ...owner, documentUrl: read.documentUrl }
  if (!read.current || !context.isCurrent()) return failed('page-changed', 'The Browser document changed during extraction; old fields were not registered as current.', read.work)
  const fields = request.fields.map((field, index) => typedField(field, read.fields[index]!))
  const document: BrowserStructuredDocument = { schema: 'browser-structured-output.v1', request, source, fields, work: read.work }
  const receipt: BrowserStructuredOutputReceipt = { kind: 'browser-structured-output',
    status: fields.every(field => field.status === 'observed') ? 'complete' : 'partial', source,
    fields: fields.map(summarize), work: read.work, artifactStatus: 'unavailable' }
  try {
    parseBrowserStructuredOutputDocument(document)
    const artifact = await context.register(document, source)
    if (artifact.kind !== 'browser-result-artifact' || artifact.format !== 'json' || artifact.workspaceId !== source.workspaceId ||
      artifact.browserId !== source.browserId || artifact.operationId !== source.operationId || artifact.navigationId !== source.navigationId ||
      artifact.byteLength !== Buffer.byteLength(JSON.stringify(document)) || artifact.maxReadBytes !== BROWSER_RESULT_MAX_READ_BYTES) {
      throw new Error('The registered artifact does not match the captured source or document bytes.')
    }
    if (!context.isCurrent()) return failed('page-changed', 'The Browser document changed while saving; the captured artifact is not presented as current.', read.work)
    return { ...receipt, artifactStatus: 'available', artifact }
  } catch (error) {
    if (!context.isCurrent()) return failed('page-changed', 'The Browser document changed before the artifact could be verified.', read.work)
    return { ...receipt, status: 'partial', warning: `Observed fields remain available, but their result artifact could not be registered: ${String(error instanceof Error ? error.message : error).slice(0, 512)}` }
  }
}
