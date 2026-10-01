// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { SurveyTopicRelations } from '../src/renderer/src/components/SurveyTopicRelations'
import { SurveyZoneItem } from '../src/renderer/src/components/SurveyZoneItem'
import { SurveyItemOptions } from '../src/renderer/src/components/SurveyItemOptions'

const zone: AgentMuxZoneFact = { zoneId: 'original-zone', workspaceId: 'resource-workspace', kind: 'worktree', hostId: 'local', directoryPath: '/resource/project', branch: 'work' }
const topicA: AgentMuxSpaceFact = { spaceId: 'topic-a', kind: 'topic', name: 'Research', hostId: 'local', directoryPath: '/topics/a', projectId: null }
const topicB: AgentMuxSpaceFact = { ...topicA, spaceId: 'topic-b', hostId: 'remote', directoryPath: '/topics/b' }
const mote: AgentMuxSpaceFact = { ...topicA, spaceId: 'mote', kind: 'mote' }
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals()
})
async function pointer(target: Element, type: string, relatedTarget: EventTarget | null = null) {
  await act(async () => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0, button: 0, relatedTarget })))
}
async function key(target: Element, value: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}
const menu = () => document.querySelector<HTMLElement>('.survey-topic-submenu[role="menu"]')
function checkbox(id: string) {
  const item = document.querySelector<HTMLElement>(`[role="menuitemcheckbox"][data-survey-topic-id="${id}"]`)
  expect(item, `actual checkbox for ${id}`).not.toBeNull(); return item!
}
async function mount(overrides: Partial<ComponentProps<typeof SurveyTopicRelations>> = {}) {
  const props = { zone, topics: [topicA, topicB], relatedTopics: [topicA], pendingSpaceId: null, onLinkChange: vi.fn(), onOpenTopic: vi.fn(), ...overrides }
  await act(async () => root.render(<><input aria-label="original editor" defaultValue="Retain this editor selection" />
    <SurveyItemOptions visible title="Original mixed workface" zone={zone} workspace={null} collected={false} relatedTopics={props.relatedTopics}
      activityDetails="Mixed control" panels={null} relations={props} onCollectedChange={() => {}} onManageBrowsers={() => {}} onOpenWorkspace={() => {}} /></>))
  return props
}
async function open() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Exploration options"]')!
  expect(trigger).not.toBeNull(); await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
  const sub = document.querySelector<HTMLElement>('[aria-label="Link Topics"]')!
  expect(sub).not.toBeNull(); await act(async () => sub.focus()); await key(sub, 'ArrowRight')
  expect(menu()).not.toBeNull(); return trigger
}
async function close() {
  await key(menu()!, 'Escape')
  const parent = document.querySelector<HTMLElement>('.survey-item-menu')
  if (parent) await key(parent, 'Escape')
}

it('uses exact Topic identities and only owner props update checked relations', async () => {
  const props = await mount({ topics: [topicA, topicB, topicA, mote] }); await open()
  expect(menu()!.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2)
  expect(checkbox('topic-a').getAttribute('aria-checked')).toBe('true')
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('false')
  expect(checkbox('topic-b').getAttribute('aria-label')).toContain('remote, /topics/b')
  expect(checkbox('topic-b').textContent).toContain('remote · /topics/b')
  await act(async () => checkbox('topic-b').click())
  expect(props.onLinkChange).toHaveBeenCalledExactlyOnceWith('topic-b', true)
  expect(props.onOpenTopic).not.toHaveBeenCalled()
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('false')
  await mount({ ...props, relatedTopics: [topicA, topicB] })
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('true')
  await act(async () => checkbox('topic-b').click())
  expect(props.onLinkChange).toHaveBeenCalledTimes(2)
  expect(props.onLinkChange).toHaveBeenLastCalledWith('topic-b', false)
  expect(menu()).not.toBeNull()
})

it.each([{ topics: null }, { topics: [topicA] }])('keeps a confirmed linked Topic removable when discovery omits it (%j)', async ({ topics }) => {
  const props = await mount({ topics, relatedTopics: [topicB] }); await open()
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('true')
  await act(async () => checkbox('topic-b').click())
  expect(props.onLinkChange).toHaveBeenCalledExactlyOnceWith('topic-b', false)
  expect(props.onOpenTopic).not.toHaveBeenCalled()
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('true')
  if (topics === null) expect(menu()!.textContent).toContain('Topic discovery is not confirmed.')
})

it('shows unknown relations as mixed and refuses guesses while preserving visible feedback', async () => {
  const props = await mount({ relatedTopics: null, error: 'The relationship read is unconfirmed.', notice: 'Original work remains available.' }); await open()
  expect(menu()!.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2)
  for (const id of ['topic-a', 'topic-b']) {
    expect(checkbox(id).getAttribute('aria-checked')).toBe('mixed')
    expect(checkbox(id).getAttribute('aria-disabled')).toBe('true')
    await act(async () => checkbox(id).click())
  }
  expect(props.onLinkChange).not.toHaveBeenCalled(); expect(props.onOpenTopic).not.toHaveBeenCalled()
  expect(menu()!.textContent).toContain('Topic links are not confirmed.')
  expect(menu()!.textContent).toContain('The relationship read is unconfirmed.')
  expect(menu()!.textContent).toContain('Original work remains available.')
  await close(); expect(menu()).toBeNull()
})

