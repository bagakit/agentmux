// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { MoteDialoguePage, MoteDialogueRead } from '@agentmux/core/mote-dialogue'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { MoteTaskAction, type MoteTaskActionItem, type MoteTaskRecipient } from '../src/renderer/src/components/MoteTaskAction'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const scratch = { ...composerConfig.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'Motes' }
const mote = (id: string, title: string): ScratchTopicSnapshot => ({ id, title, summary: '', collaborators: [], kind: 'mote',
  directoryPath: scratchTopicDirectoryName(id), topicPath: scratchTopicDirectoryName(id) + '/topic.md',
  soul: { path: scratchTopicDirectoryName(id) + '/SOUL.md', content: 'Original role', version: 'v1' } })
const leader = mote(PMO_TEAMS_TOPIC_ID, 'Original Mote'), other = mote('launcher:other-helper', 'Other helper')
const scope = { workspace: scratch, topic: leader, rootPath: scratchTopicLogicalPath(scratch, leader)! }
const reference = { hostId: 'local', sessionId: 'original-main', displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: 'mote-tab', regionId: 'main-region' }
function page(input: MoteDialogueRead, current = true): MoteDialoguePage {
  return { main: { target: input.target, identity: null, status: 'ready', resource: null, documentRevision: 'doc-v1', roleRevision: 'role-v1', current: current ? reference : null, issue: null },
    links: [], incarnation: null, throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
const actions = (): readonly MoteTaskActionItem[] => ['Organize', 'Analyze', 'Learn'].map(id => ({ id, label: id,
  description: `${id} this original group`, createTask: vi.fn(async (recipient: MoteTaskRecipient) => `${id}: ${JSON.stringify(recipient)}. Ask the user before changing original work.`) }))
beforeEach(() => {
  installNoteCanvasGeometry()
  const main = composerSession('main-ui'); main.control.agentSessionId = reference.sessionId
  const sameIdOtherHost = composerSession('wrong-host'); sameIdOtherHost.control = { ...sameIdOtherHost.control, hostId: 'remote', agentSessionId: reference.sessionId }
  const tab = { ...createWorkbenchTab(reference.tabId, { regionId: reference.regionId, kind: 'agent', phase: 'attached', workspaceId: scratch.id, sessionId: main.id }), topicId: leader.id }
  useLauncherState.setState({ drafts: {}, moteTopicId: null, persistenceIssue: null })
  useAppStore.setState({ config: { ...structuredClone(composerConfig), workspaces: [...composerConfig.workspaces, scratch] }, sessions: [main, sameIdOtherHost],
    tabs: { [tab.id]: tab }, layouts: { [scratch.id]: createWorkspaceLayout(reference.groupId, [tab.id]) },
    scratchTopicSnapshots: { [scratch.id]: { scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 0, reading: false, error: null, topics: [leader, other] } },
    spaceZoneBindings: {}, agentSteerQueues: {}, agentComposerDrafts: { 'main-ui': 'Keep Main draft', 'wrong-host': 'Keep remote draft' },
    refreshScratchTopics: vi.fn().mockResolvedValue(undefined), sendQueuedAgentSteer: vi.fn().mockResolvedValue(undefined) })
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => page(input))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  requestPmoTeamsTopicFloatingClose()
})
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node =>
    (node.hasAttribute('data-mote-task-action-id') ? node.firstElementChild?.textContent?.trim() : node.textContent?.trim()) === label && !node.closest('[hidden], [inert]'))
  expect(button, `Visible original button ${label}`).toBeDefined()
  await act(async () => { button!.focus(); button!.click() })
}
async function choose(label: string) {
  const trigger = document.querySelector('[aria-label^="Choose recipient:"]')
  expect(trigger).not.toBeNull()
  await act(async () => trigger!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes(label))
  expect(item, `Original recipient menu item ${label}`).toBeDefined()
  await act(async () => item!.click())
}
const queue = () => useAppStore.getState().agentSteerQueues['main-ui'] ?? []

