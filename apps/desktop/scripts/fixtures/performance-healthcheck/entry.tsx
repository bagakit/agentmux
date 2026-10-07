import { useState, createRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import '../../../src/renderer/src/styles/agent.css'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as HoverMenu from '../../../src/renderer/src/components/HoverDropdownMenu'
import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'

const w = window as any
const errors: string[] = [], inputs: string[] = [], compositions: { target: string; name: string; data: string | null }[] = []
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
// Observe actual DOM registration/delivery. The wrapper preserves listener identity,
// capture and browser once semantics; it does not cancel or synthesize input events.
const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document)
const keys = new Map<EventListenerOrEventListenerObject, EventListener>()
const selections = new Set<EventListenerOrEventListenerObject>()
let keyCallbacks = 0, pointerRegistrations = 0
const capture = (options?: boolean | AddEventListenerOptions) => options === true || typeof options === 'object' && options.capture === true
document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'selectionchange') selections.add(listener)
  if (type === 'pointerdown' || type === 'pointermove') pointerRegistrations++
  if (type === 'keydown' && capture(options)) {
    let wrapped = keys.get(listener)
    if (!wrapped) {
      wrapped = event => { keyCallbacks++; typeof listener === 'function' ? listener(event) : listener.handleEvent(event) }
      keys.set(listener, wrapped)
    }
    return add(type, wrapped, options)
  }
  return add(type, listener, options)
}) as typeof document.addEventListener
document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
  if (type === 'selectionchange') selections.delete(listener)
  if (type === 'keydown' && capture(options)) {
    const wrapped = keys.get(listener)
    if (wrapped) { keys.delete(listener); return remove(type, wrapped, options) }
  }
  return remove(type, listener, options)
}) as typeof document.removeEventListener

