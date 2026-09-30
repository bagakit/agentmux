import { useEffect, useRef, useState } from 'react'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { scratchTopicsScope } from '../lib/scratch-topic-snapshots'
import { presentError } from '../lib/error-presentation'
import { useAppStore } from '../store'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'

/** Only request presentation is local; the original directory snapshot holds the facts. */
export function useMoteArchiveAction(workspace: WorkspaceRecord | undefined) {
  const [pending, setPending] = useState<string | null>(null), [issue, setIssue] = useState<string | null>(null)
  const scope = workspace ? scratchTopicsScope(workspace) : null
  const latest = useRef(scope); latest.current = scope
  const active = useRef(true), request = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { setIssue(null); setPending(null) }, [scope])
  async function change(topic: ScratchTopicSnapshot, archived: boolean) {
    if (!workspace || pending === topic.id) return false
    const captured = scope, generation = ++request.current
    setPending(topic.id); setIssue(null)
    try {
      if (!topic.moteArchive || topic.moteArchive.state === 'unknown') throw new Error('Refresh this Mote to confirm its archive state.')
      await useAppStore.getState().setMoteArchived(workspace.id, topic.id, archived, topicSpaceIconTarget(workspace, topic).key, topic.moteArchive.version)
      return true
    }
    catch (error) { if (active.current && latest.current === captured && request.current === generation) setIssue(presentError(error)); return false }
    finally { if (active.current && latest.current === captured && request.current === generation) setPending(null) }
  }
  return { pending, issue, change }
}

export function MoteArchiveNotice({ issue, workspaceId }: { issue: string | null | undefined; workspaceId: string }) {
  if (!issue) return null
  return <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
    step: 'Mote archive state is unconfirmed', mode: issue + ' The last confirmed state and original work surface are kept.',
    restore: 'Refresh the directory, then retry Archive or Restore for the same Mote.'
  } }} actions={<button type="button" className="small-button" onClick={() => void useAppStore.getState().refreshScratchTopics(workspaceId, true)}>Retry directory</button>} />
}
