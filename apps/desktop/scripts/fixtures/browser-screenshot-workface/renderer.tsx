import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { rendererPerformance } from '../../../src/renderer/src/lib/renderer-performance'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/overlays.css'
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
    const editor = document.querySelector('.browser-screenshot-editor'), canvas = editor?.querySelector('canvas')
    const box = (node: Element | null) => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
    return { editor: !!editor, bounds: box(editor), canvas: box(canvas ?? null), canvasPixels: canvas ? [canvas.width, canvas.height] : null,
      withinStage: !!editor?.closest('[data-native-browser-stage]'), imageLoaded: !!editor?.querySelector<HTMLImageElement>('img')?.complete,
      copying: !![...document.querySelectorAll('button')].find(button => button.textContent?.includes('Copying')),
      cancelDisabled: [...(editor?.querySelectorAll('button') ?? [])].find(button => button.textContent?.includes('Cancel'))?.disabled,
      events: events.slice(), errors: errors.slice(), warning, encoded, encodingHeld: !!heldEncoding,
      overlay: rendererPerformance.snapshot().overlay }
  },
  inkPixels() {
    const canvas = document.querySelector('.browser-screenshot-editor canvas') as HTMLCanvasElement
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) throw new Error('The actual screenshot canvas is absent')
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++
    return { count, width: canvas.width, height: canvas.height }
  },
  holdEncoding() { holdNextEncoding = true },
  releaseEncoding() { if (!heldEncoding) throw new Error('No actual PNG encoding is held'); heldEncoding() },
  dispose() { root.unmount(); theme() }
}
