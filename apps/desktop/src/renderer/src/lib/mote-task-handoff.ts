import { moteConnectionTarget } from './mote-connection-default'
import { moteEntryDraftKey } from './mote-entry-hold'
import type { MoteWorkfaceScope } from './mote-workface'
import { useLauncherState } from './launcher-state'
import { useAppStore } from '../store'
import { api } from './api'
import { prepareMoteTask, type MoteTaskPacket, type PreparedMoteTask } from './mote-task-packet'

export type MoteTaskHandoff = PreparedMoteTask & { state: 'queued' | 'not-queued' | 'superseded'; detail?: string; draftSaved?: boolean }

/** This is ordinary Main input; Core's role revision and the existing durable queue own delivery. */
export async function handoffMoteTask(scope: MoteWorkfaceScope, createTask: () => Promise<MoteTaskPacket>,
  current: () => boolean, onRejected: (cause: unknown) => void): Promise<MoteTaskHandoff> {
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)
  if (!target) throw new Error('Could not confirm the selected Mote. This task was not sent; open that Mote to check its setup.')
  const [value, page] = await Promise.all([createTask(), api.moteDialogue.read({ target, kind: 'main' })])
  const task = prepareMoteTask(value)
  if (!current()) return { state: 'superseded', ...task }
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (!workspace || workspace.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path ||
    JSON.stringify(moteConnectionTarget(scope, state.spaceZoneBindings)) !== JSON.stringify(target)) {
    throw new Error('The selected Mote changed while preparing this task. Nothing was sent; your drafts are kept. Open that Mote to check it.')
  }
  const reference = page.main.status === 'ready' ? page.main.current : null
  const sessions = reference ? state.sessions.filter(item => item.kind === 'agent' &&
    item.control.hostId === reference.hostId && item.control.agentSessionId === reference.sessionId) : []
  if (!reference || !page.main.roleRevision || sessions.length !== 1) {
    const key = moteEntryDraftKey(scope), drafts = useLauncherState.getState(), draft = drafts.drafts[key]
    const occupied = Boolean(draft?.prompt?.trim() || draft?.heldPrompt)
    const retained = !occupied && (task.focusTask ? drafts.setTaskDraft(key, { prompt: task.prompt, focusTask: task.focusTask }) : drafts.setDraft(key, 'prompt', task.prompt)) && !useLauncherState.getState().persistenceIssue
    return { state: 'not-queued', ...task, draftSaved: retained, detail: retained
      ? 'Task saved in this Mote’s draft. Open this Mote to start or recover its conversation.'
      : occupied ? 'Task not sent. This Mote’s existing draft is kept. Open Mote or copy the task below.'
        : 'Task not sent. Its draft save is unconfirmed. Keep the task below and open Mote to continue.' }
  }
  const queued = state.send(sessions[0]!.id, task.prompt, onRejected, 'manual', undefined,
    { moteMain: { target, expectedRoleRevision: page.main.roleRevision }, ...(task.focusTask ? { focusTask: task.focusTask } : {}) })
  if (!queued) throw new Error('This task could not be queued. Your drafts are kept; open Mote to check before retrying.')
  return { state: 'queued', ...task }
}
