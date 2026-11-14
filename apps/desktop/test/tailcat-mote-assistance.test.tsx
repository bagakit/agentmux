// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { MoteDialoguePage, MoteDialogueRead } from '@agentmux/core/mote-dialogue'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import type { AppConfig, HostConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { HostSettingsPane } from '../src/renderer/src/components/settings/HostSettingsPane'
import { NetworkNodeSettingsPane } from '../src/renderer/src/components/settings/NetworkNodeSettingsPane'
import { MoteTaskAction } from '../src/renderer/src/components/MoteTaskAction'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import { scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { readPmoTeamsTopicFloatingState, requestPmoTeamsTopicFloatingClose } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const scratch = { ...composerConfig.workspaces[0]!, id: SCRATCH_WORKSPACE_ID, name: 'Motes' }
const topic = (id: string, title: string): ScratchTopicSnapshot => ({ id, title, summary: '', collaborators: [], kind: 'mote',
  directoryPath: scratchTopicDirectoryName(id), topicPath: scratchTopicDirectoryName(id) + '/topic.md', soul: { path: scratchTopicDirectoryName(id) + '/SOUL.md', content: 'Helper', version: 'v1' } })
const leader = topic(PMO_TEAMS_TOPIC_ID, 'Mote'), second = topic('launcher:network-helper', 'Network helper')
const remote: HostConfig = { id: 'studio', kind: 'ssh', label: 'Studio Mac', hostname: '', transport: 'tailcat',
  tailcat: { address: 'tc-fixture-only-private-address', keyFile: 'custom-key-field' } }
const scope = { workspace: scratch, topic: leader, rootPath: scratchTopicLogicalPath(scratch, leader)! }
const reference = { hostId: 'local', sessionId: 'core-main', displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: 'mote-tab', regionId: 'main-region' }
let config: AppConfig
function page(input: MoteDialogueRead, current = true): MoteDialoguePage {
  return { main: { target: input.target, identity: null, status: 'ready', resource: null, documentRevision: 'doc-v1', roleRevision: 'role-v1', current: current ? reference : null, issue: null },
    links: [], incarnation: null, throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
beforeEach(() => {
  installNoteCanvasGeometry()
  config = { ...structuredClone(composerConfig), hosts: [structuredClone(composerConfig.hosts[0]!), remote], workspaces: [...composerConfig.workspaces, scratch] }
  const original = { ...createWorkbenchTab('mote-tab', { regionId: 'main-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'main-ui' }), topicId: leader.id }
  const tab = addWorkbenchRegion(original, 'main-region', 'right', { regionId: 'member-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'member-ui' })
  const main = composerSession('main-ui'); main.control.agentSessionId = 'core-main'
  useLauncherState.setState({ drafts: {}, moteTopicId: null, persistenceIssue: null })
  useAppStore.setState({ config, tailcatConnectionDrafts: {}, tabs: { 'mote-tab': { ...tab, layout: { ...tab.layout, activeRegionId: 'member-region' } } },
    layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote-tab']) }, sessions: [main, composerSession('member-ui')],
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 0, reading: false, error: null, topics: [leader, second] } },
    spaceZoneBindings: {}, hostChecks: {}, agentSteerQueues: {}, agentComposerDrafts: { 'main-ui': 'Keep Main draft', 'member-ui': 'Keep member draft' },
    refreshScratchTopics: vi.fn().mockResolvedValue(undefined), sendQueuedAgentSteer: vi.fn().mockResolvedValue(undefined) })
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => page(input))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.hosts, 'inspect').mockImplementation(async host => ({ routeHostId: host.id, configuration: host,
    owner: { state: 'available', value: { runtimeId: 'desktop-runtime-fixture' } }, tailcat: { state: 'disabled' } }) as never)
  vi.spyOn(api.hosts, 'network').mockRejectedValue(new Error('No live network qualification in this fixture'))
  vi.spyOn(api.nodePublishing, 'call').mockRejectedValue(new Error('Publication identity is outside this setup-help test'))
  requestPmoTeamsTopicFloatingClose()
})
const show = (hostId = 'studio') => hostId === 'local'
  ? dom.render(<NetworkNodeSettingsPane config={config} active={true} onSave={async () => {}} onNavigate={() => {}} navigationRequest={{ section: 'network-node', hostId }} />)
  : dom.render(<HostSettingsPane config={config} active={true} onSave={vi.fn()} navigationRequest={{ section: 'hosts', hostId }} />)
async function button(text: string) {
  const found = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].filter(node => node.textContent?.trim() === text)
  expect(found).toHaveLength(1); await act(async () => { found[0]!.focus(); found[0]!.click() })
}

it('both real Tailcat forms expose install guidance and hand off to the logical Main queue instead of the active member', async () => {
  await show()
  expect(dom.container.querySelector('[data-tailcat-help="client"]')?.textContent).toContain('brew install tailcat')
  await button('Ask Mote to handle setup')
  const queue = useAppStore.getState().agentSteerQueues['main-ui']
  expect(queue).toHaveLength(1)
  expect(useAppStore.getState().agentSteerQueues['member-ui']).toBeUndefined()
  expect(queue![0]!.moteMain).toEqual({ target: moteConnectionTarget(scope, {}), expectedRoleRevision: 'role-v1' })
  expect(queue![0]!.text).toContain('desktop-runtime-fixture')
  expect(queue![0]!.text).toContain('Studio Mac')
  expect(queue![0]!.text).not.toContain('tc-fixture-only-private-address')
  expect(queue![0]!.text).not.toContain('custom-key-field')
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ 'main-ui': 'Keep Main draft', 'member-ui': 'Keep member draft' })
  expect(dom.container.textContent).toContain('Task queued. Open Mote to follow up.')
  await button('Open queued task')
  expect(useAppStore.getState().agentSteerQueues['main-ui']).toHaveLength(1)
  await show('local')
  expect(dom.container.querySelector('[data-tailcat-help="server"]')?.textContent).toContain('brew install tailcat')
})

it.each([
  ['RPC_METHOD_NOT_FOUND', 'This AgentMux service cannot prepare keys yet'],
  ['CONTROL_UNAVAILABLE', 'Key preparation is unavailable on this service'],
  ['TAILCAT_CLI_MISSING', 'The service cannot find Tailcat'],
  ['TAILCAT_KEY_CONFLICT', 'This saved key cannot be used here'],
  [null, 'Key preparation could not be confirmed']
] as const)('the real failed Prepare and Mote task retain %s as an exact preparation issue', async (code, title) => {
  const failure = Object.assign(new Error('TAILCAT_CLI_MISSING raw-private-canary'), code ? { code } : {})
  vi.spyOn(api.hosts, 'prepareTailcatKey').mockRejectedValue(failure)
  await show()
  await button('Get this Mac’s code')
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain(title)
  expect(dom.container.textContent).not.toContain('raw-private-canary')
  expect(useAppStore.getState().config?.hosts.find(h => h.id === 'studio')).toEqual(remote)
  expect([...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Get this Mac’s code')?.disabled).toBe(false)
  await button('Ask Mote to handle setup')
  const task = useAppStore.getState().agentSteerQueues['main-ui']![0]!.text
  expect(task).toContain('"step": "prepare-key"')
  expect(task).toContain(`"code": ${JSON.stringify(code)}`)
  expect(task).toContain('"section": "hosts"')
  expect(task).toContain('"hostId": "studio"')
  expect(task).not.toContain('raw-private-canary')
  expect(task).not.toContain('tc-fixture-only-private-address')
  expect(useAppStore.getState().agentComposerDrafts['member-ui']).toBe('Keep member draft')
})

it('the shared chooser uses the explicitly selected Mote resource and role revision', async () => {
  await show()
  await act(async () => dom.container.querySelector('[aria-label^="Choose Mote:"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const choice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Network helper'))!
  expect(choice).toBeDefined(); await act(async () => choice.click())
  expect(useLauncherState.getState().moteTopicId).toBe(second.id)
  await button('Ask Mote to handle setup')
  const target = moteConnectionTarget({ workspace: scratch, topic: second, rootPath: scratchTopicLogicalPath(scratch, second)! }, {})
  expect(api.moteDialogue.read).toHaveBeenCalledExactlyOnceWith({ target, kind: 'main' })
  expect(useAppStore.getState().agentSteerQueues['main-ui']![0]!.moteMain).toEqual({ target, expectedRoleRevision: 'role-v1' })
})

it('no Main preserves an empty original welcome draft without starting an Agent or sending it later on another click', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input, false))
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent')
  await show()
  await button('Ask Mote to handle setup')
  const key = moteEntryDraftKey(scope), saved = useLauncherState.getState().drafts[key]
  expect(saved?.prompt).toContain('brew install tailcat')
  expect(saved?.heldPrompt).toBeUndefined()
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(launch).not.toHaveBeenCalled()
  expect(readPmoTeamsTopicFloatingState()).toMatchObject({ open: true, targetTopicId: leader.id })
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input))
  await button('Open task draft')
  expect(api.moteDialogue.read).toHaveBeenCalledOnce()
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
})