it('keeps pending relation changes controlled and opening a linked Topic independent', async () => {
  const props = await mount({ pendingSpaceId: 'topic-b', notice: 'Local relationship applied; disk save is not confirmed.' }); await open()
  expect(menu()!.querySelector('[data-survey-topic-id="topic-b"] .spin')).not.toBeNull()
  expect(checkbox('topic-a').getAttribute('aria-disabled')).toBe('true')
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('false')
  const navigation = document.querySelector<HTMLElement>('[role="menuitem"][data-survey-topic-id="topic-a"]')!
  expect(navigation).not.toBeNull(); await act(async () => navigation.click())
  expect(props.onOpenTopic).toHaveBeenCalledExactlyOnceWith('topic-a'); expect(props.onLinkChange).not.toHaveBeenCalled()
  expect(props.notice).toContain('disk save is not confirmed.')
})

it('keeps the original editor draft and selection while explicit Item-menu disclosure follows Radix', async () => {
  const props = await mount()
  const editor = container.querySelector('input')!, trigger = container.querySelector('[aria-label="Exploration options"]')!
  editor.focus(); editor.setSelectionRange(3, 14); await pointer(trigger, 'pointerover')
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(editor)
  await open(); await pointer(checkbox('topic-a'), 'pointermove')
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14])
  expect(editor.value).toBe('Retain this editor selection')
  await close(); expect(menu()).toBeNull(); expect(props.onLinkChange).not.toHaveBeenCalled()
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14])
})

it('lets Radix keyboard selection toggle only the chosen relation and Escape restore trigger focus', async () => {
  const props = await mount(), trigger = await open()
  await act(async () => checkbox('topic-b').focus()); await key(checkbox('topic-b'), 'Enter')
  expect(props.onLinkChange).toHaveBeenCalledExactlyOnceWith('topic-b', true)
  expect(props.onOpenTopic).not.toHaveBeenCalled(); expect(menu()).not.toBeNull()
  await close(); expect(menu()).toBeNull()
  await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)) })
})

it('selects the original Zone and keeps its resource and membership actions in the single selected Item menu', async () => {
  const onSelect = vi.fn(), onOpenWorkspace = vi.fn(), onCollectedChange = vi.fn()
  const resource = { id: 'foreign-resource', name: 'Resource project', hostId: 'remote', path: '/source/worktree', branch: 'resource-branch', kind: 'worktree' as const }
  const render = async (sourceWorkspace: typeof resource | null, relatedTopics: AgentMuxSpaceFact[] | null) => {
    await act(async () => root.render(<><SurveyZoneItem zone={zone} title="Original mixed workface" glyph={<span>Mixed</span>} selected activity="Mixed" onSelect={onSelect} />
      <SurveyItemOptions visible title="Original mixed workface" zone={zone} workspace={sourceWorkspace} relatedTopics={relatedTopics} collected={false}
        onCollectedChange={onCollectedChange} activityDetails="Two Browsers: mixed control" panels={null} relations={null}
        onManageBrowsers={() => {}} onOpenWorkspace={onOpenWorkspace} /></>))
  }
  await render(resource, [topicA, topicB, mote])
  const select = container.querySelector<HTMLButtonElement>('[aria-current="true"]')!, trigger = container.querySelector<HTMLButtonElement>('[aria-label="Exploration options"]')!
  await act(async () => select.click()); expect(onSelect).toHaveBeenCalledExactlyOnceWith('original-zone')
  expect(container.querySelectorAll('.survey-item-details')).toHaveLength(0)
  expect(container.textContent).not.toContain('Resource project')
  await act(async () => trigger.focus()); await key(trigger, 'ArrowDown')
  const main = document.querySelector<HTMLElement>('.survey-item-menu')!
  expect(main).not.toBeNull()
  const member = main.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!
  await act(async () => member.focus()); await key(member, 'Enter')
  expect(onCollectedChange).toHaveBeenCalledExactlyOnceWith(true)
  const details = [...main.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Details')!
  expect(details).not.toBeNull(); await act(async () => details.focus()); await key(details, 'ArrowRight')
  const content = document.querySelector('.survey-item-details-content')!
  expect(content).not.toBeNull(); expect(content.textContent).toContain('2 linked Topics')
  expect(content.textContent).toContain('Research · remote · /topics/b'); expect(content.textContent).toContain('Branch: resource-branch')
  expect(content.textContent).not.toContain('Branch: work'); expect(content.textContent).toContain('Two Browsers: mixed control')
  await key(content.closest<HTMLElement>('[role="menu"]')!, 'Escape')
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  if (!document.querySelector('.survey-item-menu')) await key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(document.querySelector('.survey-item-menu')).not.toBeNull())
  const source = document.querySelector<HTMLElement>('[aria-label="Open resource Workspace: Resource project, remote, /source/worktree"]')!
  expect(source).not.toBeNull(); await act(async () => source.click()); expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith('foreign-resource')
  await render(null, null); await key(trigger, 'ArrowDown')
  expect(document.querySelector('[aria-label^="Open resource Workspace:"]')).toBeNull()
})
