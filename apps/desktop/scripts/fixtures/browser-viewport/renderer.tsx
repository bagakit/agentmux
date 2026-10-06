import { createRoot } from 'react-dom/client'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { applied, errors, initialize, state, useAppStore } from './store'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/overlays.css'
import '../../../src/renderer/src/styles/chrome.css'
import '../../../src/renderer/src/styles/browser.css'
import '../../../src/renderer/src/styles/agent.css'
import './fixture.css'

const events: unknown[] = []
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup']) document.addEventListener(type, event => {
  const node = (event.target as Element)?.closest('button,[role=menuitemradio],input')
  events.push({ type, trusted: event.isTrusted, target: node?.getAttribute('aria-label') ?? node?.textContent?.trim(), key: (event as KeyboardEvent).key,
    x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY, pointerType: (event as PointerEvent).pointerType, buttons: (event as PointerEvent).buttons,
    detail: (event as MouseEvent).detail, button: (event as MouseEvent).button })
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
    menus: document.querySelectorAll('[role=menu]').length, hasFocus: document.hasFocus(), bodyPointerEvents: document.body.style.pointerEvents,
    activeElement: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName }),
  menu(triggerName: string, option: string) {
    const trigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === triggerName && button.getBoundingClientRect().width > 0)
    const contentId = trigger?.getAttribute('aria-controls'), content = contentId ? document.getElementById(contentId) : null
    if (trigger?.getAttribute('aria-expanded') !== 'true' || trigger.getAttribute('data-state') !== 'open' ||
      content?.getAttribute('role') !== 'menu' || content.getAttribute('data-state') !== 'open') return null
    const openContents = document.querySelectorAll('[role=menu][data-state=open]')
    if (openContents.length !== 1 || openContents[0] !== content) return null
    const radios = [...content.querySelectorAll<HTMLElement>('[role=menuitemradio]')], item = radios.find(item => item.textContent?.trim().startsWith(option))
    if (!item || radios.length !== 4) return null
    const box = item.getBoundingClientRect(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    return { contentId, triggerState: trigger.getAttribute('data-state'), contentState: content.getAttribute('data-state'),
      contentBounds: content.getBoundingClientRect().toJSON(), point, itemBounds: box.toJSON(), hit: item.contains(document.elementFromPoint(point.x, point.y)),
      radios: radios.map(item => ({ text: item.textContent?.trim(), checked: item.getAttribute('aria-checked') })) }
  },
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
