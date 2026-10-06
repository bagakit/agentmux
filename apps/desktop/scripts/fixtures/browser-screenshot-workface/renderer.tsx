import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { rendererPerformance } from '../../../src/renderer/src/lib/renderer-performance'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/chrome.css'
import '../../../src/renderer/src/styles/browser.css'
import '../../../src/renderer/src/styles/agent.css'
import './fixture.css'

const errors: string[] = []; (window as any).screenshotErrors = errors
const events: Array<{ type: string; trusted: boolean; target: string | null; x?: number; y?: number; key?: string }> = []
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'keyup']) {
  document.addEventListener(type, event => {
    const target = event.target as Element
    events.push({ type, trusted: event.isTrusted, target: target?.tagName === 'CANVAS' ? 'canvas' : target?.closest('button')?.textContent?.trim() ?? target?.getAttribute('aria-label'),
      x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, key: (event as KeyboardEvent).key })
  }, true)
}
let holdNextEncoding = false, heldEncoding: (() => void) | undefined, encoded = 0
let referencePixels: Uint8ClampedArray | undefined
const nativeToBlob = HTMLCanvasElement.prototype.toBlob
HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
  const held = holdNextEncoding; holdNextEncoding = false
  return nativeToBlob.call(this, blob => {
    encoded++
    if (held) heldEncoding = () => { heldEncoding = undefined; callback(blob) }
    else callback(blob)
  }, type, quality)
}
const theme = mountThemeRuntime(window)
const setup = await (window as any).screenshotNative.call('setup')
let warning: string | undefined
function Fixture() {
  warning = useNativeOverlayChrome()
  return <DesktopClientUiProvider><main className="screenshot-native-fixture">
    <header><strong>Browser screenshot</strong><span>Private native workface</span></header>
    <section className="screenshot-native-fixture__original">
      <BrowserPane tab={{ ...setup.original, browserId: setup.original.id, kind: 'browser', regionId: 'private-original-region', workspaceId: 'private-workspace' }} visible />
    </section>
  </main></DesktopClientUiProvider>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
;(window as any).screenshotProbe = {
  read() {
    const editor = document.querySelector('.image-annotation-editor'), canvas = editor?.querySelector('canvas')
    const box = (node: Element | null) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
    const matrix = canvas?.getContext('2d')?.getTransform(), dpr = canvas && canvas.getBoundingClientRect().width ? canvas.width / canvas.getBoundingClientRect().width : 1
    return { editor: !!editor, bounds: box(editor), canvas: box(canvas ?? null), canvasPixels: canvas ? [canvas.width, canvas.height] : null,
      imageView: matrix ? { scale: matrix.a / dpr, x: matrix.e / dpr, y: matrix.f / dpr } : null,
      canvasCost: (window as any).__annotationCanvasCost ?? null,
      withinStage: !!editor?.closest('[data-native-browser-stage]'), imageLoaded: !!editor?.querySelector<HTMLImageElement>('img')?.complete,
      copying: !![...document.querySelectorAll('button')].find(button => button.textContent?.includes('Copying')),
      cancelDisabled: [...(editor?.querySelectorAll('button') ?? [])].find(button => button.textContent?.includes('Cancel'))?.disabled,
      events: events.slice(), errors: errors.slice(), warning, encoded, encodingHeld: !!heldEncoding,
      appearance: document.documentElement.dataset.appearance,
      activeElement: document.activeElement?.getAttribute('aria-label'),
      bodyPointerEvents: document.body.style.pointerEvents,
      overlay: rendererPerformance.snapshot().overlay }
  },
  inkPixels() {
    const canvas = document.querySelector('.image-annotation-editor canvas') as HTMLCanvasElement
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) throw new Error('The actual screenshot canvas is absent')
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0, changed = 0, left = canvas.width, top = canvas.height, right = 0, bottom = 0
    for (let i = 0; i < pixels.length; i += 4) {
      // The source page is deliberately blue/white. Alpha is never an ink oracle: the
      // actual Editor paints the captured page as its base, so every source pixel is opaque.
      if (pixels[i]! > 180 && pixels[i + 1]! < 120 && pixels[i + 2]! < 130 && pixels[i + 3]! > 200) {
        count++; const x = (i / 4) % canvas.width, y = Math.floor(i / 4 / canvas.width)
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
      }
      if (referencePixels && (Math.abs(pixels[i]! - referencePixels[i]!) > 12 || Math.abs(pixels[i + 1]! - referencePixels[i + 1]!) > 12 || Math.abs(pixels[i + 2]! - referencePixels[i + 2]!) > 12)) changed++
    }
    return { count, changed, width: canvas.width, height: canvas.height, redBounds: count ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null }
  },
  rememberPixels() {
    const canvas = document.querySelector('.image-annotation-editor canvas') as HTMLCanvasElement
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) throw new Error('Actual base Canvas is absent')
    referencePixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    return { width: canvas.width, height: canvas.height }
  },
  patchStats(rect: { x: number; y: number; width: number; height: number }) {
    const canvas = document.querySelector('.image-annotation-editor canvas') as HTMLCanvasElement, bounds = canvas.getBoundingClientRect()
    const sx = canvas.width / bounds.width, sy = canvas.height / bounds.height
    const x = Math.floor(rect.x * sx), y = Math.floor(rect.y * sy), width = Math.floor(rect.width * sx), height = Math.floor(rect.height * sy)
    if (width < 10 || height < 10) throw new Error('The actual pixelation source patch is nonempty')
    const data = canvas.getContext('2d')!.getImageData(x, y, width, height).data
    let transitions = 0, adjacent = 0, opaque = 0
    for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
      const at = (row * width + col) * 4
      if (data[at + 3]! > 200) opaque++
      if (col === 0) continue
      adjacent++
      if (Math.abs(data[at]! - data[at - 4]!) + Math.abs(data[at + 1]! - data[at - 3]!) + Math.abs(data[at + 2]! - data[at - 2]!) > 60) transitions++
    }
    return { transitions, adjacent, opaque, width, height }
  },
  field(name: string) { return (document.querySelector(`[aria-label="${name}"]`) ?? [...document.querySelectorAll('label')]
    .find(label => label.textContent?.trim() === name)?.control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value },
  appearance(mode: 'light' | 'dark') { return updateThemeSelection({ appAppearance: mode }) },
  holdEncoding() { holdNextEncoding = true },
  releaseEncoding() { if (!heldEncoding) throw new Error('No actual PNG encoding is held'); heldEncoding() },
  dispose() { root.unmount(); theme() }
}
