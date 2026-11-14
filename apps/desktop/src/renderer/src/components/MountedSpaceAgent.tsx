import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import type { SpaceMountMemberSurface, SpaceMountMemberTarget } from '../../../shared/space-mount'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { spaceMemberTerminalSource } from '../lib/space-member-terminal'
import { MountedSpaceComposer } from './MountedSpaceComposer'
import { TerminalView } from './TerminalView'

/** One exact member reader. Full Session facts stay here, never in the observer's Session map. */
export function MountedSpaceAgent({ target, visible, active, mountKey, tabId }: { target: SpaceMountMemberTarget; visible: boolean; active: boolean; mountKey: string; tabId: string }) {
  const key = JSON.stringify([target.hostId, target.target.reference.runtimeId, target.target.reference.spaceId, target.target.regionId,
    target.target.runtimeId, target.target.agentSessionId, target.target.expectedRun.runId])
  const currentKey = useRef(key); currentKey.current = key
  const [read, setRead] = useState<{ key: string; session?: SessionSnapshot; readIssue?: string | undefined; watchIssue?: string | undefined }>({ key })
  const [attempt, setAttempt] = useState(0)
  const [reader, setReader] = useState<{ key: string; surface: SpaceMountMemberSurface; source: ReturnType<typeof spaceMemberTerminalSource> }>()
  const listeners = useMemo(() => new Set<(event: RuntimeEvent) => void>(), [key])
  const subscribe = useMemo(() => (listener:(event:RuntimeEvent)=>void) => { listeners.add(listener); return () => { listeners.delete(listener) } },[listeners])
  const appearance = useAppStore(state => state.config?.appearance)
  const release = (surface: SpaceMountMemberSurface) => { void Promise.resolve(surface.dispose()).catch(cause => console.warn('[mounted-space] Member reader release unconfirmed', cause)) }
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let acquired: SpaceMountMemberSurface | undefined
    setReader(undefined)
    const issue = (cause: unknown, source: 'readIssue' | 'watchIssue' = 'readIssue') => { if (!controller.signal.aborted && currentKey.current === key)
      setRead(prior => ({ ...(prior.key === key ? prior : {}), key, [source]: cause instanceof Error ? cause.message : String(cause) })) }
    void api.spaceMounts.member(target, event => {
      if (controller.signal.aborted || currentKey.current !== key) return
      if (event.type === 'runtime') { for (const listener of [...listeners]) listener(event.event) }
      else if (event.type === 'observation-error') issue(event.error.message, 'watchIssue')
      else if (event.type === 'error') { issue(event.error.message, 'watchIssue'); setReader(undefined) }
      else if (event.session.kind === 'agent' && event.session.control.agentSessionId === target.target.agentSessionId && event.session.control.run.runId === target.target.expectedRun.runId) setRead({ key, session: event.session })
      else issue(new Error('The member observation belongs to another original Session or Run. Its reference is kept.'), 'watchIssue')
    }, controller.signal).then(surface => {
      if (controller.signal.aborted || currentKey.current !== key) { release(surface); return }
      acquired = surface
      const source = spaceMemberTerminalSource(surface, target.target, subscribe)
      setReader({ key, surface, source })
      // The original fixed read is independent of the optional general-event opening.
      void surface.call('read', {}).then(session => {
        if (controller.signal.aborted || currentKey.current !== key) return
        if (session.kind === 'agent' && session.id === surface.initial.id && session.hostId === surface.initial.hostId &&
            session.control.kind === 'agent' && session.control.hostId === surface.initial.hostId && session.control.agentSessionId === target.target.agentSessionId && session.control.run.runId === target.target.expectedRun.runId)
          // A fixed snapshot confirms this read, not the independent event stream.
          setRead(prior => ({ ...(prior.key === key ? prior : {}), key, session, readIssue: undefined }))
        else issue(new Error('The member observation belongs to another original Session or Run. Its reference is kept.'))
      }).catch(issue)
    }).catch(issue)
    return () => { controller.abort(); if (acquired) release(acquired) }
  }, [key, visible, listeners, attempt, subscribe])
  const observed = read.key === key ? read : undefined, original = reader?.key === key ? reader : undefined
  async function refresh() {
    if (!original) { setAttempt(value => value + 1); return }
    try {
      const session = await original.surface.call('read', {})
      if (currentKey.current === key && session.kind === 'agent' && session.control.agentSessionId === target.target.agentSessionId && session.control.run.runId === target.target.expectedRun.runId)
          // An explicit refresh leaves a separate watch failure intact.
          setRead(prior => ({ ...(prior.key === key ? prior : {}), key, session, readIssue: undefined }))
    } catch (cause) { if (currentKey.current === key) setRead(prior => ({ ...(prior.key === key ? prior : {}), key, readIssue: cause instanceof Error ? cause.message : String(cause) })) }
  }
  const hasIssue = observed?.watchIssue || observed?.readIssue
  return <div className="mounted-space-agent" aria-label="Original member workface">
    {hasIssue ? <p role="status" className="mounted-space-agent__issue">{observed?.watchIssue ? <>Updates unconfirmed: {observed.watchIssue} </> : null}{observed?.readIssue ? <>Session read unconfirmed: {observed.readIssue} </> : null}{observed?.session ? 'Last confirmed Session facts are kept.' : 'The original target and private draft are kept.'}
      <button type="button" className="small-button" onClick={() => void refresh()}>Refresh member observation</button></p> : null}
    {observed?.session && original ? <div className="mounted-space-agent__terminal"><TerminalView session={observed.session} sessionSource={original.source}
      themeId={appearance?.terminalTheme ?? 'graphite'} {...(appearance?.terminalFontSize === undefined ? {} : { fontSize: appearance.terminalFontSize })} interactiveResize visible={visible} autoFocus={active} /></div>
      : <p role="status">{hasIssue ? 'The original member observation is unconfirmed.' : 'Reading the original Agent and terminal…'}</p>}
    <MountedSpaceComposer target={target} {...(original?{surface:original.surface}:{})} subscribe={subscribe} {...(observed?.session?{session:observed.session}:{})} mountKey={mountKey} tabId={tabId} active={visible&&active} />
  </div>
}
