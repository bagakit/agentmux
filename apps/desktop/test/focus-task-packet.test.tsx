// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { focusTaskHandoffNote } from '@agentmux/core/focus-task-guidance'
import { MOTE_INPUT_GUIDANCE } from '@agentmux/core/mote-input-source'
import type { MoteDialoguePage, MoteDialogueRead } from '@agentmux/core/mote-dialogue'
import { MoteTaskAction } from '../src/renderer/src/components/MoteTaskAction'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState, checkpointLauncherState } from '../src/renderer/src/lib/launcher-state'
import { moteEntryDraftKey } from '../src/renderer/src/lib/mote-entry-hold'
import { prepareMoteTask, moteTaskPacketKey } from '../src/renderer/src/lib/mote-task-packet'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { moteTopic, scratchWorkspace } from './fixtures/mote-workface'

const dom = composerDOM(), mote = { ...moteTopic(PMO_TEAMS_TOPIC_ID, 'Original Mote', true), kind: 'mote' as const }
const scope = { workspace: scratchWorkspace, topic: mote, rootPath: scratchTopicLogicalPath(scratchWorkspace, mote)! }
const reference = { hostId: 'local', sessionId: 'original-main', displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'main-group', tabId: 'main-tab', regionId: 'main-region' }
const focusTask = { scope: { kind: 'project' as const, hostId: 'local', projectSpaceId: folderSpaceFacts(composerConfig.workspaces[0]!).space.spaceId },
  selection: { kind: 'members' as const, references: [{ hostId: 'original-host', contextId: 'original-context' }] } }
function page(input: MoteDialogueRead, ready = true): MoteDialoguePage {
  return { main: { target: input.target, identity: null, status: 'ready', resource: null, documentRevision: 'doc-original', roleRevision: 'role-original', current: ready ? reference : null, issue: null },
    links: [], incarnation: null, throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
beforeEach(() => {
  installNoteCanvasGeometry()
  const main = composerSession('main-ui'); main.control.agentSessionId = reference.sessionId
  useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, scratchWorkspace] }, sessions: [main],
    agentSteerQueues: {}, spaceZoneBindings: {}, sendQueuedAgentSteer: vi.fn().mockResolvedValue(undefined),
    scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: JSON.stringify([scratchWorkspace.hostId, scratchWorkspace.path]), revision: 0, reading: false, error: null, topics: [mote] } } })
  useLauncherState.setState({ drafts: {}, moteTopicId: mote.id, persistenceIssue: null })
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => page(input))
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
})
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.firstElementChild?.textContent === label || node.textContent === label)
  expect(button, 'Original task action is visible').toBeDefined()
  await act(async () => { button!.focus(); button!.click() })
}
async function chooseNewAgent() {
  const chooser = document.querySelector('[aria-label^="Choose recipient:"]')!
  await act(async () => chooser.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('New Agent'))!
  expect(item).toBeDefined(); await act(async () => item.click())
}

it('the shared action queues human intent separately from its frozen exact Focus platform guidance', async () => {
  const original = structuredClone(focusTask)
  await dom.render(<MoteTaskAction scopeKey="group" orientation="vertical" actions={[{ id: 'inspect', label: 'Inspect', createTask: async () => ({ prompt: 'Review original work; ask before changing it.', focusTask: original }) }]} />)
  await click('Inspect')
  const entry = useAppStore.getState().agentSteerQueues['main-ui']![0]!
  expect(entry.text).toBe('Review original work; ask before changing it.')
  expect(entry.text).not.toContain('<amux>'); expect(entry.text).not.toContain('contextId')
  expect(entry.focusTask).toEqual(focusTask)
  expect(entry.agentMuxNote).toContain(focusTaskHandoffNote(focusTask))
  expect(entry.origin).toBe('manual'); expect(entry.goalDispatch).toBeUndefined()
  original.selection.references[0]!.contextId = 'later-context'
  expect(entry.focusTask).toEqual(focusTask)
  expect(document.querySelector('[data-focus-task-read-commands]')).toBeNull()
  const details = document.querySelector<HTMLDetailsElement>('.mote-task-action__result details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(document.querySelector('[data-focus-task-read-commands]')!.textContent).toContain('original-context')
  expect(document.querySelector('[data-focus-task-read-commands]')!.textContent).not.toContain('later-context')
})

it('an occupied unconfirmed-Main draft keeps its own text and exposes exact task recovery only on demand', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input, false))
  const key = moteEntryDraftKey(scope)
  useLauncherState.getState().setDraft(key, 'prompt', 'Keep the occupied original draft')
  await dom.render(<MoteTaskAction scopeKey="group" orientation="vertical" actions={[{ id: 'inspect', label: 'Inspect', createTask: async () => ({ prompt: 'Original consultation', focusTask }) }]} />)
  await click('Inspect')
  expect(useLauncherState.getState().drafts[key]!.prompt).toBe('Keep the occupied original draft')
  expect(document.querySelector('[data-focus-task-read-commands]')).toBeNull()
  const details = document.querySelector<HTMLDetailsElement>('.mote-task-action__result details')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  expect(details.textContent).toContain('Original consultation')
  expect(details.querySelector('[data-focus-task-read-commands]')!.textContent).toContain('original-context')
  expect(details.querySelector('[data-focus-task-read-commands]')!.textContent).toContain('focus read --input -')
  expect(useAppStore.getState().agentSteerQueues['main-ui']).toBeUndefined()
})

