import { useEffect, useRef, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicsScope } from '../lib/scratch-topic-snapshots'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'

/** Only request presentation is local; the original directory snapshot holds the facts. */
export type MoteArchiveFailure = { topicId: string; title: string; action: 'Archive' | 'Restore'; message: string; scope: string | null }
export function useMoteArchiveAction(workspace: WorkspaceRecord | undefined) {
  const [pending, setPending] = useState<string | null>(null), [failure, setFailure] = useState<MoteArchiveFailure | null>(null)
  const scope = workspace ? scratchTopicsScope(workspace) : null
  const latest = useRef(scope); latest.current = scope
  const active = useRef(true), request = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setFailure(null); setPending(null) }, [scope])
  async function change(topic: ScratchTopicSnapshot, archived: boolean) {
    if (!workspace || pending === topic.id) return false
    const captured = scope, generation = ++request.current
    setPending(topic.id); setFailure(null)
    try {
      if (!topic.moteArchive || topic.moteArchive.state === 'unknown') throw new Error('Refresh this Mote to confirm its archive state.')
      await useAppStore.getState().setMoteArchived(workspace.id, topic.id, archived, topicSpaceIconTarget(workspace, topic).key, topic.moteArchive.version)
      return true
    }
    catch (error) { if (active.current && latest.current === captured && request.current === generation) setFailure({ topicId: topic.id, title: topic.title, action: archived ? 'Archive' : 'Restore', message: presentError(error), scope: captured }); return false }
    finally { if (active.current && latest.current === captured && request.current === generation) setPending(null) }
  }
  const currentFailure = failure?.scope === scope ? failure : null
  return { pending, issue: currentFailure?.message ?? null, failure: currentFailure, change }
}

export function MoteArchiveNotice({ issue, workspaceId, failure, targetName }: { issue: string | null | undefined; workspaceId: string; failure?: MoteArchiveFailure | null; targetName?: string | undefined }) {
  if (!issue) return null
  return <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: failure ? `${failure.action} for ${failure.title} was not confirmed` : `${targetName ?? 'Mote'} archive state is unconfirmed`,
    mode: issue + ' The last confirmed state and original work surface are kept.',
    restore: failure ? `Refresh the directory, then retry ${failure.action.toLowerCase()} for ${failure.title}. Your current Mote selection remains available.` : 'Refresh the directory, then retry Archive or Restore for the same Mote.'
  } }} actions={<button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(workspaceId, true)}>Retry directory</button>} />
}
