// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { ScratchTopics } from '../../host/src/mote-resources'
import { serializeMoteQuickMode, parseMoteQuickMode } from '../../host/src/mote-model'
import { runCompiledObjectCli, objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { MoteQuickModeDialog } from '../src/renderer/src/components/MoteQuickMode'
import { readMoteQuickDefaults } from '../src/renderer/src/lib/mote-quick-mode'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { seedMoteWorkface } from './fixtures/mote-workface'
import { chooseField } from './helpers/selection-field'

const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const state = useAppStore.getState(), launcher = useLauncherState.getState()
  const dispose = await state.initialize(); dispose?.()
  closes.push(() => { useAppStore.setState(state, true); useLauncherState.setState(launcher, true) })
  localStorage.clear(); seedMoteWorkface(); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
})
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
const button = (parent: ParentNode, label: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)!
async function click(node: HTMLElement) { expect(node).toBeDefined(); await act(async () => node.click()) }
async function mount(node: ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(<DesktopClientUiProvider>{node}</DesktopClientUiProvider>))
  return element
}
async function original(defaults = {}) {
  const f = await createMoteConversationStartFixture(); closes.push(f.close)
  await writeFile(f.path, serializeMoteQuickMode('', defaults) + '\nOriginal cooperation notes.\n')
  const workspace = { id: f.target.expectedResource.workspaceId, hostId: f.target.expectedResource.hostId, path: f.target.expectedResource.workspacePath, name: 'Original', kind: 'folder' as const }
  const readTopic = () => new ScratchTopics().read(workspace, 'launcher:start-fixture')
  const topic = (await readTopic())!, scope = { workspace, topic, rootPath: topic.directoryPath! }
  const refresh = async () => {
    const next = (await readTopic())!
    useAppStore.setState({ scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: Date.now(), topics: [next], reading: false, error: null } } })
  }
  // Deliberately different from the original Host: the form must never offer this device's cached choice.
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [workspace], executors: { 'client-only': { label: 'Wrong device choice', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } },
    spaceZoneBindings: { [f.target.zoneId]: { spaceId: f.target.spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote' } },
    moteMainCreationReferences: {}, dirtyDocuments: {}, documentIssues: {}, refreshScratchTopics: refresh,
    sessions: [], activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    workbenchSpaceSelection: { workspaceId: workspace.id, spaceId: f.target.spaceId, zoneId: f.target.zoneId, topicId: topic.id, groupId: 'original-group', tabId: null, regionId: null },
    tabs: {}, layouts: { [workspace.id]: { root: { type: 'leaf', groupId: 'original-group' }, activeGroupId: 'original-group', groups: [{ id: 'original-group', tabOrder: [], activeTabId: null, recentTabIds: [] }] } } }))
  await refresh()
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => [(await readTopic())!])
  vi.spyOn(api.scratch, 'readTopic').mockImplementation(readTopic)
  vi.spyOn(api.motePreferences, 'read').mockImplementation(input => f.rpc.call('space.mote.preferences.read', input))
  const saves = vi.spyOn(api.motePreferences, 'save').mockImplementation(input => f.rpc.call('space.mote.preferences.save', input))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => f.rpc.call('space.mote.dialogue.read', input))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.read())
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const open = vi.spyOn(api.spatial, 'openAgent')
  return { f, scope, refresh, saves, open, key: moteEntryDraftKey(scope) }
}

