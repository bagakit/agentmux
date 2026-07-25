import type { BrowserElementSelection } from '../shared/contracts.js'

export const BROWSER_SELECTION_LIMITS = {
  pageTitle: 512,
  pageUrl: 2_048,
  tagName: 64,
  role: 64,
  accessibleName: 512,
  selector: 1_024,
  text: 4_096,
  nearbyTextItems: 8,
  nearbyTextItem: 512,
  nearbyTextTotal: 2_048,
  attributeInputItems: 128,
  attributes: 24,
  attributeName: 64,
  attributeValue: 512,
  htmlInput: 32_768,
  htmlOutput: 8_192,
  htmlNodes: 256,
  htmlDepth: 24,
  htmlAttributesPerElement: 12,
  coordinate: 1_000_000,
  size: 1_000_000
} as const

type BrowserSelectionAttribute = {
  name: string
  value: string
}

export type SanitizedBrowserElementSelection = Omit<BrowserElementSelection, 'browserId' | 'navigationId'>

type UnknownRecord = Record<string, unknown>
type ParsedTag = {
  end: number
  closing: boolean
  name: string
  attributes: BrowserSelectionAttribute[]
  selfClosing: boolean
}

const RAW_SELECTION_KEYS = [
  'accessibleName',
  'attributes',
  'html',
  'isFixed',
  'nearbyText',
  'pageTitle',
  'pageUrl',
  'rectPage',
  'rectViewport',
  'role',
  'selector',
  'tagName',
  'text'
] as const
const RAW_RECT_KEYS = ['height', 'width', 'x', 'y'] as const

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'button', 'cite', 'code', 'dd', 'del',
  'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main',
  'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'u', 'ul', 'var'
])
const VOID_TAGS = new Set(['br', 'hr', 'img'])
const SUPPRESSED_CONTAINERS = new Set([
  'embed', 'head', 'iframe', 'math', 'noembed', 'noframes', 'noscript', 'object',
  'plaintext', 'script', 'style', 'svg', 'template', 'textarea', 'title', 'xmp'
])
const URL_ATTRIBUTES = new Set(['cite', 'href', 'src'])
const SAFE_ATTRIBUTES = new Set([
  'alt', 'class', 'datetime', 'dir', 'hidden', 'id', 'lang', 'placeholder', 'role',
  'tabindex', 'title',
  'aria-atomic', 'aria-busy', 'aria-checked', 'aria-controls', 'aria-current',
  'aria-describedby', 'aria-details', 'aria-disabled', 'aria-expanded',
  'aria-haspopup', 'aria-hidden', 'aria-label', 'aria-labelledby', 'aria-level',
  'aria-live', 'aria-modal', 'aria-multiline', 'aria-multiselectable',
  'aria-orientation', 'aria-placeholder', 'aria-pressed', 'aria-readonly',
  'aria-required', 'aria-roledescription', 'aria-selected', 'aria-sort',
  'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'
])
const UNSAFE_TEXT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as UnknownRecord
}

function assertExactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an invalid shape`)
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  const result = value.slice(0, limit)
  const last = result.charCodeAt(result.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result
}

function cleanScalar(value: string, limit: number): string {
  return truncate(value.replace(UNSAFE_TEXT_CHARACTERS, '').trim(), limit)
}

function cleanText(value: string, limit: number): string {
  return truncate(value.replace(UNSAFE_TEXT_CHARACTERS, ' ').replace(/\s+/g, ' ').trim(), limit)
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function httpUrl(value: string, limit: number): string | null {
  if (value.length > limit * 4) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const result = url.toString()
  return result.length <= limit ? result : null
}

function requiredPageUrl(value: unknown): string {
  const sanitized = httpUrl(string(value, 'Browser selection pageUrl'), BROWSER_SELECTION_LIMITS.pageUrl)
  if (!sanitized) throw new Error('Browser selection pageUrl must be a bounded HTTP(S) URL')
  return sanitized
}

function safeAttributeName(value: string): string | null {
  const name = value.toLowerCase()
  if (
    name.length < 1 ||
    name.length > BROWSER_SELECTION_LIMITS.attributeName ||
    !/^[a-z][a-z0-9:-]*$/.test(name) ||
    name.startsWith('on') ||
    name === 'style' ||
    name === 'srcdoc' ||
    name === 'nonce' ||
    name === 'integrity'
  ) {
    return null
  }
  if (!SAFE_ATTRIBUTES.has(name) && !URL_ATTRIBUTES.has(name)) return null
  return name
}

function safeAttribute(nameValue: string, rawValue: string): BrowserSelectionAttribute | null {
  const name = safeAttributeName(nameValue)
  if (!name) return null
  if (URL_ATTRIBUTES.has(name)) {
    const value = httpUrl(rawValue, BROWSER_SELECTION_LIMITS.attributeValue)
    return value ? { name, value } : null
  }
  return {
    name,
    value: cleanScalar(rawValue, BROWSER_SELECTION_LIMITS.attributeValue)
  }
}

function sanitizeAttributes(value: unknown): Record<string, string> {
  const input = record(value, 'Browser selection attributes')
  const entries = Object.entries(input)
  if (entries.length > BROWSER_SELECTION_LIMITS.attributeInputItems) {
    throw new Error('Browser selection attributes exceed the input budget')
  }
  const byName = new Map<string, BrowserSelectionAttribute>()
  for (const [name, value] of entries) {
    const attribute = safeAttribute(name, string(value, `Browser selection attribute ${name}`))
    if (attribute && !byName.has(attribute.name)) byName.set(attribute.name, attribute)
  }
  return Object.fromEntries(
    [...byName.values()]
      .sort((left, right) => compareAscii(left.name, right.name))
      .slice(0, BROWSER_SELECTION_LIMITS.attributes)
      .map(({ name, value }) => [name, value])
  )
}

function sanitizeNearbyText(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Browser selection nearbyText must be an array')
  const result: string[] = []
  const seen = new Set<string>()
  let remaining = BROWSER_SELECTION_LIMITS.nearbyTextTotal
  for (const item of value.slice(0, BROWSER_SELECTION_LIMITS.nearbyTextItems)) {
    const cleaned = cleanText(string(item, 'Browser selection nearbyText item'), Math.min(
      BROWSER_SELECTION_LIMITS.nearbyTextItem,
      remaining
    ))
    if (!cleaned || seen.has(cleaned)) continue
    result.push(cleaned)
    seen.add(cleaned)
    remaining -= cleaned.length
    if (remaining <= 0) break
  }
  return result
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return Object.is(value, -0) ? 0 : value
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function sanitizeRect(value: unknown, label: string): SanitizedBrowserElementSelection['rectViewport'] {
  const input = record(value, label)
  assertExactKeys(input, RAW_RECT_KEYS, label)
  return {
    x: clamp(finiteNumber(input.x, `${label}.x`), -BROWSER_SELECTION_LIMITS.coordinate, BROWSER_SELECTION_LIMITS.coordinate),
    y: clamp(finiteNumber(input.y, `${label}.y`), -BROWSER_SELECTION_LIMITS.coordinate, BROWSER_SELECTION_LIMITS.coordinate),
    width: clamp(finiteNumber(input.width, `${label}.width`), 0, BROWSER_SELECTION_LIMITS.size),
    height: clamp(finiteNumber(input.height, `${label}.height`), 0, BROWSER_SELECTION_LIMITS.size)
  }
}

function tagName(value: unknown): string {
  const result = cleanScalar(string(value, 'Browser selection tagName'), BROWSER_SELECTION_LIMITS.tagName).toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error('Browser selection tagName is invalid')
  return result
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t' || character === '\f'
}

function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9:-]/.test(character)
}

function parseTag(html: string, start: number): ParsedTag | null {
  let index = start + 1
  let closing = false
  if (html[index] === '/') {
    closing = true
    index += 1
  }
  while (isSpace(html[index])) index += 1
  const nameStart = index
  while (isNameCharacter(html[index])) index += 1
  if (index === nameStart) return null
  const name = html.slice(nameStart, index).toLowerCase()
  const attributes: BrowserSelectionAttribute[] = []
  let selfClosing = false

  while (index < html.length) {
    while (isSpace(html[index])) index += 1
    if (html[index] === '>') {
      return { end: index + 1, closing, name, attributes, selfClosing }
    }
    if (html[index] === '/' && html[index + 1] === '>') {
      selfClosing = true
      return { end: index + 2, closing, name, attributes, selfClosing }
    }
    const attributeStart = index
    while (
      index < html.length &&
      !isSpace(html[index]) &&
      html[index] !== '=' &&
      html[index] !== '/' &&
      html[index] !== '>' &&
      html[index] !== '<' &&
      html[index] !== '"' &&
      html[index] !== "'"
    ) {
      index += 1
    }
    if (index === attributeStart) {
      index += 1
      continue
    }
    const attributeName = html.slice(attributeStart, index)
    while (isSpace(html[index])) index += 1
    let attributeValue = ''
    if (html[index] === '=') {
      index += 1
      while (isSpace(html[index])) index += 1
      const quote = html[index] === '"' || html[index] === "'" ? html[index] : null
      if (quote) {
        index += 1
        const valueStart = index
        while (index < html.length && html[index] !== quote) index += 1
        if (index >= html.length) return null
        attributeValue = html.slice(valueStart, index)
        index += 1
      } else {
        const valueStart = index
        while (index < html.length && !isSpace(html[index]) && html[index] !== '>' && html[index] !== '<') index += 1
        attributeValue = html.slice(valueStart, index)
      }
    }
    if (attributes.length < BROWSER_SELECTION_LIMITS.htmlAttributesPerElement) {
      const attribute = safeAttribute(attributeName, attributeValue)
      if (attribute && !attributes.some(({ name }) => name === attribute.name)) attributes.push(attribute)
    }
  }
  return null
}

function escaped(value: string, attribute: boolean, limit: number): string {
  let result = ''
  for (const character of value) {
    if (UNSAFE_TEXT_CHARACTERS.test(character)) {
      UNSAFE_TEXT_CHARACTERS.lastIndex = 0
      continue
    }
    UNSAFE_TEXT_CHARACTERS.lastIndex = 0
    const encoded = character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : attribute && character === '"'
            ? '&quot;'
            : attribute && character === "'"
              ? '&#39;'
              : character
    if (result.length + encoded.length > limit) break
    result += encoded
  }
  return result
}

function htmlAttributes(attributes: readonly BrowserSelectionAttribute[]): string {
  const byName = new Map<string, BrowserSelectionAttribute>()
  for (const raw of attributes) {
    const attribute = safeAttribute(raw.name, raw.value)
    if (attribute && !byName.has(attribute.name)) byName.set(attribute.name, attribute)
  }
  return [...byName.values()]
    .sort((left, right) => compareAscii(left.name, right.name))
    .map(({ name, value }) => ` ${name}="${escaped(value, true, BROWSER_SELECTION_LIMITS.attributeValue * 6)}"`)
    .join('')
}

function sanitizeBrowserSelectionHtml(rawHtml: string): string {
  const html = truncate(rawHtml, BROWSER_SELECTION_LIMITS.htmlInput)
  const output: string[] = []
  const openTags: Array<{ name: string; close: string }> = []
  const suppressedTags: string[] = []
  let outputLength = 0
  let reservedClosingLength = 0
  let nodes = 0
  let index = 0

  const append = (value: string): boolean => {
    if (outputLength + reservedClosingLength + value.length > BROWSER_SELECTION_LIMITS.htmlOutput) return false
    output.push(value)
    outputLength += value.length
    return true
  }
  const closeFrom = (stackIndex: number): void => {
    while (openTags.length > stackIndex) {
      const tag = openTags.pop()
      if (!tag) break
      reservedClosingLength -= tag.close.length
      output.push(tag.close)
      outputLength += tag.close.length
    }
  }

  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4)
      if (end < 0) break
      index = end + 3
      continue
    }
    if (html[index] !== '<') {
      const next = html.indexOf('<', index)
      const end = next < 0 ? html.length : next
      if (suppressedTags.length === 0) {
        const capacity = BROWSER_SELECTION_LIMITS.htmlOutput - outputLength - reservedClosingLength
        append(escaped(html.slice(index, end), false, capacity))
      }
      index = end
      continue
    }
    if (html[index + 1] === '!' || html[index + 1] === '?') {
      const end = html.indexOf('>', index + 2)
      if (end < 0) break
      index = end + 1
      continue
    }
    const tag = parseTag(html, index)
    if (!tag) {
      if (suppressedTags.length === 0) append('&lt;')
      index += 1
      continue
    }
    index = tag.end

    if (suppressedTags.length > 0) {
      if (!tag.closing && SUPPRESSED_CONTAINERS.has(tag.name)) {
        suppressedTags.push(tag.name)
      } else if (tag.closing) {
        const match = suppressedTags.lastIndexOf(tag.name)
        if (match >= 0) suppressedTags.splice(match)
      }
      continue
    }
    if (!tag.closing && SUPPRESSED_CONTAINERS.has(tag.name)) {
      suppressedTags.push(tag.name)
      continue
    }
    if (!ALLOWED_TAGS.has(tag.name)) continue
    if (tag.closing) {
      const match = openTags.map(({ name }) => name).lastIndexOf(tag.name)
      if (match >= 0) closeFrom(match)
      continue
    }
    if (nodes >= BROWSER_SELECTION_LIMITS.htmlNodes) continue
    nodes += 1
    const start = `<${tag.name}${htmlAttributes(tag.attributes)}>`
    if (VOID_TAGS.has(tag.name)) {
      append(start)
      continue
    }
    if (openTags.length >= BROWSER_SELECTION_LIMITS.htmlDepth) continue
    const close = `</${tag.name}>`
    if (outputLength + reservedClosingLength + start.length + close.length > BROWSER_SELECTION_LIMITS.htmlOutput) continue
    output.push(start)
    outputLength += start.length
    reservedClosingLength += close.length
    openTags.push({ name: tag.name, close })
  }
  closeFrom(0)
  return output.join('')
}

export function sanitizeBrowserElementSelection(raw: unknown): SanitizedBrowserElementSelection {
  const input = record(raw, 'Browser selection')
  assertExactKeys(input, RAW_SELECTION_KEYS, 'Browser selection')
  return {
    pageTitle: cleanText(string(input.pageTitle, 'Browser selection pageTitle'), BROWSER_SELECTION_LIMITS.pageTitle),
    pageUrl: requiredPageUrl(input.pageUrl),
    tagName: tagName(input.tagName),
    role: cleanScalar(string(input.role, 'Browser selection role'), BROWSER_SELECTION_LIMITS.role),
    accessibleName: cleanText(
      string(input.accessibleName, 'Browser selection accessibleName'),
      BROWSER_SELECTION_LIMITS.accessibleName
    ),
    selector: cleanScalar(string(input.selector, 'Browser selection selector'), BROWSER_SELECTION_LIMITS.selector),
    text: cleanText(string(input.text, 'Browser selection text'), BROWSER_SELECTION_LIMITS.text),
    attributes: sanitizeAttributes(input.attributes),
    nearbyText: sanitizeNearbyText(input.nearbyText),
    html: sanitizeBrowserSelectionHtml(string(input.html, 'Browser selection html')),
    rectViewport: sanitizeRect(input.rectViewport, 'Browser selection rectViewport'),
    rectPage: sanitizeRect(input.rectPage, 'Browser selection rectPage'),
    isFixed: boolean(input.isFixed, 'Browser selection isFixed')
  }
}