it('an existing Mote draft is never overwritten when no Main is confirmed', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input, false))
  const key = moteEntryDraftKey(scope)
  useLauncherState.getState().setDraft(key, 'prompt', 'Original unsent thought')
  await show()
  await button('Ask Mote to handle setup')
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Original unsent thought')
  expect(dom.container.textContent).toContain('existing draft is kept')
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
})

it.each(['synchronous', 'late'] as const)('a %s rejection callback remains unconfirmed and repeated actions only open the original task', async timing => {
  let reject!: (cause: unknown) => void
  const send = vi.spyOn(useAppStore.getState(), 'send').mockImplementation((_id, _prompt, onRejected) => {
    reject = onRejected!; if (timing === 'synchronous') reject(new Error('Fixture refusal')); return true
  })
  await show()
  await button('Ask Mote to handle setup')
  if (timing === 'late') await act(async () => reject(new Error('Later fixture refusal')))
  expect(dom.container.textContent).toContain('Delivery needs checking')
  await button('Check original task')
  expect(send).toHaveBeenCalledOnce()
})

it('a display-only default Mote after a failed directory read cannot become a guessed dispatch target', async () => {
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 0, reading: false, error: 'Fixture directory unavailable', topics: null } } })
  await show()
  await button('Ask Mote to handle setup')
  expect(api.moteDialogue.read).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
  expect(readPmoTeamsTopicFloatingState()?.targetTopicId).toBe(PMO_TEAMS_TOPIC_ID)
})

