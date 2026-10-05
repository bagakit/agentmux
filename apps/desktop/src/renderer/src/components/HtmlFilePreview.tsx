import { useEffect, useMemo, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { useAppStore } from '../store'

const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')


function resourceKey(workspaceId: string): string {
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)
  return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
}

/** A visible current-buffer consumer. The page has no host bridge or same-origin privileges. */
export function HtmlFilePreview({ workspaceId, path, content }: { workspaceId: string; path: string; content: string }) {
  const resource = useAppStore(state => {
    const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
  })
  const remote = useAppStore(state => state.config?.workspaces.find(item => item.id === workspaceId)?.hostId !== 'local')
  const [attempt, setAttempt] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const owner = useMemo(() => ({ valid: true, resource }), [resource, workspaceId, path, content, attempt, epoch])
  const [ready, setReady] = useState<{ owner: typeof owner; id: string; url: string } | null>(null)
  const [failure, setFailure] = useState<{ owner: typeof owner; message: string } | null>(null)
  useEffect(() => {
    let cancelled = false, id: string | undefined, observed = owner.resource
    const release = (value: string) => { void api.files.releaseHtmlPreview(value).catch(error => useAppStore.getState().reportError(error)) }
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.config === previous.config) return
      const current = resourceKey(workspaceId)
      if (current === observed) return
      observed = current
      owner.valid = false
      setEpoch(value => value + 1)
    })
    void api.files.openHtmlPreview(workspaceId, path, content).then(value => {
      if (cancelled || !owner.valid || resourceKey(workspaceId) !== owner.resource) { release(value.id); return }
      id = value.id
      setReady({ owner, ...value })
    }).catch(error => {
      if (!cancelled && owner.valid) setFailure({ owner, message: presentError(error) })
    })
    return () => { cancelled = true; unsubscribe(); if (id) release(id) }
  }, [owner, workspaceId, path, content])
  if (owner.valid && failure?.owner === owner) return <div className="file-preview-state" role="alert">
    <strong>HTML preview could not load</strong><span>{failure.message}</span>
    <button className="small-button" aria-label="Retry preview" onClick={() => setAttempt(value => value + 1)}><ThemeActionRefreshIcon size={13} /> Retry preview</button>
  </div>
  if (!owner.valid || ready?.owner !== owner) return <div className="file-preview-state" role="status">Preparing HTML preview…</div>
  return <div className="file-html-preview">
    {remote ? <div className="file-html-preview__notice" role="status">Previewing current HTML. Relative files from this remote workspace are unavailable.</div> : null}
    <iframe title={`${path} preview`} src={ready.url} sandbox="allow-scripts" referrerPolicy="no-referrer" />
  </div>
}
