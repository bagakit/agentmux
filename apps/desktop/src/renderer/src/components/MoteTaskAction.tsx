import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { focusReadCommand, focusTaskReadInputs } from '@agentmux/core/focus-task-guidance'
import { createPortal } from 'react-dom'
import { SemanticIcon, type SemanticIconId } from '@agentmux/client-ui/icons'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { useLauncherState } from '../lib/launcher-state'
import { useAppStore } from '../store'
import { handoffMoteTask } from '../lib/mote-task-handoff'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { MoteActionChooser } from './MoteActionChooser'
import { prepareMoteTask, type MoteTaskPacket, type PreparedMoteTask } from '../lib/mote-task-packet'

export type MoteTaskRecipient = { kind: 'mote'; topicId: string } | { kind: 'new-agent'; targetKey: string }
export type MoteTaskActionItem = {
  id: string; label: string; description?: string; icon?: SemanticIconId
  createTask(recipient: MoteTaskRecipient): Promise<MoteTaskPacket>
}
type NewAgentTarget = { key: string; label?: string; details?: ReactNode
  onTask(prompt: string, current: () => boolean, focusTask?: PreparedMoteTask['focusTask']): void | Promise<void>
  onOpen?(prompt: string, focusTask?: PreparedMoteTask['focusTask']): void }
type TaskResult = PreparedMoteTask & { state: 'queued' | 'not-queued' | 'unconfirmed' | 'prepared'; detail?: string; draftSaved?: boolean }
type TaskProps = { scopeKey: string; active?: boolean; orientation?: 'horizontal' | 'vertical'
  newAgent?: NewAgentTarget; portalContainer?: HTMLElement | null } & (
  { actions: readonly MoteTaskActionItem[]; preview?: never; createTask?: never }
  | { actions?: never; preview: string; createTask(): Promise<string> })

