import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentProviderId } from '@agentmux/core'
import type { AgentAvatarAppearance } from '../../../shared/contracts'
import { AgentAvatarStaticArtwork } from '@agentmux/client-ui/components/AgentAvatarStaticArtwork'

export type BrowserOperatorAvatarColors = {
  mark: string
  enamel: string
  badge: string
  badgeBackground: string
}
export type BrowserOperatorAvatarInput = {
  document: Document
  providerId?: AgentProviderId | undefined
  appearance?: AgentAvatarAppearance | undefined
  colors: BrowserOperatorAvatarColors
}
export type BrowserOperatorAvatar = Readonly<{ dataUrl: string; width: 64; height: 64; byteLength: number }>
export type BrowserOperatorAvatarResult =
  | { status: 'ready'; avatar: BrowserOperatorAvatar }
  | { status: 'failed'; message: string }

const SVG_NS = 'http://www.w3.org/2000/svg'
const PNG_PREFIX = 'data:image/png;base64,'
const MAX_PNG_BYTES = 64 * 1024
const MAX_READY_IMAGES = 32
const DECODE_BUDGET_MS = 2_000
const ICON_PEN = ['--icon-stroke-width', '--icon-linecap', '--icon-linejoin'] as const
const caches = new WeakMap<Document, {
  ready: Map<string, BrowserOperatorAvatar>
  inflight: Map<string, Promise<BrowserOperatorAvatarResult>>
}>()

type Artwork = {
  key: string
  svg: string
  sources: readonly string[]
  symbols: ReadonlyMap<string, Element | null>
  pen: readonly (readonly [string, string])[]
}

/** Only the existing Provider primitive chooses URLs. No caller or page supplies a resource. */
function artwork(input: BrowserOperatorAvatarInput): Artwork {
  const sources = new Set<string>()
  const svg = renderToStaticMarkup(<AgentAvatarStaticArtwork providerId={input.providerId}
    appearance={input.appearance} colors={input.colors}
    renderRaster={(source, size) => {
      sources.add(source)
      return <image href={source} width={size} height={size} />
    }} />)
  // These names are emitted by our static SemanticIcon nodes, never parsed from a page or label.
  const names = new Set([...svg.matchAll(/data-semantic-icon="([^"]+)"/gu)].map(match => match[1]!))
  const symbols = new Map([...names].map(name => {
    const id = `agentmux-icon-${name}`
    return [id, input.document.getElementById(id)?.cloneNode(true) as Element | null ?? null] as const
  }))
  const style = input.document.defaultView?.getComputedStyle(input.document.documentElement)
  const pen = ICON_PEN.map(name => [name, style?.getPropertyValue(name).trim() ?? ''] as const)
  const key = JSON.stringify([svg, [...symbols].map(([id, node]) => [id, node?.outerHTML ?? null]), pen])
  return { key, svg, sources: [...sources], symbols, pen }
}

/** Pure presentation key includes the actual theme sprite, not a new Agent identity. */
export function browserOperatorAvatarKey(input: BrowserOperatorAvatarInput): string {
  try { return artwork(input).key } catch { return 'unavailable-static-avatar' }
}

function cache(document: Document) {
  let value = caches.get(document)
  if (!value) { value = { ready: new Map(), inflight: new Map() }; caches.set(document, value) }
  return value
}

/** Synchronous and side-effect free with respect to generation: a miss never starts decoding. */
export function readBrowserOperatorAvatar(input: BrowserOperatorAvatarInput): BrowserOperatorAvatar | undefined {
  try { return caches.get(input.document)?.ready.get(browserOperatorAvatarKey(input)) } catch { return undefined }
}

async function decodedImage(document: Document, source: string): Promise<HTMLImageElement> {
  const image = document.createElement('img')
  image.decoding = 'async'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    image.src = source
    await Promise.race([image.decode(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The static avatar image could not be decoded in time.')), DECODE_BUDGET_MS)
    })])
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The static avatar image is empty.')
    return image
  } catch (error) { image.removeAttribute('src'); throw error }
  finally { clearTimeout(timer) }
}

