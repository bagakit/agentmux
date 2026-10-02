import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { SurveyZoneItem } from '../src/renderer/src/components/SurveyZoneItem'
import { SurveyItemOptions } from '../src/renderer/src/components/SurveyItemOptions'

const zone: AgentMuxZoneFact = { zoneId: 'original-zone', workspaceId: 'resource-workspace', kind: 'worktree', hostId: 'local', directoryPath: _hygiene_fixturePath("resource/project"), branch: 'work' }
const topicA: AgentMuxSpaceFact = { spaceId: 'topic-a', kind: 'topic', name: 'Research', hostId: 'local', directoryPath: _hygiene_fixturePath("topics/a"), projectId: null }
const topicB: AgentMuxSpaceFact = { ...topicA, spaceId: 'topic-b', hostId: 'remote', directoryPath: _hygiene_fixturePath("topics/b") }
const mote: AgentMuxSpaceFact = { ...topicA, spaceId: 'mote', kind: 'mote', name: 'Team' }
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals()
})
async function pointer(target: Element, type: string) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0 })))
}
async function key(target: Element, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
const menu = () => document.querySelector<HTMLElement>('.survey-item-menu[role="menu"]')
const details = () => document.querySelector<HTMLElement>('.survey-item-details-content')
function action(text: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === text)
  expect(item, 'actual menu action ' + text).toBeDefined(); return item!
}
async function mount(overrides: Partial<ComponentProps<typeof SurveyItemOptions>> = {}) {
  const props = { visible: true, title: 'Original mixed workface', zone, workspace: null, collected: true, relatedSpaces: [topicA],
    activityDetails: 'Mixed control', onSaveToTopic: vi.fn(), currentPanelAvailable: true,
    onCollectedChange: vi.fn(), onManageBrowsers: vi.fn(), onOpenWorkspace: vi.fn(), ...overrides }
  await act(async () => root.render(<><input aria-label="original editor" defaultValue="Retain this editor selection" />
    <SurveyItemOptions {...props} /></>))
  return props
}
async function open() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Exploration options"]')!
  expect(trigger).not.toBeNull(); await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
  expect(menu()).not.toBeNull(); return trigger
}
async function openDetails() {
  const sub = action('Details'); await act(async () => sub.focus()); await key(sub, 'ArrowRight')
  expect(details()).not.toBeNull()
}
async function close() {
  await key(details()?.closest<HTMLElement>('[role="menu"]') ?? menu()!, 'Escape')
  if (menu()) await key(menu()!, 'Escape')
}

it('offers explicit research and current-panel capture without changing location bindings or navigating', async () => {
  const props = await mount({ relatedSpaces: [topicA, topicB, mote] }); await open()
  expect(document.querySelector('[data-survey-topic-id]')).toBeNull()
  expect(document.querySelector('[aria-label="Link Topics"]')).toBeNull()
  expect(document.querySelector('[aria-label="Organize into Topic"]')).toBeNull()
  expect(props.onSaveToTopic).not.toHaveBeenCalled()
  await act(async () => action('Save research to Topic…').click())
  expect(props.onSaveToTopic).toHaveBeenCalledExactlyOnceWith('research')
  expect(props.onOpenWorkspace).not.toHaveBeenCalled(); expect(props.onCollectedChange).not.toHaveBeenCalled()
  await open(); await act(async () => action('Save current panel to Topic…').click())
  expect(props.onSaveToTopic).toHaveBeenLastCalledWith('panel'); expect(props.onSaveToTopic).toHaveBeenCalledTimes(2)
})

it.each([false, true])('keeps known exact same-name locations read-only when some observations are unconfirmed (%s)', async unconfirmed => {
  const props = await mount({ relatedSpaces: [topicA, topicB], relatedSpacesUnconfirmed: unconfirmed }); await open(); await openDetails()
  expect(details()!.textContent).toContain('2 linked locations')
  expect(details()!.textContent).toContain(("Research · local · " + _hygiene_fixturePath("topics/a")))
  expect(details()!.textContent).toContain(("Research · remote · " + _hygiene_fixturePath("topics/b")))
  expect(details()!.querySelectorAll('[role="menuitemcheckbox"], button')).toHaveLength(0)
  expect(details()!.textContent?.includes('Original bindings are retained.')).toBe(unconfirmed)
  await close(); expect(props.onSaveToTopic).not.toHaveBeenCalled(); expect(props.onOpenWorkspace).not.toHaveBeenCalled()
})

