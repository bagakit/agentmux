// @vitest-environment happy-dom
import { act, type ReactNode, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { scratchTopicLogicalPath, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { ScratchTopics } from '../../host/src/mote-resources'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { MoteMainActions } from '../src/renderer/src/components/MoteMainActions'
import { MoteConversationStart as StartSource } from '../src/renderer/src/components/MoteConversationStart'
import { DesktopMoteComposerHost } from '../src/renderer/src/components/MoteComposer'
import { ComposerSurface } from '@agentmux/client-ui/components/ComposerHost'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { MoteDialogueViewProvider } from '../src/renderer/src/lib/mote-dialogue-view'
import { readMoteMainAction } from '../src/renderer/src/lib/mote-main-action'
import { desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteAgent, seedMoteWorkface } from './fixtures/mote-workface'

function MoteConversationStart(props: ComponentProps<typeof StartSource>) {
  return <DesktopMoteComposerHost scope={props.scope} sourceKey="welcome" active={props.active}>
    <StartSource {...props} /><ComposerSurface />
  </DesktopMoteComposerHost>
}

async function topicAt(workspace: Parameters<ScratchTopics['readForDirectory']>[0], directory: string) {
  const topics = new ScratchTopics(), fact = await topics.readForDirectory(workspace, directory)
  return fact ? topics.read(workspace, fact.id) : null
}

const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prior = useAppStore.getState(), launcher = useLauncherState.getState()
  const dispose = await useAppStore.getState().initialize(); dispose?.()
  closes.push(() => { useAppStore.setState(prior, true); useLauncherState.setState(launcher, true) })
  localStorage.clear(); seedMoteWorkface()
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
})
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 15_000 }) }
async function mounted(node: ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(<DesktopClientUiProvider>{node}</DesktopClientUiProvider>))
  return element
}
const buttonIn = (parent: ParentNode, label: string) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)

/** A real Host Mote whose original role owner has a current Main, projected into the actual Desktop store. */
async function boundMote(dialogueRead?: (input: Parameters<typeof api.moteDialogue.read>[0]) => ReturnType<typeof api.moteDialogue.read>) {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  const workspace = { ...f.target.expectedResource, id: f.target.expectedResource.workspaceId, hostId: f.target.expectedResource.hostId,
    path: f.target.expectedResource.workspacePath, name: 'Original scratch', kind: 'folder' as const }
  const topic = await topicAt(workspace, dirname(f.path))
  if (!topic) throw Error('The real Host Mote directory must be discoverable')
  const scope: MoteWorkfaceScope = { workspace, topic, rootPath: scratchTopicLogicalPath(workspace, topic) ?? scratchTopicDirectoryName(topic.id) }
  const state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [workspace], executors: { saved: { label: 'Saved', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } },
    spaceZoneBindings: { [f.target.zoneId]: { spaceId: f.target.spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote' } },
    moteMainCreationReferences: {}, dirtyDocuments: {}, documentIssues: {}, refreshScratchTopics: vi.fn(async () => {}) })
  vi.spyOn(api.motePreferences, 'read').mockImplementation(input => f.rpc.call('space.mote.preferences.read', input))
  vi.spyOn(api.moteDialogue, 'inspectSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.inspect', input))
  vi.spyOn(api.moteDialogue, 'advanceSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.advance', input))
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as never)
  vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled recovery boundary'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.read())
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const open = vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => f.rpc.call('agent.open', input))
  await f.start('original-bound-main'); await f.setup('original-bound-main')
  const idle = await f.qualifyMainIdle(1), current = idle.snapshot.current!
  open.mockClear()
  const read = vi.spyOn(api.moteDialogue, 'read').mockImplementation(dialogueRead ?? (input => f.rpc.call('space.mote.dialogue.read', input)))
  const projected = desktopWorkbenchFromSpatial((await f.spatial.read())!.graph)
  const session = { ...moteAgent(current.sessionId, null, 'waiting'), providerId: 'claude', executorId: 'saved', workspacePath: idle.session!.workspacePath,
    control: { kind: 'agent' as const, hostId: current.hostId, agentSessionId: current.sessionId, run: idle.session!.run } }
  const fresh = await topicAt(workspace, dirname(f.path))
  useAppStore.setState({ tabs: projected.tabs as never, layouts: projected.layouts, sessions: [session],
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [fresh!], error: null, reading: false } } })
  const key = 'mote-main-start:' + JSON.stringify([workspace.hostId, workspace.id, workspace.path, topic.id, scope.rootPath])
  // The last selection is elsewhere (another member Region), so the welcome would be the first frame.
  const elsewhere = { displayWorkspaceId: workspace.id, groupId: current.groupId, tabId: current.tabId, regionId: 'another-member-region' }
  return { f, scope, current, open, read, key, elsewhere, started: () => f.h.started.length }
}