function pngFromCanvas(canvas: HTMLCanvasElement): BrowserOperatorAvatar {
  const dataUrl = canvas.toDataURL('image/png')
  if (!dataUrl.startsWith(PNG_PREFIX)) throw new Error('The static avatar could not be encoded as PNG.')
  const base64 = dataUrl.slice(PNG_PREFIX.length)
  if (!base64.length || base64.length > 4 * Math.ceil(MAX_PNG_BYTES / 3)) throw new Error('The static avatar exceeds its image byte budget.')
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 33 || bytes.length > MAX_PNG_BYTES || signature.some((byte, index) => bytes[index] !== byte) ||
      new DataView(bytes.buffer).getUint32(16) !== 64 || new DataView(bytes.buffer).getUint32(20) !== 64) {
    throw new Error('The static avatar does not contain the original 64 by 64 PNG.')
  }
  return Object.freeze({ dataUrl, width: 64, height: 64, byteLength: bytes.length })
}

async function raster(document: Document, source: string): Promise<BrowserOperatorAvatar> {
  const image = await decodedImage(document, source)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The static avatar canvas is unavailable.')
    context.drawImage(image, 0, 0, 64, 64)
    return pngFromCanvas(canvas)
  } finally { image.removeAttribute('src'); canvas.width = canvas.height = 0 }
}

async function render(document: Document, original: Artwork): Promise<BrowserOperatorAvatar> {
  const window = document.defaultView
  if (!window) throw new Error('The original avatar document is unavailable.')
  const parsed = new window.DOMParser().parseFromString(original.svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) throw new Error('The static avatar SVG is unavailable.')
  const svg = parsed.documentElement
  for (const [name, value] of original.pen) if (value) (svg as unknown as SVGSVGElement).style.setProperty(name, value)
  for (const use of [...svg.querySelectorAll('use')]) {
    const href = use.getAttribute('href')
    const source = href?.startsWith('#') ? original.symbols.get(href.slice(1)) : null
    if (!source || source.localName !== 'symbol') throw new Error('The original themed avatar artwork is unavailable.')
    const group = parsed.createElementNS(SVG_NS, 'g')
    for (const child of source.childNodes) group.append(parsed.importNode(child, true))
    use.replaceWith(group)
  }
  const images = await Promise.all(original.sources.map(async source => [source, (await raster(document, source)).dataUrl] as const))
  const inline = new Map(images)
  for (const image of svg.querySelectorAll('image')) {
    const source = image.getAttribute('href')
    const dataUrl = source ? inline.get(source) : undefined
    if (!dataUrl) throw new Error('The original bundled avatar image is unavailable.')
    image.setAttribute('href', dataUrl)
  }
  if (svg.querySelector('foreignObject,script,use')) throw new Error('The static avatar contains unsupported drawing content.')
  const source = new window.XMLSerializer().serializeToString(svg)
  return raster(document, `data:image/svg+xml,${encodeURIComponent(source)}`)
}

/** Start in the background. The caller never awaits this Promise before a Browser action. */
export function prepareBrowserOperatorAvatar(input: BrowserOperatorAvatarInput): Promise<BrowserOperatorAvatarResult> {
  let original: Artwork
  try { original = artwork(input) }
  catch { return Promise.resolve({ status: 'failed', message: 'The static Agent avatar is unavailable. The original Agent name remains visible.' }) }
  const document = input.document
  const value = cache(document), ready = value.ready.get(original.key)
  if (ready) return Promise.resolve({ status: 'ready', avatar: ready })
  const inflight = value.inflight.get(original.key)
  if (inflight) return inflight
  const work: Promise<BrowserOperatorAvatarResult> = Promise.resolve().then(() => render(document, original)).then(avatar => {
    value.ready.set(original.key, avatar)
    while (value.ready.size > MAX_READY_IMAGES) value.ready.delete(value.ready.keys().next().value!)
    return { status: 'ready' as const, avatar }
  }).catch(() => ({ status: 'failed' as const,
    message: 'The static Agent avatar could not be drawn. The original Agent name remains visible; prepare it again to retry.'
  })).finally(() => { if (value.inflight.get(original.key) === work) value.inflight.delete(original.key) })
  value.inflight.set(original.key, work)
  return work
}
