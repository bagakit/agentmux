import { ArrowRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FileReadResult } from '@agentmux/core'
import { prepareMoteCooperationDraft } from '../lib/mote-cooperation'
import { useLauncherState } from '../lib/launcher-state'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { ComposerTextarea } from './ComposerTextarea'
import { MoteBehaviorAction } from './MoteBehaviorDialog'

/** Optional real-question entry. Original Launcher owns the input and original Files own its sources. */
export function MoteFirstCooperation({ scope, reference }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined
}) {
  const key = 'mote-cooperation:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id,
    scope.workspace.path, scope.topic.id, scope.topic.directoryPath, scope.rootPath])
  const question = useLauncherState(state => state.drafts[key]?.prompt ?? '')
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const [pending, setPending] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const [sources, setSources] = useState<readonly { path: string; observation: FileReadResult }[]>([])
  const lifetime = useRef<object>({}), flight = useRef(false)
  const referenceKey = JSON.stringify(reference)
  useEffect(() => {
    lifetime.current = {}; flight.current = false; setPending(false); setIssue(null); setSources([])
    return () => { lifetime.current = {} }
  }, [key, referenceKey])

  async function prepare() {
    if (flight.current || !question.trim()) return
    const epoch = lifetime.current, draft = useLauncherState.getState().drafts[key]
    const stillCurrent = () => lifetime.current === epoch && useLauncherState.getState().drafts[key] === draft
    flight.current = true; setPending(true); setIssue(null)
    try {
      const result = await prepareMoteCooperationDraft(scope, reference, { question }, stillCurrent)
      if (stillCurrent()) setSources(result.sources)
    } catch (cause) { if (lifetime.current === epoch) setIssue(presentError(cause)) }
    finally { if (lifetime.current === epoch) { flight.current = false; setPending(false) } }
  }
  return <section className="mote-cooperation-entry" aria-label="Start working together">
    <div className="mote-cooperation-entry__question">
      <ComposerTextarea aria-label="A question for this Mote" rows={2} value={question}
        placeholder="What would you like to work on together?"
        onValueChange={value => useLauncherState.getState().setDraft(key, 'prompt', value)} />
      {question.trim() ? <MoteBehaviorAction label={pending ? 'Reading original materials' : 'Prepare this question in a new discussion'}
        onClick={() => void prepare()}><ArrowRight size={16} /></MoteBehaviorAction> : null}
    </div>
    {pending ? <p className="mote-details__hint" role="status">Reading the saved profile…</p> : null}
    {issue ? <p className="mote-details__issue" role="status">{issue}</p> : null}
    {persistenceIssue ? <p className="mote-details__issue" role="status">{persistenceIssue}</p> : null}
    {sources.length ? <details className="mote-cooperation-entry__sources"><summary>Materials brought into this question</summary>
      {sources.map(({ path, observation }) => <p key={path} className="mote-details__hint" title={observation.result.status === 'read' ? observation.result.document.revision : undefined}>
        {path.split('/').at(-1)} · {observation.result.status === 'read' ? 'Saved file read' : 'Unconfirmed'}
      </p>)}
    </details> : null}
  </section>
}
