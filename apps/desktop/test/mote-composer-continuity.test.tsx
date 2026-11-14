// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { createMoteApp, moteClick, moteType, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, customAgent, customTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { desktopUserFragments } from '../src/renderer/src/lib/desktop-user-state'
import { api } from '../src/renderer/src/lib/api'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose, requestAgentConversationFloatingOpen } from '../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'
import { originalTopicAddress } from '../src/shared/space-addresses'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'

const actualSend = useAppStore.getState().send
const otherReference = { hostId: 'local', sessionId: customAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: customTab.id, regionId: customTab.layout.activeRegionId }
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
let app: MoteAppFixture, launcher: ReturnType<typeof useLauncherState.getState>
let release: () => void, submit: MockInstance<typeof api.sessions.submitPrompt>
const button = (name: string) => [...app.panel().querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name || node.textContent?.trim() === name)!
const editor = () => app.panel().querySelector<HTMLElement & { editor: Editor }>('.mote-composer-surface .tiptap')!
const draftKey = () => Object.keys(useLauncherState.getState().drafts).find(key => key.startsWith('mote-main-start:'))!

beforeEach(async () => {
 const initialized = await useAppStore.getState().initialize(); initialized?.()
 launcher = useLauncherState.getState(); app = createMoteApp()
 useLauncherState.setState({ drafts: {}, persistenceIssue: null })
 const topics = moteTopics.map((topic, index) => index > 1 ? topic : { ...topic, quickMode: { status: 'saved' as const,
  version: index ? 'saved-other-role' : 'saved-role', defaults: { conversation: index ? otherReference : reference } } })
 useAppStore.setState({ send: actualSend, agentComposerDrafts: { [defaultAgent.id]: 'Independent Session draft B' },
  scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), topics, revision: 0, error: null, reading: false } } })
 vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
 vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
 const gate = new Promise<void>(done => { release = done })
 vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }) => {
  await gate
  const index = topics.findIndex(topic => originalTopicAddress(scratchWorkspace, topic, {})?.spaceId === target.spaceId)
  if (index < 0 || index > 1) throw Error('This bounded reader only owns the two exact Mote targets.')
  return { main: { target, identity: { hostId: 'local', moteId: topics[index]!.id }, status: 'ready', resource: null,
   documentRevision: 'saved-file', roleRevision: index ? 'saved-other-role' : 'saved-role', current: index ? otherReference : reference, issue: null },
   links: [], incarnation: 'saved-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null } satisfies MoteDialoguePage
 })
 vi.spyOn(api.motePreferences, 'read').mockResolvedValue({ status: 'unconfirmed', issue: null, source: null, choices: { executors: [], conversations: [], destinations: [] }, defaults: {} } as never)
 vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as never)
 vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('Controlled original recovery boundary'))
 vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
 vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
 submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _body, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
})
afterEach(async () => {
 release()
 await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false }))
 await app.dispose(); useLauncherState.setState(launcher, true)
})
async function openReading() {
 await app.mount()
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await vi.waitFor(() => expect(app.panel().querySelector('.mote-start[data-mode=reading]')).not.toBeNull())
 expect(editor()).not.toBeNull()
}
async function land() {
 await act(async () => release())
 await vi.waitFor(() => expect(app.panel().querySelector('.mote-start[data-mode=reading]')).toBeNull())
 await settleMoteApp()
}

it('actual App keeps one editor, selection, composition and Mote text while its current Main loads, then sends from that owner', async () => {
 await openReading()
 const original = editor(), maintained = original.editor
 await moteType(original, 'Draft during loading')
 await act(async () => { maintained.commands.setTextSelection({ from: 3, to: 8 }); original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
 const selection = maintained.state.selection.toJSON()
 await land()
 expect(editor()).toBe(original); expect(editor().editor).toBe(maintained)
 expect(app.panel().querySelector('[data-conversation-process-dock-slot]')).not.toBeNull()
 expect(maintained.state.selection.toJSON()).toEqual(selection)
 expect(original.textContent).toBe('Draft during loading')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })))
 expect(submit).not.toHaveBeenCalled()
 await act(async () => original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
 await moteType(original, 'Later Mote text after loading')
 await moteClick(button('Send'))
 await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
 expect(submit.mock.calls[0]![1]).toBe('Later Mote text after loading')
 expect(submit.mock.calls[0]![3]).toEqual({ expectedRun: defaultAgent.control.run, admissionIntent: { kind: 'manual-actor' } })
 expect(submit.mock.calls[0]![4]?.moteMain).toEqual({ target: { ...originalTopicAddress(scratchWorkspace, moteTopics[0]!, {})!,
  expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }, expectedRoleRevision: 'saved-role' })
 expect(useLauncherState.getState().drafts[draftKey()]?.prompt).toBe('')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 expect(editor()).toBe(original); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
}, 30_000)