it('cold start shows the Mote at once while its Main is read, and a message sent meanwhile is held, never a new Main', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const m = await boundMote(async input => { await gate; return m.f.rpc.call('space.mote.dialogue.read', input) })
  const before = m.started()
  const element = await mounted(<MoteWorkface workspaceId={m.scope.workspace.id} topicId={m.scope.topic.id} floating visible recoverOnOpen={false}
    reference={m.elsewhere} onReferenceSelect={() => false}><textarea data-original-main defaultValue="原主对话草稿" /></MoteWorkface>)
  // Reading: the Mote's own portrait, name and Composer, with history marked as loading; no create path.
  await wait(() => expect(m.read).toHaveBeenCalled())
  const scene = element.querySelector<HTMLElement>('.mote-start')!
  expect(scene.dataset.mode).toBe('reading')
  expect(scene.querySelector('.mote-start__portrait')).not.toBeNull()
  expect(scene.textContent).toContain('正在接回主对话')
  expect(scene.querySelector('.mote-start-history__skeleton')?.getAttribute('aria-label')).toContain('正在读取原对话历史')
  expect(buttonIn(element, '对话选项')).toBeUndefined()
  // The draft is the Mote's own: typing in its Composer writes the Mote draft; sending only holds it on this device.
  const editor = element.querySelector<HTMLElement>('.mote-composer-surface [contenteditable=true]')!
  await act(async () => {
    editor.textContent = '读取中写下的问题'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '读取中写下的问题' }))
  })
  const key = Object.keys(useLauncherState.getState().drafts).find(id => useLauncherState.getState().drafts[id]?.prompt === '读取中写下的问题')!
  expect(key).toMatch(/^mote-main-start:/)
  await wait(() => expect(element.querySelector<HTMLButtonElement>('[aria-label=Send]')?.disabled).toBe(false))
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label=Send]')!.click())
  await wait(() => expect(element.querySelector('.mote-first-message')?.getAttribute('data-stage')).toBe('held'))
  // The text appears once, as a note waiting to go; the identity, reading state and Composer stay.
  expect(element.textContent).toContain('接上主对话后发出')
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: '', heldPrompt: { prompt: '读取中写下的问题' } })
  expect(element.querySelector('.mote-start[data-mode=reading] .mote-start__portrait')).not.toBeNull()
  expect(element.querySelector('.mote-first-message .log-turn')).toBeNull()
  // Withdrawing returns it to the editable draft; it was never sent.
  await act(async () => buttonIn(element, '撤回')!.click())
  expect(element.querySelector('.mote-first-message')).toBeNull()
  expect(useLauncherState.getState().drafts[key]?.prompt).toBe('读取中写下的问题')
  expect(useLauncherState.getState().drafts[key]?.heldPrompt).toBeUndefined()
  // Reading, scrolling and typing do not cancel landing in the current Main; this reference is another member, so it offers it.
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
  await act(async () => { release() })
  await wait(() => expect(buttonIn(element, '打开当前主对话')).toBeDefined())
  expect(element.querySelector('.mote-start')).toBeNull()
  expect(m.open).not.toHaveBeenCalled(); expect(m.started()).toBe(before)
  expect(element.querySelector<HTMLTextAreaElement>('[data-original-main]')?.value).toBe('原主对话草稿')
}, 60_000)

