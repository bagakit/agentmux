import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { applied, errors, initialize, state, useAppStore } from './store'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/browser.css'
import '../../../src/renderer/src/styles/agent.css'
import './fixture.css'

const events: unknown[] = []
for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup']) document.addEventListener(type, event => {
  const node = (event.target as Element)?.closest('button,[role=menuitemradio]')
  events.push({ type, trusted: event.isTrusted, target: node?.getAttribute('aria-label') ?? node?.textContent?.trim(), key: (event as KeyboardEvent).key })
}, true)
const theme = mountThemeRuntime(window)
initialize((await (window as any).viewportNative.setup()).original)
window.agentmux!.browser.onEvent(event => state.applyBrowserEvent(event))
function Fixture() {
  const tab = useAppStore(value => value.tab)
  const released = useAppStore(value => value.released)
  const warning = useNativeOverlayChrome()
  return <DesktopClientUiProvider><main className="viewport-fixture">
    <header><strong>Browser Viewport</strong><span>Original native page and sibling</span></header>
    <section id="original"><BrowserPane tab={tab as any} visible released={released as boolean} /></section>
    <aside>Sibling page remains available</aside>
    {warning ? <p role="alert">{warning}</p> : null}
  </main></DesktopClientUiProvider>
}
const root = createRoot(document.getElementById('root')!)
root.render(<Fixture />)
;(window as any).viewportProbe = {
  read: () => ({ viewport: state.tab.viewport, errors: errors.slice(), applied: applied.slice(), events: events.slice(),
    menus: document.querySelectorAll('[role=menu]').length }),
  resize(width: number, height: number) {
    const section = document.getElementById('original')!
    section.style.width = width + 'px'; section.style.height = height + 'px'
  },
  released(value: boolean) { useAppStore.setState({ released: value }) },
  async compose(chrome: string, layers: Array<{ dataUrl: string; x: number; y: number; width: number; height: number }>) {
    const decode = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image }
    const background = await decode(chrome), canvas = document.createElement('canvas')
    canvas.width = background.naturalWidth; canvas.height = background.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(background, 0, 0)
    const ratio = canvas.width / innerWidth
    for (const layer of layers) context.drawImage(await decode(layer.dataUrl), layer.x * ratio, layer.y * ratio, layer.width * ratio, layer.height * ratio)
    return canvas.toDataURL('image/png')
  },
  dispose() { root.unmount(); theme() }
}
