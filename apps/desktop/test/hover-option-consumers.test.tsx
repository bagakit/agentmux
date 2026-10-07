// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotebookSelector } from '../src/renderer/src/components/NotebookSelector'
import { SpaceCreateMenu } from '../src/renderer/src/components/SpaceCreateMenu'
import { TopicCategoryActionsMenu, TopicCategoryContextMenu } from '../src/renderer/src/components/TopicCategoryMenu'
import { TopicActionsMenu, TopicContextMenu } from '../src/renderer/src/components/TopicContextMenu'
import { useAppStore } from '../src/renderer/src/store'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


let host: HTMLDivElement, root: Root
const initial = useAppStore.getState()
const category = { key: 'original-category', name: 'Original category', kind: 'category' as const }
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
async function settle(predicate: () => boolean, label = 'expected menu state') { await vi.waitFor(async () => { await act(async () => {}); expect(predicate(), label).toBe(true) }) }
async function pointer(node: Element, type: string, relatedTarget: EventTarget | null = null) {
  await act(async () => node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0, relatedTarget })))
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function consumers(action: ReturnType<typeof vi.fn>) {
  return [
    { name: 'NotebookSelector', label: 'Switch notebook', item: 'Second notebook', render: () => <NotebookSelector active pending={false} notebooks={[{ notebookId: 'one', name: 'First notebook', createdAt: _historyFixtureEpoch(0, 0, 1) }, { notebookId: 'two', name: 'Second notebook', createdAt: _historyFixtureEpoch(0, 0, 2) }]} selectedId="one" onSelect={id => action(id)} onCreate={() => action('create')} /> },
    { name: 'SpaceCreateMenu', label: 'Add Space', item: 'Open Folder As a Project', render: () => <SpaceCreateMenu onOpenFolder={async () => { action('folder') }} /> },
    { name: 'TopicCategoryActionsMenu', label: 'Actions for category Original category', item: 'Rename category…', render: () => <TopicCategoryActionsMenu target={category} onChangeIcon={() => action('icon')} onRename={() => action('category')} onCopyLink={() => action('link')} /> },
    { name: 'TopicActionsMenu', label: 'Actions for Original Topic', item: 'Rename Topic', render: () => <TopicActionsMenu title="Original Topic" pinned={false} onCopyPath={() => action('path')} onCopyLink={() => action('link')} onRename={() => action('topic')} onReveal={() => action('reveal')} onTogglePin={() => action('pin')} onEditWiki={() => action('wiki')} /> }
  ]
}

for (const name of ['NotebookSelector', 'SpaceCreateMenu', 'TopicCategoryActionsMenu', 'TopicActionsMenu']) {
  it(`${name} actual option entry hovers without acting or taking the original caret, and selects once`, async () => {
    const action = vi.fn(), parent = vi.fn(), invokers: Element[] = []
    action.mockImplementation(() => { invokers.push(document.activeElement!) })
    const entry = consumers(action).find(entry => entry.name === name)!
    expect(entry).toBeDefined()
    await act(async () => root.render(<><input aria-label="Original editor" defaultValue="Keep original draft" /><div onClick={parent} onPointerDown={parent}>{entry.render()}</div></>))
    const input = host.querySelector('input')!, trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${entry.label}"]`)!
    expect(trigger).not.toBeNull(); input.focus(); input.setSelectionRange(2, 7)
    await pointer(trigger, 'pointerover')
    await settle(() => menu() !== null, 'mouse hover discloses actual options')
    expect(document.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]); expect(action).not.toHaveBeenCalled()
    const item = [...menu()!.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.textContent === entry.item)!
    expect(item).toBeDefined()
    await pointer(trigger, 'pointerout', item); await pointer(item, 'pointerover', trigger); await pointer(item, 'pointermove')
    expect(document.activeElement).toBe(input); expect(action).not.toHaveBeenCalled()
    await pointer(item, 'pointerdown'); await act(async () => item.click())
    await settle(() => action.mock.calls.length === 1 && menu() === null, 'single original action closes menu')
    expect(action).toHaveBeenCalledWith(name === 'NotebookSelector' ? 'two' : name === 'SpaceCreateMenu' ? 'folder' : name === 'TopicActionsMenu' ? 'topic' : 'category')
    if (name.startsWith('Topic')) { expect(parent).not.toHaveBeenCalled(); expect(invokers).toEqual([trigger]) }
    expect(input.value).toBe('Keep original draft')
    await settle(() => !trigger.disabled && document.activeElement === trigger, 'selection completes original focus handoff')
    trigger.focus(); await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
    await settle(() => menu() !== null, 'keyboard reopens actual options')
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await settle(() => menu() === null && document.activeElement === trigger, 'keyboard Escape returns original trigger')
    expect(action).toHaveBeenCalledOnce()
  })
}

it('Notebook hover closes on inactive without taking a later input, and explicit creation retains its dialog handoff', async () => {
  const create = vi.fn(), select = vi.fn()
  const view = (active: boolean): ReactNode => <><input aria-label="Later input" /><NotebookSelector active={active} pending={false} notebooks={[]} selectedId={null} onSelect={select} onCreate={create} /></>
  await act(async () => root.render(view(true)))
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Switch notebook"]')!
  await pointer(trigger, 'pointerover'); await settle(() => menu() !== null)
  await act(async () => root.render(view(false)))
  const later = host.querySelector('input')!; later.focus()
  await settle(() => menu() === null); expect(document.activeElement).toBe(later)
  await act(async () => root.render(view(true)))
  await pointer(trigger, 'pointerover'); await settle(() => menu() !== null)
  const item = document.querySelector<HTMLElement>('[aria-label="New notebook"]')!
  await pointer(item, 'pointerdown'); await act(async () => item.click())
  await settle(() => create.mock.calls.length === 1 && menu() === null)
  expect(select).not.toHaveBeenCalled(); expect(document.activeElement).not.toBe(trigger)
})

it('the actual Topic and Category context entries remain right-click and keyboard menus', async () => {
  const action = vi.fn(), opened = vi.fn()
  await act(async () => root.render(<><TopicCategoryContextMenu target={category} onChangeIcon={action} onRename={action} onCopyLink={action}><button onClick={opened}>Category row</button></TopicCategoryContextMenu><TopicContextMenu pinned={false} onCopyPath={action} onCopyLink={action} onRename={action} onReveal={action} onTogglePin={action} onEditWiki={action}><button onClick={opened}>Topic row</button></TopicContextMenu></>))
  const rows = [...host.querySelectorAll('button')]; expect(rows).toHaveLength(2)
  for (const row of rows) {
    await pointer(row, 'pointerover'); expect(menu()).toBeNull()
    row.focus(); await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })))
    await settle(() => menu() !== null); expect(menu()!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await settle(() => menu() === null)
  }
  expect(action).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled()
})
