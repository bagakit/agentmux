import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { useAppStore } from '../store'

type PreviewResult = Awaited<ReturnType<typeof api.files.readPreview>>
export type ReadyFilePreview = Extract<PreviewResult, { status: 'ready' }>
type Failure = { status: string; message: string }

function resourceKey(workspaceId: string): string {
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)
  return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
}

/** Main owns file bytes. A read is admitted only by its original resource and lifecycle. */
export function useWorkspaceFilePreview(workspaceId: string, path: string, enabled = true) {
  const selectResource = useMemo(() => {
    let config: ReturnType<typeof useAppStore.getState>['config'] | undefined, key = ''
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (state.config !== config) {
        config = state.config
        const workspace = config?.workspaces.find(item => item.id === workspaceId)
        key = JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
      }
      return key
    }
  }, [workspaceId])
  const resource = useAppStore(selectResource)
  const [attempt, setAttempt] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const owner = useMemo(() => ({ valid: true, resource }), [resource, path, enabled, attempt, epoch])
  const [loaded, setLoaded] = useState<{ owner: typeof owner; result: ReadyFilePreview } | null>(null)
  const [failed, setFailed] = useState<{ owner: typeof owner; failure: Failure } | null>(null)
  useEffect(() => {
    setLoaded(null); setFailed(null)
    if (!enabled) return
    let cancelled = false, observed = owner.resource
    // Observe transitions, including A → B → A inside one React batch. Unrelated store updates are O(1).
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.config === previous.config) return
      const current = resourceKey(workspaceId)
      if (current === observed) return
      observed = current
      owner.valid = false
      setEpoch(value => value + 1)
    })
    const current = () => !cancelled && owner.valid && resourceKey(workspaceId) === owner.resource
    void api.files.readPreview(workspaceId, path).then(result => {
      if (!current()) return
      if (result.status === 'ready') setLoaded({ owner, result })
      else setFailed({ owner, failure: { status: result.status,
        message: 'message' in result ? result.message : 'This path is a directory, not a file.' } })
    }).catch(error => {
      if (current()) setFailed({ owner, failure: { status: 'unavailable', message: error instanceof Error ? error.message : String(error) } })
    })
    return () => { cancelled = true; unsubscribe() }
  }, [owner, workspaceId, path, enabled])
  return {
    preview: enabled && owner.valid && loaded?.owner === owner ? loaded.result : null,
    failure: enabled && owner.valid && failed?.owner === owner ? failed.failure : null,
    reload: () => setAttempt(value => value + 1)
  }
}

/** Revoke on hide, resource replacement and unmount; never relabel a previous Blob. */
export function usePreviewObjectUrl(preview: ReadyFilePreview | null): string | null {
  const [loaded, setLoaded] = useState<{ preview: ReadyFilePreview; url: string } | null>(null)
  useEffect(() => {
    setLoaded(null)
    if (!preview || preview.kind === 'pdf') return
    const url = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes).buffer], { type: preview.mimeType }))
    setLoaded({ preview, url })
    return () => URL.revokeObjectURL(url)
  }, [preview])
  return preview && loaded?.preview === preview ? loaded.url : null
}
