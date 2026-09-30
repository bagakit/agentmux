// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceFact, AgentMuxZoneFact } from '@agentmux/core/control'
import { SurveyTopicRelations } from '../src/renderer/src/components/SurveyTopicRelations'
import { SurveyZoneItem } from '../src/renderer/src/components/SurveyZoneItem'

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
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
function checkbox(id: string) {
  const item = document.querySelector<HTMLElement>(`[role="menuitemcheckbox"][data-survey-topic-id="${id}"]`)
  expect(item, `actual checkbox for ${id}`).not.toBeNull(); return item!
}
async function mount(overrides: Partial<ComponentProps<typeof SurveyTopicRelations>> = {}) {
  const props = { zone, topics: [topicA, topicB], relatedTopics: [topicA], pendingSpaceId: null, onLinkChange: vi.fn(), onOpenTopic: vi.fn(), ...overrides }
  await act(async () => root.render(<><input aria-label="original editor" defaultValue="Retain this editor selection" /><SurveyTopicRelations {...props} /></>))
  return props
}
async function open() {
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Link Topics"]')!
  expect(trigger).not.toBeNull(); await act(async () => trigger.focus()); await key(trigger, 'ArrowDown'); expect(menu()).not.toBeNull(); return trigger
}

it('uses exact Topic identities and only owner props update checked relations', async () => {
  const props = await mount({ topics: [topicA, topicB, topicA, mote] }); await open()
  expect(document.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2)
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
  expect(document.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(2)
  for (const id of ['topic-a', 'topic-b']) {
    expect(checkbox(id).getAttribute('aria-checked')).toBe('mixed')
    expect(checkbox(id).getAttribute('aria-disabled')).toBe('true')
    await act(async () => checkbox(id).click())
  }
  expect(props.onLinkChange).not.toHaveBeenCalled(); expect(props.onOpenTopic).not.toHaveBeenCalled()
  expect(menu()!.textContent).toContain('Topic links are not confirmed.')
  await key(menu()!, 'Escape'); expect(menu()).toBeNull()
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('The relationship read is unconfirmed.')
  expect(container.textContent).toContain('Original work remains available.')
})

it('keeps pending relation changes controlled and opening a linked Topic independent', async () => {
  const props = await mount({ pendingSpaceId: 'topic-b', notice: 'Local relationship applied; disk save is not confirmed.' }); await open()
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Updating Topic link…')
  expect(checkbox('topic-a').getAttribute('aria-disabled')).toBe('true')
  expect(checkbox('topic-b').getAttribute('aria-checked')).toBe('false')
  const navigation = document.querySelector<HTMLElement>('[role="menuitem"][data-survey-topic-id="topic-a"]')!
  expect(navigation).not.toBeNull(); await act(async () => navigation.click())
  expect(props.onOpenTopic).toHaveBeenCalledExactlyOnceWith('topic-a'); expect(props.onLinkChange).not.toHaveBeenCalled()
  expect(container.textContent).toContain('disk save is not confirmed.')
})

it('uses the original hover wrapper to preserve the editor caret through checkbox hover and exit', async () => {
  const props = await mount()
  const editor = container.querySelector('input')!, trigger = container.querySelector('[aria-label="Link Topics"]')!
  editor.focus(); editor.setSelectionRange(3, 14); await pointer(trigger, 'pointerover')
  expect(menu()).not.toBeNull(); expect(document.activeElement).toBe(editor)
  await pointer(checkbox('topic-a'), 'pointermove')
  await pointer(checkbox('topic-a'), 'pointerout', checkbox('topic-b'))
  await pointer(checkbox('topic-b'), 'pointermove')
  expect(document.activeElement).toBe(editor); expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14])
  await pointer(checkbox('topic-b'), 'pointerout', editor)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(editor)
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 14]); expect(props.onLinkChange).not.toHaveBeenCalled()
})

it('lets Radix keyboard selection toggle only the chosen relation and Escape restore trigger focus', async () => {
  const props = await mount(), trigger = await open()
  await act(async () => checkbox('topic-b').focus()); await key(checkbox('topic-b'), 'Enter')
  expect(props.onLinkChange).toHaveBeenCalledExactlyOnceWith('topic-b', true)
  expect(props.onOpenTopic).not.toHaveBeenCalled(); expect(menu()).not.toBeNull()
  await key(menu()!, 'Escape'); expect(menu()).toBeNull()
  await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)) })
})

it('selects the original Zone and opens only the separately supplied resource Workspace', async () => {
  const onSelect = vi.fn(), onOpenWorkspace = vi.fn()
  const resource = { id: 'foreign-resource', name: 'Resource project', hostId: 'remote', path: '/source/worktree', branch: 'resource-branch', kind: 'worktree' as const }
  const render = async (sourceWorkspace: typeof resource | null, relatedTopics: AgentMuxSpaceFact[] | null) => {
    await act(async () => root.render(<SurveyZoneItem zone={zone} title="Original mixed workface" selected sourceWorkspace={sourceWorkspace}
      relatedTopics={relatedTopics} activity="Two Browsers: mixed control" onSelect={onSelect} onOpenWorkspace={onOpenWorkspace} />))
  }
  await render(resource, [topicA, topicB, mote])
  const select = container.querySelector<HTMLButtonElement>('[aria-current="true"]')!, source = container.querySelector<HTMLButtonElement>('.survey-item-source')!
  await act(async () => select.click()); expect(onSelect).toHaveBeenCalledExactlyOnceWith('original-zone')
  await act(async () => source.click()); expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith('foreign-resource')
  expect(source.getAttribute('aria-label')).toContain('remote, /source/worktree')
  expect(source.title).toContain('Branch: resource-branch')
  expect(source.title).not.toContain('Branch: work')
  expect(container.querySelector('small')!.textContent).toBe('2 linked Topics')
  expect(container.querySelector('small')!.getAttribute('aria-label')).toContain('Research · remote · /topics/b')
  expect(container.textContent).toContain('Two Browsers: mixed control')
  await render(null, null); expect(container.textContent).toContain('Topic links unknown'); expect(container.textContent).toContain('Resource unknown')
  expect(container.querySelector('button.survey-item-source')).toBeNull()
})