it('keeps the original first message through adjacent setup, selects the Host choice, saves through RPC and returns ready without sending', async () => {
  const m = await original(), draft = '先保留我的原问题，配置完成后再发。'
  useLauncherState.getState().setDraft(m.key, 'prompt', draft)
  const element = await mount(<MoteWorkface workspaceId={m.scope.workspace.id} topicId={m.scope.topic.id} floating visible recoverOnOpen={false}><div /></MoteWorkface>)
  await wait(() => expect(button(element, '配置 Agent')).toBeDefined())
  const action = button(element, '配置 Agent')
  expect(action.closest('details')).toBeNull()
  expect(button(element, 'Send').disabled).toBe(true)
  expect(element.querySelector('.tiptap')?.textContent).toContain(draft)
  await click(action)
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Saved settings loaded'))
  const field = document.querySelector<HTMLElement>('[aria-label="Executor for new chat"]')!
  await chooseField(field, 'saved')
  expect(field.textContent).toContain('Saved')
  expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).not.toContain('Wrong device choice')
  await click(button(document.querySelector('.mote-quick-mode-dialog')!, 'Save and continue'))
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')).toBeNull())
  await wait(() => expect(button(element, 'Send').disabled).toBe(false))
  expect(useLauncherState.getState().drafts[m.key]?.prompt).toBe(draft)
  expect(element.querySelector('.tiptap')?.textContent).toContain(draft)
  expect(m.saves).toHaveBeenCalledTimes(1)
  expect(m.saves.mock.calls[0]![0]).toMatchObject({ kind: 'quick', values: { executorId: 'saved' } })
  expect(parseMoteQuickMode(await readFile(m.f.path, 'utf8'))).toMatchObject({ defaults: { executorId: 'saved' } })
  expect(await readFile(m.f.path, 'utf8')).toContain('Original cooperation notes.')
  expect(m.open).not.toHaveBeenCalled(); expect(m.f.h.started).toHaveLength(0)
  // The actual CLI consumes the same Host choices and can save another preference without another creator or input.
  const cliEnv = objectCliEnvironment(m.f.h.root)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + m.f.server.path, 'space', 'mote', 'preferences', 'read', '--input', '-'], cliEnv, JSON.stringify({ kind: 'quick', target: m.f.target }))
  expect(cli.code, cli.stderr).toBe(0)
  const read = JSON.parse(cli.stdout).result
  expect(read.choices.executors).toEqual([{ id: 'saved', name: 'Saved', providerId: 'codex' }])
  const input = { ...m.saves.mock.calls[0]![0], operationId: 'original-cli-setup-save', baseline: { resource: read.source.resource, document: read.source.result.document, defaults: read.defaults }, values: { ...read.defaults, conversationRollover: { kind: 'keep-current' } } }
  const saved = await runCompiledObjectCli(['--endpoint', 'unix:' + m.f.server.path, 'space', 'mote', 'preferences', 'save', '--input', '-'], cliEnv, JSON.stringify(input))
  expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).result.status).toBe('saved')
  expect(m.f.h.started).toHaveLength(0)
}, 60000)

it('retains an absent saved Executor when editing unrelated preferences', async () => {
  const m = await original({ executorId: 'retained-original' }), close = vi.fn()
  await mount(<MoteQuickModeDialog scope={m.scope} onOpenPath={async () => false} onClose={close} returnFocus={() => null} />)
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Saved settings loaded'))
  expect(document.querySelector('[aria-label="Executor for new chat"]')?.textContent).toContain('retained-original')
  await click(document.querySelector<HTMLElement>('[aria-label="Enable automatic Mote maintenance"]')!)
  await click(button(document.querySelector('.mote-quick-mode-dialog')!, 'Save'))
  await wait(() => expect(close).toHaveBeenCalledTimes(1))
  expect(m.saves.mock.calls[0]![0]).toMatchObject({ kind: 'quick', values: { executorId: 'retained-original' } })
  const result = await readMoteQuickDefaults(m.scope)
  expect(result.defaults.executorId).toBe('retained-original')
  expect(m.open).not.toHaveBeenCalled()
}, 60000)

it('keeps the draft selection on failed original reads without offering another device\'s choices', async () => {
  const m = await original({ executorId: 'retained-original' })
  vi.mocked(api.motePreferences.read).mockRejectedValue(Error('Original Host disconnected'))
  await mount(<MoteQuickModeDialog scope={m.scope} onOpenPath={async () => false} onClose={() => {}} returnFocus={() => null} />)
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Original Host disconnected'))
  const field = document.querySelector<HTMLElement>('[aria-label="Executor for new chat"]')!
  expect(field.textContent).toContain('retained-original')
  await act(async () => { field.focus(); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  await wait(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  expect(document.querySelector('[data-value="client-only"]')).toBeNull()
  expect(button(document.querySelector('.mote-quick-mode-dialog')!, 'Save').disabled).toBe(true)
  expect(m.saves).not.toHaveBeenCalled(); expect(m.open).not.toHaveBeenCalled()
}, 60000)

it('retains the chosen Executor and original file when its Host configuration changes before Save', async () => {
  const m = await original(), close = vi.fn(), before = await readFile(m.f.path, 'utf8')
  await mount(<MoteQuickModeDialog scope={m.scope} onOpenPath={async () => false} onClose={close} returnFocus={() => null} />)
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('Saved settings loaded'))
  await chooseField(document.querySelector<HTMLElement>('[aria-label="Executor for new chat"]')!, 'saved')
  const path = join(m.f.h.root, 'configuration.json'), config = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...config, executors: {} }))
  await click(button(document.querySelector('.mote-quick-mode-dialog')!, 'Save'))
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')?.textContent).toContain('The selected original Executor is unconfirmed.'))
  expect(document.querySelector('[aria-label="Executor for new chat"]')?.textContent).toContain('Saved')
  expect(await readFile(m.f.path, 'utf8')).toBe(before)
  expect(close).not.toHaveBeenCalled(); expect(m.open).not.toHaveBeenCalled()
  await click(button(document.querySelector('.mote-quick-mode-dialog')!, 'Reread'))
  await wait(() => expect(document.querySelector('[aria-label="Executor for new chat"]')?.textContent).toContain('saved'))
  expect(document.querySelector('[aria-label="Executor for new chat"]')?.textContent).not.toContain('Wrong device choice')
  expect(m.saves).toHaveBeenCalledTimes(1)
}, 60000)
