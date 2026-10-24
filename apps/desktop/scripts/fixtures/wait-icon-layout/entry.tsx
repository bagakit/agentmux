import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { FullPageLoadingSurface } from '../../../src/renderer/src/components/FullPageLoadingSurface'
import { createSemanticIconElement } from '../../../../../packages/client-ui/src/theme/icon-sprite'
import { mountThemeRuntime, previewTheme } from '../../../../../packages/client-ui/src/theme/runtime'
import { BUILTIN_THEMES, GRAPHITE_THEME } from '../../../../../packages/client-ui/src/theme/catalog'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const w = window as any
const errors: string[] = [], inputs: string[] = [], compositions: unknown[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const releaseTheme = mountThemeRuntime(window, { appAppearance: 'dark' })
const term = new Terminal({ cols: 96, rows: 14, scrollback: 10000, fontSize: 14,
  theme: { background: '#15171b', foreground: '#d4d8df' } })
let tick: ReturnType<typeof setInterval> | undefined, output = 0, completedOutput = 0, action = 0
function Scene() {
  const [visible, setVisible] = useState(true)
  const [scope, setScope] = useState<'app' | 'region'>('region')
  const [count, setCount] = useState(1)
  w.setVisible = setVisible; w.setScope = setScope; w.setCount = setCount
  return <main>
    <section id="waiting-surface" className="workbench-layout-body"><FullPageLoadingSurface scope={scope} phase="recovering" visible={visible}
      title="Connecting to this session" eyebrow="Session connection"
      detail="Waiting for this session to reconnect."
      actions={<button onClick={() => action++} className="small-button">Check original</button>}
      supplement={<p>Private retained workface · original waiting consumer</p>} /></section>
    <aside id="native-icons" aria-label="Native semantic icon adapters" />
    <aside id="additional-icons">{Array.from({ length: count - 1 }, (_, i) => <span key={i} className="additional-slot" />)}</aside>
    <section id="terminal-shell"><p>Live terminal · output, scroll and composition</p><div id="terminal" /></section>
    <div id="retained" aria-hidden="true" />
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
const rect = (n: Element) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
const waiters = () => [...document.querySelectorAll<HTMLElement>('.semantic-icon-motion[data-icon-animation="wait"]')]
function adapterSlots() {
  const host = document.getElementById('native-icons')!
  if (!host.firstChild) for (const [name, animation] of [['status.waiting', 'wait'], ['status.working', 'work']] as const)
    host.append(createSemanticIconElement(name, document, { animation, size: 18 }))
  for (const slot of document.querySelectorAll('.additional-slot')) if (!slot.firstChild)
    slot.append(createSemanticIconElement('status.waiting', document, { animation: 'wait', size: 18 }))
}
w.proof = {
  ready: false,
  scale(count: number) {
    const parent = document.getElementById('retained')!, fragment = document.createDocumentFragment()
    parent.replaceChildren()
    for (let i = 0; i < count; i++) { const section = document.createElement('section'); section.className = 'retained-workface'
      const p = document.createElement('p'); p.textContent = `Original retained workface ${i}`; section.append(p); fragment.append(section) }
    parent.append(fragment)
  },
  count(count: number) { w.setCount(count) },
  adapt: adapterSlots,
  scope(scope: 'app' | 'region') { w.setScope(scope) },
  visible(value: boolean) { w.setVisible(value) },
  parked(value: boolean) { document.getElementById('waiting-surface')!.dataset.workbenchLayoutState = value ? 'parked' : 'visible' },
  theme(index: number, light = false) { return previewTheme(BUILTIN_THEMES[index], window, light ? 'light' : 'dark') },
  custom() { return previewTheme({ ...GRAPHITE_THEME, id: 'custom.wait-proof', name: 'Custom waiting', icons: { 'status.waiting': { kind: 'paths', paths: [{ d: 'M4 12h16M12 4v16' }] } } }) },
  restoreTheme() { return previewTheme(GRAPHITE_THEME) },
  pause(value: boolean) { for (const node of waiters()) node.style.setProperty('--icon-motion-play-state', value ? 'paused' : 'running') },
  output(value: boolean) { if (tick) clearInterval(tick); tick = undefined
    if (value) tick = setInterval(() => term.write(`live-output-${++output} original terminal remains available\r\n`, () => completedOutput++), 40) },
  focus() { term.focus() },
  scrollToLine(line: number) { term.scrollToLine(line) },
  stop() { if (tick) clearInterval(tick); term.dispose(); releaseTheme() },
  facts() {
    return { visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight }, errors: [...errors],
      retained: document.querySelectorAll('.retained-workface').length, action,
      elapsed: document.querySelector('.full-page-loading__elapsed')?.textContent,
      waiting: document.querySelector('.full-page-loading__waiting')?.getAttribute('data-waiting-visible'),
      icons: waiters().map(node => ({ rect: rect(node), display: getComputedStyle(node).display,
        contain: getComputedStyle(node).contain, playState: getComputedStyle(node).animationPlayState,
        href: node.querySelector('use')?.getAttribute('href'), markup: node.outerHTML })),
      // The referenced symbol is the root-owned source, not an animation observer for the use shadow tree.
      symbol: document.getElementById('agentmux-icon-status.waiting')?.innerHTML,
      terminal: { rect: rect(document.querySelector('.xterm-screen')!), output, completedOutput,
        viewportY: term.buffer.active.viewportY, baseY: term.buffer.active.baseY, inputs: [...inputs], compositions: [...compositions],
        focused: document.activeElement === term.textarea } }
  }
}
while (!document.getElementById('terminal')) await new Promise(resolve => setTimeout(resolve, 20))
adapterSlots(); term.open(document.getElementById('terminal')!); term.loadAddon(new WebglAddon())
term.onData(data => { inputs.push(data); term.write(data) })
for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) term.textarea!.addEventListener(name, event => compositions.push({ name, data: (event as CompositionEvent).data }))
await new Promise<void>(resolve => term.write(Array.from({ length: 1200 }, (_, i) => `retained-terminal-line-${i}\r\n`).join(''), resolve))
w.proof.ready = true