it('the actual welcome Composer refuses to submit while the original role owner names a current Main', async () => {
  const m = await boundMote(), query = 'A question meant for the current Main'
  const reading = await readMoteMainAction(m.scope)
  expect(reading.issue).toBeNull(); expect(reading.pendingStarts).toEqual([])
  expect(reading.executor?.id).toBe('saved')
  useLauncherState.getState().setDraft(m.key, 'prompt', query)
  const opened = vi.fn()
  const element = await mounted(<MoteDialogueViewProvider scope={m.scope} active><MoteConversationStart scope={m.scope} active mode="start"
    onConfigure={() => {}} onOpenMain={opened} onOpenPeriod={() => {}} /></MoteDialogueViewProvider>)
  await wait(() => expect(element.textContent).toContain('这里不会另建主 Agent'))
  const send = element.querySelector<HTMLButtonElement>('[aria-label=Send]')
  expect(send?.disabled).toBe(true)
  await act(async () => send?.click())
  expect(m.open).not.toHaveBeenCalled()
  expect(useLauncherState.getState().drafts[m.key]?.prompt).toBe(query)
  await act(async () => buttonIn(element, '返回当前主对话')!.click())
  expect(opened).toHaveBeenCalledWith(expect.objectContaining({ sessionId: m.current.sessionId }))
}, 60_000)

it('the Main menu is the shared overlay: Escape and outside press close it and return focus to its trigger', async () => {
  const m = await boundMote()
  const element = await mounted(<MoteDialogueViewProvider scope={m.scope} active><MoteMainActions scope={m.scope} active presentation="menu" onConfigure={() => {}} /></MoteDialogueViewProvider>)
  const trigger = buttonIn(element, '主 Agent')!
  expect(element.querySelector('details')).toBeNull()
  await act(async () => { trigger.focus(); trigger.click() })
  const menu = await vi.waitFor(() => { const node = document.querySelector<HTMLElement>('.mote-main-actions__menu'); expect(node).not.toBeNull(); return node! })
  // Projected through the window overlay host, recognised by the native overlay selector (role=dialog, data-state=open).
  expect(element.contains(menu)).toBe(false)
  expect(menu.getAttribute('role')).toBe('dialog'); expect(menu.getAttribute('data-state')).toBe('open')
  expect(menu.matches('[data-state="open"], [role="dialog"]')).toBe(true)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await wait(() => expect(document.querySelector('.mote-main-actions__menu')).toBeNull())
  await wait(() => expect(document.activeElement).toBe(trigger))
  await act(async () => trigger.click())
  await wait(() => expect(document.querySelector('.mote-main-actions__menu')).not.toBeNull())
  const outside = document.createElement('button'); document.body.append(outside); closes.push(() => outside.remove())
  // Radix registers its outside-press listener on the next task after opening.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => {
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    outside.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    outside.click()
  })
  await wait(() => expect(document.querySelector('.mote-main-actions__menu')).toBeNull())
  expect(m.open).not.toHaveBeenCalled()
}, 60_000)

it('quick mode opened from the Main menu returns focus to the Main trigger when it closes', async () => {
  const m = await boundMote()
  // The current Main Region is selected, so the original Main body and its menu are shown.
  const selected = { displayWorkspaceId: m.current.displayWorkspaceId, groupId: m.current.groupId, tabId: m.current.tabId, regionId: m.current.regionId }
  const element = await mounted(<MoteWorkface workspaceId={m.scope.workspace.id} topicId={m.scope.topic.id} floating visible recoverOnOpen={false}
    reference={selected} onReferenceSelect={() => false}><textarea data-original-main /></MoteWorkface>)
  await wait(() => expect(buttonIn(element, '主 Agent')).toBeDefined())
  const trigger = buttonIn(element, '主 Agent')!
  await act(async () => { trigger.focus(); trigger.click() })
  const menu = await vi.waitFor(() => { const node = document.querySelector<HTMLElement>('.mote-main-actions__menu'); expect(node).not.toBeNull(); return node! })
  await act(async () => buttonIn(menu, '选择已有主 Agent／设置')!.click())
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')).not.toBeNull())
  await act(async () => buttonIn(document.querySelector('.mote-quick-mode-dialog')!, 'Close quick mode')!.click())
  await wait(() => expect(document.querySelector('.mote-quick-mode-dialog')).toBeNull())
  await wait(() => expect(document.activeElement).toBe(trigger))
}, 60_000)