const platform: ClientUiPlatform = {
  copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
const insertion = createRef<ComposerInsertionHandle>()
let draft = 'Original unsent draft ', setCount: (count: number) => void, setPresented: (visible: boolean) => void
let selected = 0, output = 0, completedOutput = 0, ticking: ReturnType<typeof setInterval> | undefined
function Menu({ id }: { id: string }) {
  return <HoverMenu.Root><HoverMenu.Trigger data-menu-trigger={id}>Actions</HoverMenu.Trigger>
    <HoverMenu.Portal><HoverMenu.Content className="fixture-menu" sideOffset={4}>
      <HoverMenu.Item onSelect={() => selected++}>Visible action</HoverMenu.Item>
      <DropdownMenu.Sub><DropdownMenu.SubTrigger>More</DropdownMenu.SubTrigger>
        <DropdownMenu.Portal><DropdownMenu.SubContent className="fixture-menu"><DropdownMenu.Item onSelect={() => selected++}>Nested action</DropdownMenu.Item></DropdownMenu.SubContent></DropdownMenu.Portal>
      </DropdownMenu.Sub>
    </HoverMenu.Content></HoverMenu.Portal>
  </HoverMenu.Root>
}
function Context({ children }: { children: ReactNode }) {
  return <ContextMenu.Root><ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="fixture-menu"><ContextMenu.Item onSelect={() => selected++}>Context action</ContextMenu.Item></ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>
}
function LiveComposer() {
  const [value, setValue] = useState(draft), [visible, setVisible] = useState(true)
  draft = value; setPresented = setVisible
  return <section id="live-composer" className="native-composer" hidden={!visible} inert={!visible}>
    <InlineComposer active={visible} value={value} onValueChange={setValue} disabled={false}
      insertionRef={insertion} placeholder="Original input" aria-label="Original input" onKeyDown={() => {}} />
  </section>
}
function Retained() {
  const [count, update] = useState(0)
  setCount = update
  return <aside id="retained" hidden inert>{Array.from({ length: count }, (_, index) => <section data-retained={index} key={index}>
    <Menu id={'retained-' + index} /><Context><button>Retained context</button></Context>
    <InlineComposer active={false} value={'Unseen draft ' + index} onValueChange={() => {}} disabled={false}
      placeholder="Saved input" aria-label="Saved input" onKeyDown={() => {}} />
  </section>)}</aside>
}
const root = createRoot(document.getElementById('root')!)
root.render(<ClientUiProvider platform={platform}><main>
  <header><h1>Native input and retained workface cost</h1><Menu id="visible" /></header>
  <p>Original shared editor, real xterm output and native menu interactions remain live.</p><LiveComposer />
  <Context><section id="terminal-shell"><div id="terminal" /></section></Context><Retained />
</main></ClientUiProvider>)
const term = new Terminal({ cols: 92, rows: 22, scrollback: 10000, fontSize: 15, cursorBlink: true,
  scrollOnUserInput: false, theme: { background: '#15191f', foreground: '#d5dce8' } })
while (!document.getElementById('terminal')) await new Promise(resolve => setTimeout(resolve, 10))
term.open(document.getElementById('terminal')!)
term.loadAddon(new WebglAddon())
term.onData(data => { inputs.push(data); term.write(data) })
for (const name of ['compositionstart', 'compositionupdate', 'compositionend']) document.addEventListener(name, event => {
  const target = event.target instanceof Element && event.target.closest('.xterm') ? 'terminal' : 'composer'
  compositions.push({ target, name, data: (event as CompositionEvent).data })
}, true)
await new Promise<void>(resolve => term.write(Array.from({ length: 1400 }, (_, index) => `retained-terminal-line-${index}\r\n`).join(''), resolve))
const live = () => document.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('#live-composer .ProseMirror')!
while (!live()) await new Promise(resolve => setTimeout(resolve, 10))
const originalNode = live(), originalEditor = originalNode.editor
const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
w.proof = {
  ready: true,
  scale(count: number) { setCount(count) },
  start() {
    ticking ??= setInterval(() => term.write(`live-output-${++output} Original live bytes\r\n`, () => completedOutput++), 20)
  },
  resetCosts() { keyCallbacks = pointerRegistrations = 0 },
  focusComposer() { originalEditor.commands.focus('end') },
  focusTerminal() { term.focus() },
  scrollTo(line: number) { term.scrollToLine(line) },
  showComposer(visible: boolean) { setPresented(visible) },
  selectRange() { originalEditor.commands.setTextSelection({ from: 2, to: 7 }) },
  undo() { return originalEditor.commands.undo() },
  async attach() { await insertion.current!.insert(async () => ' attachment') },
  focusMenu() { document.querySelector<HTMLElement>('[data-menu-trigger="visible"]')!.focus() },
  focusSubmenu() { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'More')!.focus() },
  itemRect() { return rect([...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'Visible action')!) },
  facts() {
    const buffer = term.buffer.active
    return { ready: true, visibility: document.visibilityState, draft, selected, errors: [...errors],
      retained: document.querySelectorAll('[data-retained]').length,
      editors: document.querySelectorAll('.ProseMirror').length,
      unseenEditors: document.querySelectorAll('#retained .ProseMirror').length,
      keydownOwners: keys.size, selectionOwners: selections.size, keyCallbacks, pointerRegistrations,
      sameNode: live() === originalNode, sameEditor: live()?.editor === originalEditor,
      selection: { from: originalEditor.state.selection.from, to: originalEditor.state.selection.to },
      inputFocused: document.activeElement === originalNode, menuFocused: document.activeElement?.getAttribute('data-menu-trigger'),
      menuCount: document.querySelectorAll('[role="menu"]').length,
      menuItemFocused: document.activeElement?.textContent,
      trigger: rect(document.querySelector('[data-menu-trigger="visible"]')!),
      terminal: { rect: rect(document.querySelector('.xterm-screen')!), viewportY: buffer.viewportY, baseY: buffer.baseY,
        top: buffer.getLine(buffer.viewportY)?.translateToString(true), output, completedOutput, inputs: [...inputs],
        focused: document.activeElement === term.textarea, compositions: [...compositions] },
      animations: document.getAnimations().filter(animation => animation.playState === 'running').length,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }
  },
  stop() { if (ticking) clearInterval(ticking); ticking = undefined; term.dispose(); root.unmount() }
}