it('three vertical actions share one directory consumer and queue distinct payloads to the exact Main with its role revision', async () => {
  const items = actions()
  await dom.render(<MoteTaskAction scopeKey="original-group" orientation="vertical" actions={items} />)
  expect(dom.container.querySelectorAll('.launcher-mote__target')).toHaveLength(1)
  expect(useAppStore.getState().refreshScratchTopics).toHaveBeenCalledOnce()
  for (const item of items) await click(item.label)
  expect(queue()).toHaveLength(3)
  expect(queue().map(item => item.text.split(':')[0])).toEqual(['Organize', 'Analyze', 'Learn'])
  for (const item of queue()) expect(item.moteMain).toEqual({ target: moteConnectionTarget(scope, {}), expectedRoleRevision: 'role-v1' })
  expect(useAppStore.getState().agentSteerQueues['wrong-host']).toBeUndefined()
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'main-ui': 'Keep Main draft', 'wrong-host': 'Keep remote draft' })
  await click('Analyze')
  expect(queue()).toHaveLength(3)
})

it('an explicit New Agent target changes only the menu choice and delegates its prompt without Main reads or implicit launch', async () => {
  const onTask = vi.fn(), launch = vi.spyOn(useAppStore.getState(), 'launchAgent'), items = actions()
  await dom.render(<MoteTaskAction scopeKey="group" orientation="vertical" actions={items} newAgent={{ key: 'exact-project', onTask }} />)
  await choose('New Agent')
  expect(useLauncherState.getState().moteTopicId).toBeNull()
  expect(onTask).not.toHaveBeenCalled(); expect(api.moteDialogue.read).not.toHaveBeenCalled()
  await click('Analyze')
  expect(items[1]!.createTask).toHaveBeenCalledExactlyOnceWith({ kind: 'new-agent', targetKey: 'exact-project' })
  expect(onTask).toHaveBeenCalledOnce(); expect(onTask.mock.calls[0]![0]).toContain('Analyze:')
  expect(onTask.mock.calls[0]![1]()).toBe(true)
  expect(launch).not.toHaveBeenCalled(); expect(queue()).toEqual([]); expect(api.moteDialogue.read).not.toHaveBeenCalled()
  expect(useLauncherState.getState().drafts).toEqual({})
})

it('changing the exact New Agent project retains its kind selection and supersedes the old prepared prompt', async () => {
  let finish!: (prompt: string) => void
  const items = [{ id: 'analyze', label: 'Analyze', createTask: vi.fn(() => new Promise<string>(resolve => { finish = resolve })) }]
  const onTask = vi.fn()
  const show = (key: string) => dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" newAgent={{ key, onTask, details: <span>Exact project {key}</span> }} />)
  await show('first'); await choose('New Agent'); await click('Analyze')
  await show('second')
  expect(document.querySelector('[aria-label="Choose recipient: New Agent"]')).not.toBeNull()
  expect(dom.container.textContent).toContain('Exact project second')
  await act(async () => finish('Earlier project prompt'))
  expect(onTask).not.toHaveBeenCalled(); expect(queue()).toEqual([])
})

it('the original chooser can return from New Agent to another real Mote without confusing its ID with a project key', async () => {
  const items = actions(), onTask = vi.fn()
  await dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" newAgent={{ key: other.id, onTask }} />)
  await choose('New Agent'); await choose(other.title)
  expect(useLauncherState.getState().moteTopicId).toBe(other.id)
  await click('Learn')
  expect(items[2]!.createTask).toHaveBeenCalledExactlyOnceWith({ kind: 'mote', topicId: other.id })
  expect(onTask).not.toHaveBeenCalled()
  expect(api.moteDialogue.read).toHaveBeenCalledExactlyOnceWith({ target: moteConnectionTarget({ workspace: scratch, topic: other, rootPath: scratchTopicLogicalPath(scratch, other)! }, {}), kind: 'main' })
  expect(queue()).toHaveLength(1)
})

it('a detached portal stops a pending Main admission and returning to the same scope does not revive it', async () => {
  let finish!: (value: MoteDialoguePage) => void
  vi.mocked(api.moteDialogue.read).mockImplementationOnce(input => new Promise(resolve => { finish = value => resolve(value); void input }))
  const items = actions(), host = document.createElement('div'); document.body.append(host)
  const show = (visible: boolean) => dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" active={visible} portalContainer={visible ? host : null} />)
  try {
    await show(true); await click('Organize'); await show(false); await show(true)
    await act(async () => finish(page(vi.mocked(api.moteDialogue.read).mock.calls[0]![0])))
    expect(queue()).toEqual([]); expect(readPmoTeamsTopicFloatingState()?.open).toBe(false)
  } finally { await dom.render(null); host.remove() }
})