it('actual Main history recall edits and restores only the Mote draft, keeping the independent Session draft', async () => {
 await openReading(); await moteType(editor(), 'Keep Mote stash'); await land()
 const original = editor()
 await act(async () => useAppStore.getState().recordAgentComposerHistory(defaultAgent.id, 'Earlier Main query'))
 await act(async () => { original.editor.commands.setTextSelection(1); original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })) })
 await vi.waitFor(() => expect(useLauncherState.getState().drafts[draftKey()]?.prompt).toBe('Earlier Main query'))
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
 await vi.waitFor(() => expect(useLauncherState.getState().drafts[draftKey()]?.prompt).toBe('Keep Mote stash'))
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 expect(Object.keys(useAppStore.getState().agentComposerDrafts)).not.toContain(draftKey())
 expect(editor()).toBe(original)
}, 30_000)


it('actual Pending move keeps its queue and Mote body across a lost draft ACK, then retries the same OP without appending twice', async () => {
 await openReading(); await moteType(editor(), 'Current Mote draft'); await land()
 const original = { operationId: 'original_condition_changed_input', text: 'Queued original body', createdAt: 1,
  runId: defaultAgent.control.run.runId, status: 'failed' as const, errorCode: 'AGENT_PROMPT_CONDITION_CHANGED',
  error: 'Original prompt condition changed', promptCondition: { expectedRun: defaultAgent.control.run, afterSubmissionId: null } }
 await act(async () => useAppStore.setState({ agentSteerQueues: { [defaultAgent.id]: [original] }, agentSteerInFlight: {} }))
 await vi.waitFor(() => expect(button('移至草稿')).toBeDefined())
 const checkpoint = desktopUserFragments.checkpoint.bind(desktopUserFragments)
 let releaseAck!: () => void
 const gate = new Promise<void>(done => { releaseAck = done })
 let failed = false
 vi.spyOn(desktopUserFragments, 'checkpoint').mockImplementation(async name => {
  if (name === 'launcher' && !failed) { failed = true; await gate; throw Error('Original draft ACK unavailable') }
  await checkpoint(name)
 })
 try {
 await moteClick(button('移至草稿'))
 const key = draftKey(), moved = 'Current Mote draft\n\nQueued original body'
 expect(useLauncherState.getState().drafts[key]?.prompt).toBe(moved)
 expect(useLauncherState.getState().drafts[key]?.queuedInputMoves?.[original.operationId]).toMatchObject({ text: original.text, sessionId: defaultAgent.id })
 expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]?.[0]?.archived).not.toBe(true)
 await moteType(editor(), moved + '\nLater edit B')
 await act(async () => releaseAck())
 await vi.waitFor(() => expect(app.panel().textContent).toContain('Original draft ACK unavailable'))
 expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]?.[0]?.archived).not.toBe(true)
 await moteClick(button('移至草稿'))
 await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[defaultAgent.id]?.[0]).toMatchObject({ archived: true, movedToDraft: true }))
 expect(useLauncherState.getState().drafts[key]?.prompt).toBe(moved + '\nLater edit B')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 expect(submit).not.toHaveBeenCalled()
 } finally { releaseAck() }
}, 30_000)


it('an attachment chosen before close cannot write into the later reopened Mote draft', async () => {
 await openReading(); await moteType(editor(), 'Before choosing'); await land()
 let finish!: (paths: string[]) => void
 const choose = vi.spyOn(api.ui, 'chooseFiles').mockImplementation(() => new Promise(resolve => { finish = resolve }))
 await moteClick(button('Show the message tool row'))
 const attach = app.panel().querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')!
 await moteClick(attach); await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce())
 await act(async () => requestPmoTeamsTopicFloatingClose({ restoreFocus: false }))
 await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[0]!.id }))
 await vi.waitFor(() => expect(editor()).not.toBeNull())
 await moteType(editor(), 'Later reopened draft B')
 await act(async () => finish([scratchWorkspace.path + '/selected.md']))
 await settleMoteApp()
 expect(useLauncherState.getState().drafts[draftKey()]?.prompt).toBe('Later reopened draft B')
 expect(editor().textContent).toBe('Later reopened draft B')
 expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Independent Session draft B')
 expect(submit).not.toHaveBeenCalled()
}, 30_000)