it('a later source change while the Main is read cannot send the earlier task', async () => {
  let finish!: (value: MoteDialoguePage) => void
  vi.mocked(api.moteDialogue.read).mockImplementationOnce(() => new Promise(done => { finish = done }))
  const createTask = vi.fn().mockResolvedValue('Original task')
  await dom.render(<MoteTaskAction scopeKey="original" preview="Original task" createTask={createTask} />)
  await button('Ask Mote to handle setup')
  await dom.render(<MoteTaskAction scopeKey="later" preview="Later task" createTask={createTask} />)
  await act(async () => finish(page(vi.mocked(api.moteDialogue.read).mock.calls[0]![0])))
  expect(useAppStore.getState().agentSteerQueues).toEqual({})
})


it('a pending help read can queue its authorized task without reopening hidden settings or stealing later input focus', async () => {
  let finish!: (value: MoteDialoguePage) => void
  vi.mocked(api.moteDialogue.read).mockImplementationOnce(() => new Promise(done => { finish = done }))
  const navigationRequest = { section: 'hosts' as const, hostId: 'studio' }, onSave = vi.fn()
  const render = (hidden: boolean) => dom.render(<section hidden={hidden}><HostSettingsPane config={config} active={!hidden} onSave={onSave} navigationRequest={navigationRequest} /></section>)
  await render(false)
  await button('Ask Mote to handle setup')
  const otherInput = document.createElement('input'); document.body.append(otherInput)
  await act(async () => { otherInput.focus(); otherInput.dispatchEvent(new Event('input', { bubbles: true })) })
  await render(true)
  await act(async () => finish(page(vi.mocked(api.moteDialogue.read).mock.calls[0]![0])))
  expect(useAppStore.getState().agentSteerQueues['main-ui']).toHaveLength(1)
  expect(readPmoTeamsTopicFloatingState()?.open).toBe(false)
  expect(document.activeElement).toBe(otherInput)
  otherInput.remove()
})
