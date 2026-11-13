import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RandomAccessSource } from '@agentmux/editor-extensions/bytes'
import { WORKSPACE_FILE_SOURCE_CHUNK_BYTES, type WorkspaceFileSourceFailure, type WorkspaceFileSourceReadResult } from '../../../shared/workspace-file-source'
import { api } from './api'
import { useAppStore } from '../store'
import { useWorkspaceResourceKey, workspaceResourceKey } from './workspace-resource-key'

export type WorkspaceFileSourceBinding = { resource: { workspaceId: string; hostId: string; workspacePath: string }; current(): boolean }

const aborted = () => new DOMException('This original file read was cancelled.', 'AbortError')
function span(id: string, offset: number, length: number, lifetime: AbortSignal, signal?: AbortSignal): Promise<WorkspaceFileSourceReadResult> {
  return new Promise((resolve, reject) => {
    const readId = crypto.randomUUID()
    const signals = signal ? [lifetime, signal] : [lifetime]
    const cleanup = () => { for (const source of signals) source.removeEventListener('abort', cancel) }
    const cancel = () => {
      cleanup(); reject(aborted())
      void api.files.cancelSourceRead(id, readId).catch(() => {})
    }
    if (signals.some(source => source.aborted)) { reject(aborted()); return }
    for (const source of signals) source.addEventListener('abort', cancel, { once: true })
    void api.files.readSource(id, readId, offset, length).then(result => { cleanup(); resolve(result) }, error => { cleanup(); reject(error) })
  })
}

/** One original file source for one visible consumer. Host/path/generation never come from presentation text. */
export function useWorkspaceFileSource(workspaceId: string, path: string, enabled: boolean) {
  const resource = useWorkspaceResourceKey(workspaceId)
  const [attempt, setAttempt] = useState(0)
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  const owner = useMemo(() => ({ resource }), [resource, workspaceId, path, enabled, attempt])
  const [opened, setOpened] = useState<{ owner: typeof owner; id: string; source: RandomAccessSource; binding: WorkspaceFileSourceBinding | null } | null>(null)
  const [failed, setFailed] = useState<{ owner: typeof owner; failure: WorkspaceFileSourceFailure } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const lifetime = new AbortController()
    const originalResource = useAppStore.getState().config?.workspaces.find(item => item.id === workspaceId)
    let id: string | null = null
    const current = () => !lifetime.signal.aborted && workspaceResourceKey(workspaceId) === owner.resource
    const fail = (failure: WorkspaceFileSourceFailure) => { if (current()) setFailed({ owner, failure }) }
    void api.files.openSource(workspaceId, path).then(result => {
      if (result.status !== 'ready') { fail(result); return }
      id = result.id
      if (!current()) { void api.files.releaseSource(id).catch(() => {}); return }
      const source: RandomAccessSource = { size: result.size, async read(offset, length, signal) {
        if (!current() || signal?.aborted) throw aborted()
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new RangeError('A file read needs a nonnegative integer span.')
        const wanted = Math.min(length, Math.max(0, result.size - offset)), bytes = new Uint8Array(wanted)
        try {
          for (let at = 0; at < wanted;) {
            const count = Math.min(WORKSPACE_FILE_SOURCE_CHUNK_BYTES, wanted - at)
            const read = await span(result.id, offset + at, count, lifetime.signal, signal)
            if (!current() || signal?.aborted) throw aborted()
            if (read.status !== 'read') { fail(read); throw Object.assign(new Error(read.message), { code: read.code, sourceFailure: read }) }
            if (read.bytes.length !== count) throw new Error('The original file source returned an incomplete span.')
            bytes.set(read.bytes, at); at += count
          }
          return bytes
        } catch (error) {
          if (current() && !(error instanceof DOMException && error.name === 'AbortError') && !(typeof error === 'object' && error && 'sourceFailure' in error)) fail({ status: 'unavailable', code: 'WORKSPACE_FILE_SOURCE_READ_FAILED', message: error instanceof Error ? error.message : String(error) })
          throw error
        }
      } }
      const binding: WorkspaceFileSourceBinding | null = originalResource ? { resource: { workspaceId, hostId: originalResource.hostId, workspacePath: originalResource.path }, current } : null
      setOpened({ owner, id, source, binding })
    }).catch(error => fail({ status: 'unavailable', code: 'WORKSPACE_FILE_SOURCE_OPEN_FAILED', message: error instanceof Error ? error.message : String(error) }))
    return () => { lifetime.abort(); if (id) void api.files.releaseSource(id).catch(() => {}) }
  }, [owner, workspaceId, path, enabled])
  const active = enabled && opened?.owner === owner ? opened : null
  return { source: active?.source ?? null, id: active?.id ?? null, failure: enabled && failed?.owner === owner ? failed.failure : null, binding: active?.binding ?? null, reload }
}
