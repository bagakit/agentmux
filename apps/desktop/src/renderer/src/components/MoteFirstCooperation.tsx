import { ComposerTextarea, InputGroup } from '@agentmux/client-ui/input'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FileReadResult } from '@agentmux/core'
import { prepareMoteCooperationDraft } from '../lib/mote-cooperation'
import { useLauncherState } from '../lib/launcher-state'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { MoteBehaviorAction } from './MoteBehaviorDialog'
import { isMacPlatform } from '../lib/host-platform'

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
    <InputGroup variant="prompt" aria-invalid={Boolean(issue)}>
      <ComposerTextarea aria-label="A question for this Mote" rows={1} value={question}
        placeholder="What’s on your mind?"
        onValueChange={value => useLauncherState.getState().setDraft(key, 'prompt', value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isImeOwnedKeyboardEvent(event)) {
            event.preventDefault(); void prepare()
          }
        }} />
      <MoteBehaviorAction label={pending ? 'Reading original materials' : 'Prepare this question in a new discussion'}
        disabled={pending || !question.trim()} busy={pending}
        onClick={() => void prepare()}>{pending ? <LoaderCircle size={14} className="spin" /> : <ArrowRight size={16} />}</MoteBehaviorAction>
    </InputGroup>
    <span className="mote-cooperation-entry__shortcut" aria-hidden="true">{isMacPlatform() ? '⌘' : 'Ctrl'} ↵</span>
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
