import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { useLauncherState } from '../lib/launcher-state'
import { useAppStore } from '../store'
import { handoffMoteTask } from '../lib/mote-task-handoff'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { MoteActionChooser } from './MoteActionChooser'

export type MoteTaskRecipient = { kind: 'mote'; topicId: string } | { kind: 'new-agent'; targetKey: string }
export type MoteTaskActionItem = {
  id: string; label: string; description?: string
  createTask(recipient: MoteTaskRecipient): Promise<string>
}
type NewAgentTarget = { key: string; label?: string; details?: ReactNode
  onTask(prompt: string, current: () => boolean): void | Promise<void>; onOpen?(prompt: string): void }
type TaskResult = { state: 'queued' | 'not-queued' | 'unconfirmed' | 'prepared'; prompt: string; detail?: string; draftSaved?: boolean }
type TaskProps = { scopeKey: string; active?: boolean; orientation?: 'horizontal' | 'vertical'
  newAgent?: NewAgentTarget; portalContainer?: HTMLElement | null } & (
  { actions: readonly MoteTaskActionItem[]; preview?: never; createTask?: never }
  | { actions?: never; preview: string; createTask(): Promise<string> })

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
  const open = (target: MoteTaskRecipient, prompt = '') => {
    if (target.kind === 'mote') requestPmoTeamsTopicFloatingOpen({ targetTopicId: target.topicId })
    else newAgent?.onOpen?.(prompt)
  }
  async function handoff(action: MoteTaskActionItem, invoker: HTMLElement) {
    if (inFlight.current) return
    const capturedRecipient = recipient, key = resultKey(action), original = results[key]
    if (original?.state === 'queued' || original?.state === 'unconfirmed' || original?.state === 'prepared' || original?.draftSaved) { open(capturedRecipient, original.prompt); return }
    const generation = lifetime.current.generation
    const current = () => live.current && lifetime.current.permitted && lifetime.current.key === ownerKey && lifetime.current.generation === generation
    const mayNavigate = () => current() && activeRef.current && root.current?.isConnected &&
      !root.current.closest('[hidden], [inert]') &&
      (document.activeElement === invoker || document.activeElement === document.body)
    inFlight.current = true; setBusy(true)
    let prompt = legacy ? input.preview! : '', rejected = false
    const remember = (value: TaskResult) => { if (live.current) setResults(previous => ({ ...previous, [key]: value })) }
    const create = async () => { prompt = await action.createTask(capturedRecipient); return prompt }
    try {
      if (capturedRecipient.kind === 'new-agent') {
        await create()
        if (!current()) return
        // The caller prepares the exact original Launcher; only its explicit submit starts an Agent.
        await newAgent!.onTask(prompt, current)
        remember({ state: 'prepared', prompt, detail: 'Task prepared in the original Launcher. Choose an Executor there to start an Agent.' })
        return
      }
      const topic = topics?.find(item => item.id === capturedRecipient.topicId)
      const rootPath = workspace && topic ? scratchTopicLogicalPath(workspace, topic) : null
      if (!workspace || !topic || rootPath === null) {
        remember({ state: 'not-queued', prompt, detail: 'Could not confirm this Mote. Task not sent; open it or refresh the Mote list.' })
        if (mayNavigate()) open(capturedRecipient)
        return
      }
      const reply = await handoffMoteTask({ workspace, topic, rootPath }, create, current, () => {
        rejected = true
        remember({ state: 'unconfirmed', prompt, detail: 'Delivery needs checking. Open Mote to review this task before sending another.' })
      })
      if (!live.current || reply.state === 'superseded') return
      remember(rejected && reply.state === 'queued' ? { state: 'unconfirmed', prompt: reply.prompt,
        detail: 'Delivery needs checking. Open Mote to review this task before sending another.' } : { ...reply, state: reply.state })
      if (mayNavigate()) open(capturedRecipient)
    } catch (cause) {
      remember({ state: capturedRecipient.kind === 'new-agent' ? 'unconfirmed' : 'not-queued', prompt,
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
      <span>{label}</span>{orientation !== 'vertical' && action.description ? <small>{action.description}</small> : null}
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
      {!legacy ? <details><summary>{action.label} · Task details</summary><pre>{original.prompt}</pre></details> : null}
    </div> : null })}
    {error ? <p role="status">Mote list could not be confirmed. Your saved choice is kept. <button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)}>Refresh Motes</button></p> : null}
    {legacy ? <details><summary>Task details</summary><pre>{results[resultKey(actions[0]!)]?.prompt ?? input.preview}</pre></details> : null}
  </div>
  // The original owner stays mounted when its Popover host goes away, retaining its receipts.
  return portalContainer === null ? null : portalContainer ? createPortal(content, portalContainer) : content
}
