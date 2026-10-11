// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { PaneSplitMenu } from '../src/renderer/src/components/PaneSplitMenu'
import { RegionContextMenu } from '../src/renderer/src/components/RegionContextMenu'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { WorkbenchTabContextMenu } from '../src/renderer/src/components/WorkbenchTabContextMenu'
import { workbenchSplitMenuEntries } from '../src/renderer/src/lib/workbench-tab-actions'
import { executionHostProjection } from '../src/renderer/src/lib/region-execution-host'

let container: HTMLDivElement
let root: ReturnType<typeof createClientUiRoot>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(content: ReactNode) { await act(async () => root.render(content)) }
async function key(target: Element, value: string, isComposing = false) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
async function pointer(target: Element, type: string, relatedTarget: EventTarget | null = null, pointerType = 'mouse') {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { pointerType, relatedTarget, buttons: 0, button: 0, bubbles: true, cancelable: true }))
  })
}
async function click(target: HTMLElement) { await act(async () => target.click()) }
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
const action = (name: string) => document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${name}"]`)!
const namedItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === name)!
const row = (name: string) => document.querySelector<HTMLElement>(`.workbench-menu-row[role="group"][aria-label="${name}"]`)!
const rowLabel = (name: string) => row(name).querySelector('.workbench-menu-row__label-text')!

async function splitMenu(regionCount = 2) {
  const split = vi.fn(), arrange = vi.fn()
  await render(<PaneSplitMenu regionCount={regionCount} onSplit={split} onArrange={arrange} />)
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose split direction"]')!
  await pointer(trigger, 'pointerover')
  return { split, arrange, trigger }
}

it('the original Split consumer exposes every eligible command in two labelled icon rows', async () => {
  await splitMenu()
  const rows = [...document.querySelectorAll('.workbench-menu-row')]
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.querySelector('.workbench-menu-row__label')?.textContent)).toEqual(['New region', 'Layout'])
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['New region', 'Layout'])
  expect(rows.every(row => row.querySelector('.workbench-menu-row__label')?.getAttribute('aria-hidden') === 'true')).toBe(true)
  const expected = workbenchSplitMenuEntries({ regionCount: 2, split: vi.fn(), arrange: vi.fn() })
    .filter(entry => entry.kind !== 'separator').map(entry => entry.label)
  expect(expected).toHaveLength(10)
  expect([...menu().querySelectorAll('[role="menuitem"]')].map(item => item.getAttribute('aria-label'))).toEqual(expected)
  const control = document.querySelector('.workbench-layout-menu')!
  expect([...control.children].map(child => child.getAttribute('role'))).toEqual(['group', 'group'])
  expect(control.querySelector('.workbench-layout-menu__hint, footer')).toBeNull()
  expect(control.textContent).not.toContain('Choose a direction')
  expect(control.textContent).not.toContain('Choose a layout')
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  const glyphs = [...control.querySelectorAll('[role="menuitem"] > svg')]
  expect(glyphs).toHaveLength(10)
  expect(glyphs.every(glyph => glyph.getAttribute('width') === '16' && glyph.getAttribute('height') === '16')).toBe(true)
})

it('pointer selection executes the exact original direction once and dismisses', async () => {
  const { split, arrange } = await splitMenu()
  await click(action('Split Left'))
  expect(split).toHaveBeenCalledExactlyOnceWith('left')
  expect(arrange).not.toHaveBeenCalled()
  expect(menu()).toBeNull()
})

it('preset capacity remains with the original model while rearrangement stays available', async () => {
  const { arrange } = await splitMenu(5)
  expect(action('3 Columns')).toBeNull()
  expect(action('2 × 2 Grid')).toBeNull()
  expect(action('2 × 3 Grid')).not.toBeNull()
  expect(action('Even Split')).not.toBeNull()
  await click(action('2 × 3 Grid'))
  expect(arrange).toHaveBeenCalledExactlyOnceWith({ kind: 'preset', preset: 'grid-6' })
})

it('hover names an icon without stealing the existing editor caret', async () => {
  const split = vi.fn()
  await render(<><input aria-label="Original editor" /><PaneSplitMenu regionCount={2} onSplit={split} onArrange={vi.fn()} /></>)
  const editor = container.querySelector('input')!
  editor.focus()
  await pointer(container.querySelector('[aria-label="Choose split direction"]')!, 'pointerover')
  await pointer(action('Split Down'), 'pointermove')
  expect(rowLabel('New region').textContent).toBe('Split Down')
  expect(rowLabel('Layout').textContent).toBe('Layout')
  expect(document.activeElement).toBe(editor)
  expect(split).not.toHaveBeenCalled()
})