function RetainedTaskDetails({ task, label }: { task: PreparedMoteTask; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const commands = useMemo(() => expanded && task.focusTask ? focusTaskReadInputs(task.focusTask).map(focusReadCommand).join('\n') : null, [expanded, task.focusTask])
  return <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>{label} · Task details</summary><pre>{task.prompt}</pre>
    {commands ? <><p>Read the original Focus selection:</p><pre data-focus-task-read-commands>{commands}</pre></> : null}
  </details>
}

/** One chooser and handoff owner; changing presentation never changes Main input ownership. */
export function MoteTaskAction({ scopeKey, active = true, orientation = 'horizontal', newAgent, portalContainer, ...input }: TaskProps) {
  const topicId = useLauncherState(state => state.moteTopicId ?? PMO_TEAMS_TOPIC_ID)
  const selectMote = useLauncherState(state => state.selectMote)
  const { topics, error } = useScratchTopics(SCRATCH_WORKSPACE_ID, active)
  const motes = scratchMoteTopics(topics)
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const legacy = input.actions === undefined
  // New-Agent choice belongs only to this discussion; the saved Mote choice stays intact.
  const [agentChoice, setAgentChoice] = useState<string | null>(null)
  const agentKey = newAgent ? scopeKey : null
  const recipient: MoteTaskRecipient = newAgent && agentChoice === agentKey
    ? { kind: 'new-agent', targetKey: newAgent.key } : { kind: 'mote', topicId }
  const ownerKey = JSON.stringify([scopeKey, workspace?.id, workspace?.hostId, workspace?.path, recipient])
  // Existing inline help may finish its authorized handoff while hidden. A detached menu
  // has no current submission intent; already admitted queue receipts are still retained.
  const permitted = portalContainer === undefined && legacy || active && portalContainer !== null
  const lifetime = useRef({ key: ownerKey, permitted, generation: 0 })
  if (lifetime.current.key !== ownerKey || lifetime.current.permitted !== permitted) lifetime.current = { key: ownerKey, permitted, generation: lifetime.current.generation + 1 }
  const [results, setResults] = useState<Record<string, TaskResult>>({})
  const [busy, setBusy] = useState(false), inFlight = useRef(false)
  const root = useRef<HTMLDivElement>(null), live = useRef(true)
  const activeRef = useRef(active); activeRef.current = active
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const actions: readonly MoteTaskActionItem[] = input.actions ?? [{ id: 'task', label: 'Ask Mote to handle setup', createTask: input.createTask! }]
  const resultKey = (action: MoteTaskActionItem) => JSON.stringify([ownerKey, action.id])
  const open = (target: MoteTaskRecipient, task: PreparedMoteTask = { prompt: '' }) => {
    if (target.kind === 'mote') requestPmoTeamsTopicFloatingOpen({ targetTopicId: target.topicId })
    else if (task.focusTask) newAgent?.onOpen?.(task.prompt, task.focusTask)
    else newAgent?.onOpen?.(task.prompt)
  }
  async function handoff(action: MoteTaskActionItem, invoker: HTMLElement) {
    if (inFlight.current) return
    const capturedRecipient = recipient, key = resultKey(action), original = results[key]
    if (original?.state === 'queued' || original?.state === 'unconfirmed' || original?.state === 'prepared' || original?.draftSaved) { open(capturedRecipient, original); return }
    const generation = lifetime.current.generation
    const current = () => live.current && lifetime.current.permitted && lifetime.current.key === ownerKey && lifetime.current.generation === generation
    const mayNavigate = () => current() && activeRef.current && root.current?.isConnected &&
      !root.current.closest('[hidden], [inert]') &&
      (document.activeElement === invoker || document.activeElement === document.body)
    inFlight.current = true; setBusy(true)
    let task: PreparedMoteTask = { prompt: legacy ? input.preview! : '' }, rejected = false
    const remember = (value: TaskResult) => { if (live.current) setResults(previous => ({ ...previous, [key]: value })) }
    const create = async () => { task = prepareMoteTask(await action.createTask(capturedRecipient)); return task.focusTask ? { prompt: task.prompt, focusTask: task.focusTask } : task.prompt }
    try {
      if (capturedRecipient.kind === 'new-agent') {
        await create()
        if (!current()) return
        // The caller prepares the exact original Launcher; only its explicit submit starts an Agent.
        if (task.focusTask) await newAgent!.onTask(task.prompt, current, task.focusTask)
        else await newAgent!.onTask(task.prompt, current)
        remember({ state: 'prepared', ...task, detail: 'Task prepared in the original Launcher. Choose an Executor there to start an Agent.' })
        return
      }
      const topic = topics?.find(item => item.id === capturedRecipient.topicId)
      const rootPath = workspace && topic ? scratchTopicLogicalPath(workspace, topic) : null
      if (!workspace || !topic || rootPath === null) {
        remember({ state: 'not-queued', ...task, detail: 'Could not confirm this Mote. Task not sent; open it or refresh the Mote list.' })
        if (mayNavigate()) open(capturedRecipient)
        return
      }
      const reply = await handoffMoteTask({ workspace, topic, rootPath }, create, current, () => {
        rejected = true
        remember({ state: 'unconfirmed', ...task, detail: 'Delivery needs checking. Open Mote to review this task before sending another.' })
      })
      if (!live.current || reply.state === 'superseded') return
      remember(rejected && reply.state === 'queued' ? { state: 'unconfirmed', ...task,
        detail: 'Delivery needs checking. Open Mote to review this task before sending another.' } : { ...reply, state: reply.state })
      if (mayNavigate()) open(capturedRecipient)
    } catch (cause) {
      remember({ state: capturedRecipient.kind === 'new-agent' ? 'unconfirmed' : 'not-queued', ...task,
        detail: cause instanceof Error ? cause.message : 'This task was not confirmed. Your settings and original drafts are kept.' })
    } finally {
      inFlight.current = false; if (live.current) setBusy(false)
    }
  }
  const chooser = <MoteActionChooser active={active} motes={motes} topicId={topicId} pending={busy} {...(portalContainer ? { menuContainer: portalContainer } : {})}
    onSelect={id => { setAgentChoice(null); selectMote(id) }} newAgent={newAgent ? { kind: 'new-agent', key: newAgent.key,
      ...(newAgent.label !== undefined ? { label: newAgent.label } : {}), selected: recipient.kind === 'new-agent', onSelect: () => setAgentChoice(agentKey) } : undefined} />
  function actionButton(action: MoteTaskActionItem) {
    const original = results[resultKey(action)]
    const retainedAgent = recipient.kind === 'new-agent' && original && original.state !== 'not-queued'
    const label = legacy ? busy ? 'Preparing task…' : original?.state === 'queued' ? 'Open queued task'
      : original?.state === 'unconfirmed' ? 'Check original task' : original?.draftSaved ? 'Open task draft' : action.label : action.label
    return <button type="button" key={action.id} className={orientation === 'vertical' ? 'tab-context-menu__item mote-task-action__button' : 'launcher-mote__create'} title={action.description} aria-description={action.description} data-mote-task-action-id={action.id}
      disabled={busy || Boolean(retainedAgent && !newAgent?.onOpen)} onClick={event => void handoff(action, event.currentTarget)}>
      {orientation === 'vertical' && action.icon ? <SemanticIcon name={action.icon} size={13} /> : null}<span>{label}</span>{orientation !== 'vertical' && action.description ? <small>{action.description}</small> : null}
    </button>
  }
  const content = <div ref={root} className={`mote-task-action mote-task-action--${orientation}`} data-mote-task-action aria-busy={busy || undefined}>
    {orientation === 'vertical' ? <><div className="mote-task-action__recipient"><span>Talk with</span>{chooser}</div>
      {recipient.kind === 'new-agent' ? newAgent?.details : null}<div className="launcher-mote__actions">{actions.map(actionButton)}</div></>
      : <div className="launcher-mote__actions">{actions.map(actionButton)}{chooser}</div>}
    {!legacy && busy ? <p role="status">Preparing task…</p> : null}
    {actions.map(action => { const original = results[resultKey(action)]; return original ? <div className="mote-task-action__result" key={action.id}>
      <p role="status">{original.state === 'queued' ? 'Task queued. Open Mote to follow up.' : original.detail}</p>
      {original.state === 'not-queued' && !original.draftSaved ? <button type="button" className="small-button" onClick={() => open(recipient)}>Open selected Mote</button> : null}
      {!legacy ? <RetainedTaskDetails task={original} label={action.label} /> : null}
    </div> : null })}
    {error ? <p role="status">Mote list could not be confirmed. Your saved choice is kept. <button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)}>Refresh Motes</button></p> : null}
    {legacy ? <details><summary>Task details</summary><pre>{results[resultKey(actions[0]!)]?.prompt ?? input.preview}</pre></details> : null}
  </div>
  // The original owner stays mounted when its Popover host goes away, retaining its receipts.
  return portalContainer === null ? null : portalContainer ? createPortal(content, portalContainer) : content
}