it('an explicit member Send keeps its direct manual producer and Session draft separate from the Mote', async () => {
 await openReading(); await moteType(editor(), 'Keep the logical Mote draft'); await land()
 const key = draftKey()
 await act(async () => requestAgentConversationFloatingOpen(defaultAgent.id, 'local'))
 await settleMoteApp()
 const direct = [...app.panel().querySelectorAll<HTMLElement>('[aria-label="Message Agent"]')].find(node => !node.closest('[hidden], [inert]'))!
 expect(direct).toBeDefined(); expect(direct.textContent).toBe('Independent Session draft B')
 await moteType(direct, 'Explicit member question')
 const send = [...app.panel().querySelectorAll<HTMLButtonElement>('[aria-label=Send]')].find(node => !node.closest('[hidden], [inert]'))!
 await moteClick(send)
 await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce())
 expect(submit.mock.calls[0]![1]).toBe('Explicit member question')
 expect(submit.mock.calls[0]![3]).toEqual({ expectedRun: defaultAgent.control.run, admissionIntent: { kind: 'manual-actor' } })
 expect(submit.mock.calls[0]![4]?.moteMain).toBeUndefined()
 expect(useLauncherState.getState().drafts[key]?.prompt).toBe('Keep the logical Mote draft')
}, 30_000)


it('actual App isolates composition and undo when the exact Mote owner changes, preserving both original drafts', async () => {
 await openReading(); await moteType(editor(), 'Original Mote A draft'); await land()
 const keyA = draftKey(), surface = editor().closest('.mote-composer-surface')
 const select = async (index: 0 | 1) => {
  await act(async () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: moteTopics[index]!.id }))
  await vi.waitFor(() => expect(app.panel().querySelector('[data-mote-workface]')?.getAttribute('data-mote-workface')).toBe(moteTopics[index]!.id))
  await settleMoteApp()
 }
 await select(1); await moteType(editor(), 'Original Mote B draft')
 const keyB = Object.keys(useLauncherState.getState().drafts).find(key => useLauncherState.getState().drafts[key]?.prompt === 'Original Mote B draft')!
 expect(keyB).toBeDefined(); expect(keyB).not.toBe(keyA)
 await select(0)
 const original = editor(), originalEditor = original.editor
 expect(original.textContent).toBe('Original Mote A draft')
 await act(async () => { originalEditor.commands.setTextSelection(originalEditor.state.doc.content.size - 1); originalEditor.commands.insertContent(' with A undo history') })
 expect(originalEditor.can().undo()).toBe(true)
 const textA = useLauncherState.getState().drafts[keyA]?.prompt
 await act(async () => original.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
 expect(originalEditor.view.composing).toBe(true)
 await select(1)
 const next = editor(), nextEditor = next.editor
 // This is the same surface in the actual App; only the editor's exact draft owner lifetime ends.
 expect(next.closest('.mote-composer-surface')).toBe(surface)
 expect(next.textContent).toBe('Original Mote B draft')
 expect(nextEditor.view.composing).toBe(false)
 expect(nextEditor.can().undo()).toBe(false)
 expect(next).not.toBe(original); expect(nextEditor).not.toBe(originalEditor); expect(originalEditor.isDestroyed).toBe(true)
 await act(async () => {
  original.textContent = 'Late A composition commit'
  original.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  original.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'Late A composition commit' }))
 })
 expect(useLauncherState.getState().drafts[keyA]?.prompt).toBe(textA)
 expect(useLauncherState.getState().drafts[keyB]?.prompt).toBe('Original Mote B draft')
 await act(async () => { nextEditor.commands.setTextSelection(nextEditor.state.doc.content.size - 1); nextEditor.commands.insertContent(' later B edit') })
 await act(async () => { expect(nextEditor.commands.undo()).toBe(true) })
 expect(next.textContent).toBe('Original Mote B draft')
 expect(useLauncherState.getState().drafts[keyA]?.prompt).toBe(textA)
 expect(useLauncherState.getState().drafts[keyB]?.prompt).toBe('Original Mote B draft')
 expect(submit).not.toHaveBeenCalled(); expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
}, 30_000)