it('row arrows, original menu navigation and full focus names work before one keyboard execution', async () => {
  const { split } = await splitMenu()
  await act(async () => action('Split Left').focus())
  expect(rowLabel('New region').textContent).toBe('Split Left')
  await key(action('Split Left'), 'ArrowRight')
  expect(document.activeElement).toBe(action('Split Right'))
  expect(rowLabel('New region').textContent).toBe('Split Right')
  await key(action('Split Right'), 'ArrowLeft')
  expect(document.activeElement).toBe(action('Split Left'))
  await key(action('Split Left'), 'ArrowDown')
  expect(document.activeElement).toBe(action('Split Right'))
  await key(action('Split Right'), 'Enter')
  expect(split).toHaveBeenCalledExactlyOnceWith('right')
  expect(menu()).toBeNull()
})

it('a focused action keeps its row description above hover and restores the row label after blur and leave', async () => {
  const split = vi.fn(), arrange = vi.fn()
  await render(<><input aria-label="Original editor" /><PaneSplitMenu regionCount={2} onSplit={split} onArrange={arrange} /></>)
  const editor = container.querySelector('input')!
  editor.focus()
  await pointer(container.querySelector('[aria-label="Choose split direction"]')!, 'pointerover')
  await act(async () => action('Split Left').focus())
  await pointer(action('Split Down'), 'pointermove')
  expect(document.activeElement).toBe(action('Split Left'))
  expect(rowLabel('New region').textContent).toBe('Split Left')
  expect(row('New region').getAttribute('aria-label')).toBe('New region')
  expect(action('Split Left').getAttribute('aria-label')).toBe('Split Left')
  await pointer(row('New region'), 'pointerout', row('Layout'))
  expect(rowLabel('New region').textContent).toBe('Split Left')
  await act(async () => menu().focus())
  expect(document.activeElement).toBe(menu())
  expect(rowLabel('New region').textContent).toBe('New region')
  expect(rowLabel('Layout').textContent).toBe('Layout')
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  expect(split).not.toHaveBeenCalled()
  expect(arrange).not.toHaveBeenCalled()
  await pointer(action('Split Down'), 'pointermove')
  expect(rowLabel('New region').textContent).toBe('Split Down')
  await key(menu(), 'Escape')
  expect(menu()).toBeNull()
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => editor.focus())
  expect(document.activeElement).toBe(editor)
})

it('IME-owned arrows keep the original item and never invoke a command', async () => {
  const { split } = await splitMenu()
  await act(async () => action('Split Left').focus())
  await key(action('Split Left'), 'ArrowRight', true)
  expect(document.activeElement).toBe(action('Split Left'))
  expect(split).not.toHaveBeenCalled()
})

it('Home and End still traverse the original menu collection and Escape dismisses', async () => {
  await splitMenu()
  await act(async () => action('Split Right').focus())
  await key(action('Split Right'), 'End')
  expect(document.activeElement).toBe(action('Focused First'))
  await key(action('Focused First'), 'Home')
  expect(document.activeElement).toBe(action('Split Left'))
  await act(async () => action('3 × 3 Grid').focus())
  await key(action('3 × 3 Grid'), 'ArrowRight')
  expect(document.activeElement).toBe(action('Even Split'))
  await key(action('Even Split'), 'ArrowLeft')
  expect(document.activeElement).toBe(action('3 × 3 Grid'))
  await key(action('3 × 3 Grid'), 'Escape')
  expect(menu()).toBeNull()
})

it('typeahead uses the full icon name and Space executes it once', async () => {
  const { arrange } = await splitMenu()
  await act(async () => action('Split Left').focus())
  await key(action('Split Left'), 'f')
  expect(document.activeElement).toBe(action('Focused First'))
  // Radix retains its search buffer briefly; Escape and reopen give Space its command meaning.
  await key(action('Focused First'), 'Escape')
  await pointer(container.querySelector('[aria-label="Choose split direction"]')!, 'pointerover')
  await act(async () => action('Focused First').focus())
  await key(action('Focused First'), ' ')
  expect(arrange).toHaveBeenCalledExactlyOnceWith({ kind: 'active-first' })
  expect(menu()).toBeNull()
})