it('reports unknown linked locations without guessing or blocking capture from the confirmed original research', async () => {
  const props = await mount({ relatedSpaces: null }); await open(); await openDetails()
  expect(details()!.textContent).toContain('Linked locations unknown')
  expect(details()!.textContent).not.toContain('No linked locations')
  expect(details()!.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(0)
  await close(); await open(); await act(async () => action('Save research to Topic…').click())
  expect(props.onSaveToTopic).toHaveBeenCalledExactlyOnceWith('research')
})

it('keeps research capture available while an exact current panel is unavailable and never adopts an uncollected workface', async () => {
  const props = await mount({ currentPanelAvailable: false }); await open()
  expect([...menu()!.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === 'Save current panel to Topic…')).toBe(false)
  await act(async () => action('Save research to Topic…').click())
  expect(props.onSaveToTopic).toHaveBeenCalledExactlyOnceWith('research')
  await mount({ ...props, collected: false }); await open()
  expect(menu()!.textContent).not.toContain('Save research to Topic')
  expect(menu()!.textContent).not.toContain('Save current panel to Topic')
  expect(props.onCollectedChange).not.toHaveBeenCalled()
})

it('keeps the original editor draft and selection while explicit Item-menu disclosure follows Radix', async () => {
  const props = await mount()
  const editor = container.querySelector('input')!, trigger = container.querySelector('[aria-label="Exploration options"]')!
  editor.focus(); editor.setSelectionRange(3, 14); await pointer(trigger, 'pointerover')
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(editor)
  await open(); await pointer(action('Save research to Topic…'), 'pointermove')
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14])
  expect(editor.value).toBe('Retain this editor selection')
  await close(); expect(menu()).toBeNull(); expect(props.onSaveToTopic).not.toHaveBeenCalled()
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14])
})

it('lets Radix keyboard selection capture only the chosen scope and Escape restore trigger focus', async () => {
  const props = await mount(), trigger = await open()
  const panel = action('Save current panel to Topic…'); await act(async () => panel.focus()); await key(panel, 'Enter')
  expect(props.onSaveToTopic).toHaveBeenCalledExactlyOnceWith('panel')
  expect(props.onOpenWorkspace).not.toHaveBeenCalled(); expect(menu()).toBeNull()
  await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)) })
  await open(); await key(menu()!, 'Escape'); expect(menu()).toBeNull()
  await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)) })
})

it('selects the original Zone and keeps its resource and membership actions in the single selected Item menu', async () => {
  const onSelect = vi.fn(), onOpenWorkspace = vi.fn(), onCollectedChange = vi.fn()
  const resource = { id: 'foreign-resource', name: 'Resource project', hostId: 'remote', path: _hygiene_fixturePath("source/worktree"), branch: 'resource-branch', kind: 'worktree' as const }
  const render = async (sourceWorkspace: typeof resource | null, relatedSpaces: AgentMuxSpaceFact[] | null) => {
    await act(async () => root.render(<><SurveyZoneItem zone={zone} title="Original mixed workface" glyph={<span>Mixed</span>} selected activity="Mixed" onSelect={onSelect} />
      <SurveyItemOptions visible title="Original mixed workface" zone={zone} workspace={sourceWorkspace} relatedSpaces={relatedSpaces} collected={true}
        onCollectedChange={onCollectedChange} activityDetails="Two Browsers: mixed control"
        onManageBrowsers={() => {}} onOpenWorkspace={onOpenWorkspace} /></>))
  }
  await render(resource, [topicA, topicB, mote])
  const select = container.querySelector<HTMLButtonElement>('[aria-current="true"]')!, trigger = container.querySelector<HTMLButtonElement>('[aria-label="Exploration options"]')!
  await act(async () => select.click()); expect(onSelect).toHaveBeenCalledExactlyOnceWith('original-zone')
  expect(container.querySelectorAll('.survey-item-details')).toHaveLength(0)
  expect(container.textContent).not.toContain('Resource project')
  await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
  const main = menu()!; expect(main).not.toBeNull()
  const member = main.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!
  await act(async () => member.focus()); await key(member, 'Enter')
  expect(onCollectedChange).toHaveBeenCalledExactlyOnceWith(false)
  await openDetails()
  expect(details()!.textContent).toContain('3 linked locations')
  expect(details()!.textContent).toContain(("Research · remote · " + _hygiene_fixturePath("topics/b"))); expect(details()!.textContent).toContain(("Team · local · " + _hygiene_fixturePath("topics/a")))
  expect(details()!.textContent).toContain('Branch: resource-branch')
  expect(details()!.textContent).not.toContain('Branch: work'); expect(details()!.textContent).toContain('Two Browsers: mixed control')
  await key(details()!.closest<HTMLElement>('[role="menu"]')!, 'Escape')
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  if (!menu()) await key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(menu()).not.toBeNull())
  const source = document.querySelector<HTMLElement>(("[aria-label=\"Open resource Workspace: Resource project, remote, " + _hygiene_fixturePath("source/worktree") + "\"]"))!
  expect(source).not.toBeNull(); await act(async () => source.click()); expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith('foreign-resource')
  await render(null, null); await key(trigger, 'ArrowDown')
  expect(document.querySelector('[aria-label^="Open resource Workspace:"]')).toBeNull()
})
