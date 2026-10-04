import type { NativeContentRange } from './native-history-source.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem } from './types.js'

export type NativeStringMetadata = {
  length: number
  trimmedStart: number
  trimmedEnd: number
  head: string
  tail: string
}
export function nativeStringMetadata(): NativeStringMetadata {
  return { length: 0, trimmedStart: 0, trimmedEnd: 0, head: '', tail: '' }
}
export function appendNativeStringMetadata(metadata: NativeStringMetadata, text: string): void {
  if (!metadata.trimmedEnd) metadata.trimmedStart += text.length - text.trimStart().length
  if (text.trim()) metadata.trimmedEnd = metadata.length + text.trimEnd().length
  metadata.length += text.length
  if (metadata.head.length < 1024) metadata.head = (metadata.head + text).slice(0, 1024)
  metadata.tail = (metadata.tail + text).slice(-1024)
}
export type NativeTextSegment = { literal: string } | {
  source: NativeContentRange
  metadata: NativeStringMetadata
  start: number
  end: number
  escapeDepth: number
  base64?: true
}

/** Internal physical value, never a string or a caller-created JSON object. */
export class NativeText {
  constructor(readonly segments: readonly NativeTextSegment[]) {}
  get length(): number {
    return this.segments.reduce((total, segment) => total + ('literal' in segment ? segment.literal.length : segment.end - segment.start), 0)
  }
  toString(): never { throw new TypeError('Native text requires an explicit Provider projection.') }
  toJSON(): never { throw new TypeError('Native text requires nativeJsonStringify.') }
}
export type NativeTextValue = string | NativeText
export type NativeHistoryContentPart = AgentSessionHistoryContentPart extends infer Part
  ? Part extends AgentSessionHistoryContentPart
    ? { [Key in keyof Part]: Key extends 'text' | 'input' | 'output' | 'reference' | 'signature' ? NativeTextValue : Part[Key] }
    : never
  : never
export type NativeHistoryItem = Omit<AgentSessionHistoryItem, 'contentParts'> & { contentParts: NativeHistoryContentPart[] }

export function isNativeText(value: unknown): value is NativeTextValue { return typeof value === 'string' || value instanceof NativeText }
export function nativeSourceText(source: NativeContentRange, metadata: NativeStringMetadata): NativeText {
  return new NativeText([{ source, metadata, start: 0, end: metadata.length, escapeDepth: 0 }])
}
function concatValues(values: Iterable<NativeTextValue>): NativeTextValue {
  const segments: NativeTextSegment[] = []
  let literals: string[] = [], deferred = false
  const flush = () => {
    if (literals.length) { segments.push({ literal: literals.join('') }); literals = [] }
  }
  for (const value of values) {
    if (typeof value === 'string') { literals.push(value); continue }
    deferred = true
    for (const segment of value.segments) {
      if ('literal' in segment) { literals.push(segment.literal); continue }
      flush(); segments.push({ ...segment })
    }
  }
  if (!deferred) return literals.join('')
  flush()
  return new NativeText(segments)
}
export function nativeTextConcat(...values: NativeTextValue[]): NativeTextValue {
  return concatValues(values)
}
export function nativeTextJoin(values: readonly NativeTextValue[], separator = '\n'): NativeTextValue {
  function* separated(): Iterable<NativeTextValue> {
    for (let index = 0; index < values.length; index++) {
      if (index) yield separator
      yield values[index]!
    }
  }
  return concatValues(separated())
}
export function nativeTextHasSpeech(value: NativeTextValue): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value.segments.some(segment => 'literal' in segment
    ? segment.literal.trim().length > 0
    : segment.start < segment.metadata.trimmedEnd && segment.end > segment.metadata.trimmedStart)
}
export function nativeTextTrim(value: NativeTextValue): NativeTextValue {
  if (typeof value === 'string') return value.trim()
  if (value.segments.length !== 1 || 'literal' in value.segments[0]!) throw new TypeError('Trim requires an original native string.')
  const segment = value.segments[0]!
  if ('literal' in segment || segment.escapeDepth || segment.base64) throw new TypeError('Trim requires an original native string.')
  const start = Math.max(segment.start, segment.metadata.trimmedStart)
  return new NativeText([{ ...segment, start, end: Math.max(start, Math.min(segment.end, segment.metadata.trimmedEnd)) }])
}
export function nativeTextBase64(value: NativeTextValue): NativeTextValue {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64')
  if (value.segments.length !== 1 || 'literal' in value.segments[0]!) throw new TypeError('Base64 requires an original native string.')
  return new NativeText(value.segments.map(segment => ({ ...segment, base64: true })))
}
export function nativeTextStartsWith(value: NativeTextValue, prefix: string): boolean {
  if (typeof value === 'string') return value.startsWith(prefix)
  const first = value.segments[0]
  return !!first && !('literal' in first) && first.start === 0 && first.metadata.head.startsWith(prefix)
}
export function nativeTextEndsWith(value: NativeTextValue, suffix: string): boolean {
  if (typeof value === 'string') return value.endsWith(suffix)
  const last = value.segments.at(-1)
  return !!last && !('literal' in last) && last.end === last.metadata.length && last.metadata.tail.endsWith(suffix)
}

function quote(value: NativeTextValue): NativeTextValue {
  if (typeof value === 'string') return JSON.stringify(value)
  return new NativeText([{ literal: '"' }, ...value.segments.map(segment => 'literal' in segment
    ? { literal: JSON.stringify(segment.literal).slice(1, -1) }
    : { ...segment, escapeDepth: segment.escapeDepth + 1 }), { literal: '"' }])
}

/** JSON formatting preserves deferred values instead of allowing ordinary stringify to erase them. */
export function nativeJsonStringify(value: unknown, _replacer?: null, space?: number): NativeTextValue {
  const indent = ' '.repeat(Math.min(10, Math.max(0, space ?? 0)))
  function stringify(current: unknown, depth: number): NativeTextValue | undefined {
    if (current instanceof NativeText) return quote(current)
    if (!current || typeof current !== 'object') return JSON.stringify(current)
    const array = Array.isArray(current), entries = array ? current.map((item, index) => [String(index), item] as const) : Object.entries(current)
    const formatted: NativeTextValue[] = []
    for (const [key, item] of entries) {
      const output = stringify(item, depth + 1)
      if (output === undefined && !array) continue
      formatted.push(nativeTextConcat(indent ? '\n' + indent.repeat(depth + 1) : '',
        array ? '' : JSON.stringify(key) + (indent ? ': ' : ':'), output ?? 'null'))
    }
    return nativeTextConcat(array ? '[' : '{', nativeTextJoin(formatted, ','),
      formatted.length && indent ? '\n' + indent.repeat(depth) : '', array ? ']' : '}')
  }
  return stringify(value, 0) as NativeTextValue
}