it('a detached portal stops a pending New Agent callback and shares one in-flight guard across actions', async () => {
  let finish!: (value: string) => void
  const items = actions(), onTask = vi.fn(), host = document.createElement('div'); document.body.append(host)
  items[0]!.createTask = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const show = (visible: boolean) => dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" active={visible} portalContainer={visible ? host : null} newAgent={{ key: 'project', onTask }} />)
  try {
    await show(true)
    await act(async () => host.querySelector('[aria-label^="Choose recipient:"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
    const target = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('New Agent'))!
    expect(target).toBeDefined(); expect(host.contains(target)).toBe(true)
    await act(async () => target.click()); await click('Organize')
    expect(host.querySelector('[data-mote-task-action]')?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Preparing task…')
    await click('Analyze'); await show(false)
    await act(async () => finish('Original prepared prompt'))
    expect(onTask).not.toHaveBeenCalled(); expect(items[1]!.createTask).not.toHaveBeenCalled()
  } finally { await dom.render(null); host.remove() }
})

it('queued and unknown receipts survive a portal closing, including a later queue rejection, without replay', async () => {
  let reject!: (cause: unknown) => void
  const send = vi.spyOn(useAppStore.getState(), 'send').mockImplementation((_id, _prompt, rejected) => { reject = rejected!; return true })
  const items = actions(), host = document.createElement('div'); document.body.append(host)
  const show = (visible: boolean) => dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" active={visible} portalContainer={visible ? host : null} />)
  try {
    await show(true); await click('Organize'); await show(false)
    await act(async () => reject(new Error('Original input unconfirmed')))
    await show(true)
    expect(host.textContent).toContain('Delivery needs checking')
    await click('Organize'); expect(send).toHaveBeenCalledOnce(); expect(items[0]!.createTask).toHaveBeenCalledOnce()
  } finally { await dom.render(null); host.remove() }
})

it('a missing Main keeps the exact Mote draft and does not replay it when the Main later appears', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input, false))
  const items = actions(), launch = vi.spyOn(useAppStore.getState(), 'launchAgent')
  await dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" />)
  await click('Learn')
  expect(useLauncherState.getState().drafts[moteEntryDraftKey(scope)]?.prompt).toContain('Learn:')
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input))
  await click('Learn')
  expect(api.moteDialogue.read).toHaveBeenCalledOnce(); expect(queue()).toEqual([]); expect(launch).not.toHaveBeenCalled()
})

it('prepared New Agent tasks reopen the original caller receipt and do not prepare a second Launcher', async () => {
  const items = actions(), onTask = vi.fn(), onOpen = vi.fn()
  await dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" newAgent={{ key: 'project', onTask, onOpen }} />)
  await choose('New Agent'); await click('Organize'); await click('Analyze'); await click('Organize')
  expect(onTask).toHaveBeenCalledTimes(2); expect(onOpen).toHaveBeenCalledExactlyOnceWith(onTask.mock.calls[0]![0])
  expect(onOpen.mock.calls[0]![0]).not.toBe(onTask.mock.calls[1]![0])
  expect(dom.container.textContent).toContain('Task prepared in the original Launcher')
})

it('an unknown New Agent preparation preserves its prompt and opens its original receipt without repeating preparation', async () => {
  const items = actions(), onTask = vi.fn().mockRejectedValue(new Error('Original Launcher preparation unconfirmed')), onOpen = vi.fn()
  await dom.render(<MoteTaskAction scopeKey="group" actions={items} orientation="vertical" newAgent={{ key: 'project', onTask, onOpen }} />)
  await choose('New Agent'); await click('Learn'); await click('Learn')
  expect(onTask).toHaveBeenCalledOnce(); expect(onOpen).toHaveBeenCalledExactlyOnceWith(onTask.mock.calls[0]![0])
  expect(dom.container.textContent).toContain('Original Launcher preparation unconfirmed')
  expect(dom.container.textContent).toContain('Learn:')
  expect(api.moteDialogue.read).not.toHaveBeenCalled(); expect(queue()).toEqual([])
})