it('the original default string task still queues only its ordinary human prompt and Mote guidance', async () => {
  await dom.render(<MoteTaskAction scopeKey="legacy-main" preview="Original preview" createTask={async () => 'Original string consultation'} />)
  await click('Ask Mote to handle setup')
  const entry = useAppStore.getState().agentSteerQueues['main-ui']![0]!
  expect(entry.text).toBe('Original string consultation')
  expect(entry.focusTask).toBeUndefined(); expect(entry.agentMuxNote).toBe(MOTE_INPUT_GUIDANCE)
})

it('the unconfirmed-Main original draft retains its typed reference through real storage rehydration, hold and withdrawal', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async input => page(input, false))
  await dom.render(<MoteTaskAction scopeKey="group" orientation="vertical" actions={[{ id: 'inspect', label: 'Inspect', createTask: async () => ({ prompt: 'Original consultation', focusTask }) }]} />)
  await click('Inspect')
  const key = moteEntryDraftKey(scope)
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: 'Original consultation', focusTask })
  expect(useAppStore.getState().agentSteerQueues['main-ui']).toBeUndefined()
  await checkpointLauncherState()
  const persisted = localStorage.getItem('agentmux-launcher')!
  expect(persisted).toContain('original-context')
  useLauncherState.setState({ drafts: {} }); localStorage.setItem('agentmux-launcher', persisted)
  await useLauncherState.persist.rehydrate()
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: 'Original consultation', focusTask })
  useLauncherState.getState().holdPrompt(key, 'original-operation', 'original-holder')
  expect(useLauncherState.getState().drafts[key]!.heldPrompt).toMatchObject({ operationId: 'original-operation', prompt: 'Original consultation', focusTask })
  expect(useLauncherState.getState().drafts[key]!.focusTask).toBeUndefined()
  useLauncherState.getState().setDraft(key, 'prompt', 'Later user typing')
  useLauncherState.getState().settleHeldPrompt(key, 'original-operation', false)
  expect(useLauncherState.getState().drafts[key]).toMatchObject({ prompt: 'Original consultation\n\nLater user typing', focusTask })
  expect(useLauncherState.getState().setTaskDraft(key, { prompt: 'Other task', focusTask })).toBe(false)
})

it('New Agent receives and reopens the original complete packet while legacy strings keep their original callback shape', async () => {
  const onTask = vi.fn(), onOpen = vi.fn()
  await dom.render(<MoteTaskAction scopeKey="group" orientation="vertical" actions={[{ id: 'inspect', label: 'Inspect', createTask: async () => ({ prompt: 'Same consultation', focusTask }) }]}
    newAgent={{ key: 'project', onTask, onOpen }} />)
  await chooseNewAgent(); await click('Inspect')
  expect(onTask).toHaveBeenCalledWith('Same consultation', expect.any(Function), focusTask)
  await click('Inspect')
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('Same consultation', focusTask)
  expect(onTask).toHaveBeenCalledOnce()
  await dom.render(<MoteTaskAction scopeKey="legacy" orientation="vertical" actions={[{ id: 'legacy', label: 'Legacy', createTask: async () => 'Legacy consultation' }]}
    newAgent={{ key: 'legacy-project', onTask, onOpen }} />)
  await chooseNewAgent(); await click('Legacy')
  expect(onTask.mock.calls[1]).toHaveLength(2)
  expect(onTask.mock.calls[1]![0]).toBe('Legacy consultation')
})

it('a logical task keeps every qualified member beyond one read batch and complete packet keys distinguish equal bodies', () => {
  const original = { prompt: 'Same consultation', focusTask: { ...focusTask, selection: { kind: 'members' as const,
    references: Array.from({ length: 300 }, (_, index) => ({ hostId: 'original-host', contextId: 'original-context-' + index })) } } }
  const task = prepareMoteTask(original)
  expect(task.focusTask!.selection.kind).toBe('members')
  if (task.focusTask!.selection.kind !== 'members') throw Error('Expected exact member selection')
  expect(task.focusTask!.selection.references).toHaveLength(300)
  expect(moteTaskPacketKey(task.prompt, task.focusTask)).not.toBe(moteTaskPacketKey(task.prompt, focusTask))
  original.focusTask.selection.references.splice(0)
  expect(task.focusTask!.selection.references).toHaveLength(300)
})
