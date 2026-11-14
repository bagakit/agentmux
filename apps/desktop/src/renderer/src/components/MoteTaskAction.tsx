import { useEffect, useRef, useState } from 'react'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { useScratchTopics } from '../hooks/useScratchTopics'
import { scratchMoteTopics } from '../lib/scratch-topic-snapshots'
import { useLauncherState } from '../lib/launcher-state'
import { useAppStore } from '../store'
import { handoffMoteTask } from '../lib/mote-task-handoff'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { MoteActionChooser } from './MoteActionChooser'

/** A task handoff shares the original chooser and Main queue, without launching an Agent. */
export function MoteTaskAction({ preview, createTask, scopeKey, active = true }: {
  preview: string; createTask(): Promise<string>; scopeKey: string; active?: boolean
}) {
  const topicId = useLauncherState(state => state.moteTopicId ?? PMO_TEAMS_TOPIC_ID)
  const selectMote = useLauncherState(state => state.selectMote)
  const { topics, error } = useScratchTopics(SCRATCH_WORKSPACE_ID, active)
  const motes = scratchMoteTopics(topics)
  const workspace = useAppStore(state => state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID))
  const [result, setResult] = useState<{ key: string; state: 'queued' | 'not-queued' | 'unconfirmed'; prompt: string; detail?: string; draftSaved?: boolean }>()
  const [busy, setBusy] = useState(false), inFlight = useRef(false)
  const key = JSON.stringify([scopeKey, topicId]), latest = useRef(key); latest.current = key
  const root = useRef<HTMLDivElement>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const original = result?.key === key ? result : undefined
  const open = () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId })
  async function handoff(invoker: HTMLElement) {
    if (inFlight.current) return
    if (original?.state === 'queued' || original?.state === 'unconfirmed' || original?.draftSaved) { open(); return }
    const topic = topics?.find(item => item.id === topicId)
    const rootPath = workspace && topic ? scratchTopicLogicalPath(workspace, topic) : null
    if (!workspace || !topic || rootPath === null) {
      setResult({ key, state: 'not-queued', prompt: preview, detail: 'Could not confirm this Mote. Task not sent; open it or refresh the Mote list.' })
      open(); return
    }
    const current = () => live.current && latest.current === key
    const mayNavigate = () => current() && root.current?.isConnected &&
      !root.current.closest('[hidden], [inert]') &&
      (document.activeElement === invoker || document.activeElement === document.body)
    inFlight.current = true; setBusy(true)
    let rejected = false
    try {
      const reply = await handoffMoteTask({ workspace, topic, rootPath }, createTask, current, () => {
        rejected = true
        if (current()) setResult(value => ({ key, state: 'unconfirmed', prompt: value?.key === key ? value.prompt : preview,
          detail: 'Delivery needs checking. Open Mote to review this task before sending another.' }))
      })
      if (!current() || reply.state === 'superseded') return
      setResult(rejected && reply.state === 'queued' ? { key, state: 'unconfirmed', prompt: reply.prompt,
        detail: 'Delivery needs checking. Open Mote to review this task before sending another.' } : { key, ...reply, state: reply.state }); if (mayNavigate()) open()
    } catch (cause) {
      if (current()) setResult({ key, state: 'not-queued', prompt: preview,
        detail: cause instanceof Error ? cause.message : 'This task was not confirmed. Your settings and original Mote drafts are kept.' })
    } finally {
      inFlight.current = false; if (live.current) setBusy(false)
    }
  }
  return <div ref={root} className="mote-task-action" data-mote-task-action>
    <div className="launcher-mote__actions"><button type="button" className="launcher-mote__create" disabled={busy} onClick={event => void handoff(event.currentTarget)}>
      {busy ? 'Preparing task…' : original?.state === 'queued' ? 'Open queued task' : original?.state === 'unconfirmed' ? 'Check original task' : original?.draftSaved ? 'Open task draft' : 'Ask Mote to handle setup'}
    </button><MoteActionChooser active={active} motes={motes} topicId={topicId} pending={busy} onSelect={selectMote} /></div>
    {original ? <p role="status">{original.state === 'queued' ? 'Task queued. Open Mote to follow up.' : original.detail}</p> : null}
    {original?.state === 'not-queued' && !original.draftSaved ? <button type="button" className="small-button" onClick={open}>Open selected Mote</button> : null}
    {error ? <p role="status">Mote list could not be confirmed. Your saved choice is kept. <button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)}>Refresh Motes</button></p> : null}
    <details><summary>Task details</summary><pre>{original?.prompt ?? preview}</pre></details>
  </div>
}
