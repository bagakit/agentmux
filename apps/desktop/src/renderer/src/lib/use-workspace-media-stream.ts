import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { useAppStore } from '../store'
import type { MediaLease } from '../components/MediaPlayer'

type Failure = { status: string; message: string }

function resourceKey(workspaceId: string): string {
  const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)
  return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
}

/**
 * One playback lease for one visible File view. Hidden, retried, retargeted or unmounted views
 * release it, so a lease never outlives the view that asked for it and a URL is never reused.
 */
export function useWorkspaceMediaStream(workspaceId: string, path: string, enabled: boolean) {
  const resource = useAppStore(state => {
    const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
    return JSON.stringify([workspaceId, workspace?.hostId, workspace?.path])
  })
  const [attempt, setAttempt] = useState(0)
  const owner = useMemo(() => ({ resource }), [resource, workspaceId, path, enabled, attempt])
  const [lease, setLease] = useState<{ owner: typeof owner; value: MediaLease } | null>(null)
  const [failed, setFailed] = useState<{ owner: typeof owner; failure: Failure } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false, id: string | null = null
    const current = () => !cancelled && resourceKey(workspaceId) === owner.resource
    void api.files.openMediaStream(workspaceId, path).then(result => {
      if (result.status === 'ready') {
        id = result.id
        if (!current()) { void api.files.releaseMediaStream(result.id).catch(() => {}); return }
        setLease({ owner, value: { id: result.id, url: result.url, kind: result.kind, byteLength: result.byteLength } })
        return
      }
      if (!current()) return
      setFailed({ owner, failure: { status: result.status, message: 'message' in result ? result.message : 'This path is a directory, not a file.' } })
    }).catch(error => {
      if (current()) setFailed({ owner, failure: { status: 'unavailable', message: error instanceof Error ? error.message : String(error) } })
    })
    return () => { cancelled = true; if (id) void api.files.releaseMediaStream(id).catch(() => {}) }
  }, [owner, workspaceId, path, enabled])
  return {
    lease: enabled && lease?.owner === owner ? lease.value : null,
    failure: enabled && failed?.owner === owner ? failed.failure : null,
    reload: () => setAttempt(value => value + 1)
  }
}