it('the Region context menu progressively names exact swap targets and dispatches only the chosen one', async () => {
  const first = vi.fn(), second = vi.fn()
  await render(<RegionContextMenu regionId="clicked-region" agentSessionId={null} writeClipboardText={vi.fn()}
    splitMenu={workbenchSplitMenuEntries({ regionCount: 3, split: vi.fn(), arrange: vi.fn() })}
    swapMenu={[{ targetRegionId: 'other-a', label: 'Swap with Terminal 1', onSelect: first },
      { targetRegionId: 'other-b', label: 'Swap with Terminal 2', onSelect: second }]}>
    <button>Clicked Region</button>
  </RegionContextMenu>)
  await act(async () => container.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  expect(namedItem('Swap with Terminal 1')).toBeUndefined()
  const swap = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Swap Region'))!
  await act(async () => swap.focus())
  await key(swap, 'ArrowRight')
  expect(document.querySelector('.region-swap-menu')).not.toBeNull()
  await click(namedItem('Swap with Terminal 2'))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  expect(menu()).toBeNull()
})

it('the original Header More keeps hover input focus across its Dropdown Sub Portal', async () => {
  const swapAction = vi.fn()
  await render(<RegionContextMenu regionId="clicked-region" agentSessionId={null} writeClipboardText={vi.fn()}
    splitMenu={workbenchSplitMenuEntries({ regionCount: 2, split: vi.fn(), arrange: vi.fn() })}
    swapMenu={[{ targetRegionId: 'other', label: 'Swap with Other', onSelect: swapAction },
      { targetRegionId: 'last', label: 'Swap with Last', onSelect: vi.fn() }]}>
    <div><input aria-label="Original input" /><AgentRegionHeader name="Shell" executorLabel="Shell" sessionId="shell"
      sessionKind="terminal" executionHost={executionHostProjection(null, undefined)} regionId="clicked-region"
      readOnly={false} onHistory={undefined} /></div>
  </RegionContextMenu>)
  const input = container.querySelector('input')!
  input.focus()
  const trigger = container.querySelector('[aria-label^="More actions for Shell"]')!
  await pointer(trigger, 'pointerover')
  const swap = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Swap Region'))!
  await pointer(swap, 'pointermove')
  const child = document.querySelector<HTMLElement>('.region-swap-menu')!
  expect(child).not.toBeNull()
  await pointer(swap, 'pointerout', child)
  await pointer(menu(), 'pointerout', child)
  await pointer(child, 'pointerover')
  await pointer(namedItem('Swap with Other'), 'pointerout', namedItem('Swap with Last'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
  expect(document.querySelector('.region-swap-menu')).toBe(child)
  expect(document.activeElement).toBe(input)
  await pointer(swap, 'pointerout', action('Split Left'))
  expect(document.querySelector('.region-swap-menu')).toBeNull()
  expect(document.activeElement).toBe(input)
  await pointer(swap, 'pointermove')
  await click(namedItem('Swap with Other'))
  expect(swapAction).toHaveBeenCalledTimes(1)
  expect(menu()).toBeNull()
})

it('Tab group movement keeps its distinct action and a row-edge Left returns to the parent menu', async () => {
  const move = vi.fn(), arrange = vi.fn()
  await render(<WorkbenchTabContextMenu tabId="original-tab" copyableAgentSessionId={null}
    canCloseOthers={false} canCloseLeft={false} canCloseRight={false} canMoveToNewGroup
    writeClipboardText={vi.fn()} onRenameTab={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseLeft={vi.fn()} onCloseRight={vi.fn()}
    onMoveToNewGroup={move} regionCount={2} onArrange={arrange} moveSessionViewTargets={[]}
    onMoveSessionView={vi.fn()} displayTargets={[]} bindingPending={false} onOpenChange={vi.fn()} onDisplayBindingChange={vi.fn()}>
    <button>Original Tab</button>
  </WorkbenchTabContextMenu>)
  await act(async () => container.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  const trigger = [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Move Tab to New Group'))!
  await act(async () => trigger.focus())
  await key(trigger, 'ArrowRight')
  const first = action('Move Tab to New Group Left')
  expect(first).not.toBeNull()
  const moveControl = first.closest('.workbench-layout-menu')!
  expect(moveControl.querySelectorAll('.workbench-menu-row')).toHaveLength(1)
  expect(row('Move tab').querySelectorAll('[role="menuitem"]')).toHaveLength(4)
  expect(row('Move tab').getAttribute('aria-label')).toBe('Move tab')
  expect(moveControl.querySelector('.workbench-layout-menu__hint, footer')).toBeNull()
  await act(async () => first.focus())
  expect(rowLabel('Move tab').textContent).toBe('Move Tab to New Group Left')
  expect(row('Move tab').getAttribute('aria-label')).toBe('Move tab')
  await key(first, 'ArrowLeft')
  expect(action('Move Tab to New Group Left')).toBeNull()
  await key(trigger, 'ArrowRight')
  await act(async () => action('Move Tab to New Group Left').focus())
  await key(action('Move Tab to New Group Left'), 'ArrowRight')
  await key(action('Move Tab to New Group Right'), 'Enter')
  expect(move).toHaveBeenCalledExactlyOnceWith('right')
  expect(arrange).not.toHaveBeenCalled()
})
