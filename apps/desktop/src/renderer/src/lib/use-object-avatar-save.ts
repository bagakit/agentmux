import { useLayoutEffect, useRef, useState } from 'react'
import { avatarSavedReceiptMatches, type SpaceObjectAvatarRead, type SpaceObjectAvatarSave } from '@agentmux/core/object-avatar'
import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
import { mintObjectId } from '@agentmux/core/object-id'
import type { SpaceObjectImageTarget } from '@agentmux/core/object-avatar'
import type { ObjectAvatarAssetRequest } from '../../../shared/object-avatar-request'
import { objectAvatarRequestKey } from '../../../shared/object-avatar-request'
import { api } from './api'
import { presentError } from '@agentmux/client-ui/error-presentation'

type Pending = { request: ObjectAvatarAssetRequest; issue: string }
function matches(request: ObjectAvatarAssetRequest, value: SpaceObjectAvatarRead): boolean {
  return avatarSeriesCanonical(value.target) === avatarSeriesCanonical(request.target) && avatarSavedReceiptMatches(request, value.operation, value.readerIdentity)
}
/** Submitted PNG requests only. Publication facts remain at the native avatar owner. */
export function useObjectAvatarSave(target: SpaceObjectImageTarget | undefined) {
  const [baseline, setBaseline] = useState<SpaceObjectAvatarRead | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [issue, setIssue] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [needsNewIntent, setNeedsNewIntent] = useState(false)
  const epoch = useRef<object>({}), sequence = useRef<object>({}), freshIntent = useRef(false)
  // These are retained submitted requests, never publication facts. A missing
  // custody observation cannot erase a request already known by this editor.
  const keptRequests = useRef(new Map<string, Map<string, ObjectAvatarAssetRequest>>())
  const requestsFor = (key: string) => {
    let requests = keptRequests.current.get(key)
    if (!requests) { requests = new Map(); keptRequests.current.set(key, requests) }
    return requests
  }
  const identity = target ? objectAvatarRequestKey(target) : null
  const currentTarget = useRef(identity); currentTarget.current = identity
  async function read(preserveIssue = false): Promise<void> {
    if (!target) return
    const original = structuredClone(target), key = objectAvatarRequestKey(original), session = epoch.current, request = {}; sequence.current = request
    const current = () => epoch.current === session && sequence.current === request && currentTarget.current === key
    setReading(true)
    try {
      const value = await api.objectAvatars.call('space.object.avatar.read', { target: original })
      if (!current()) return
      setBaseline(value)
      const records = await api.ui.readObjectAvatarRequests(original), unresolved: Pending[] = [], requests = requestsFor(key)
      for (const record of records) {
        const previous = requests.get(record.request.operationId)
        if (previous && avatarSeriesCanonical(previous) !== avatarSeriesCanonical(record.request)) throw new Error('This custody observation conflicts with the original kept request. Its bytes and draft are retained.')
        requests.set(record.request.operationId, record.request)
      }
      for (const kept of [...requests.values()]) {
        try {
          const observed = await api.objectAvatars.call('space.object.avatar.read', { target: original, operationId: kept.operationId })
          if (observed.operation?.phase === 'published' && observed.operation.durability === 'confirmed' && await matches(kept, observed)) {
            await api.ui.retireObjectAvatarRequest(kept)
            requests.delete(kept.operationId)
          } else unresolved.push({ request: kept, issue: observed.operation?.phase === 'published' && observed.operation.durability === 'confirmed' ? 'This historical publication does not confirm this submission’s original actor and bytes. The kept request is retained.' : observed.operation?.issue ?? 'The original save is still unconfirmed. Reading current values does not confirm that save.' })
        } catch (error) { unresolved.push({ request: kept, issue: presentError(error) }) }
      }
      if (current()) {
        setPending(unresolved)
        if (!unresolved.length) setNeedsNewIntent(false)
        else if (!freshIntent.current) setNeedsNewIntent(true)
        setIssue(previous => value.issues.join('\n') || (preserveIssue ? previous : null))
      }
    } catch (error) { if (current()) setIssue(presentError(error)) }
    finally { if (current()) setReading(false) }
  }
  useLayoutEffect(() => {
    epoch.current = {}; sequence.current = {}; freshIntent.current = false; setBaseline(null); setPending([]); setIssue(null); setReading(false); setNeedsNewIntent(false)
    if (target) void read()
    return () => { epoch.current = {}; sequence.current = {} }
  }, [identity])
  async function save(choice: string | null | { kind: 'png'; dataUrl: string }): Promise<boolean> {
    if (!target || !baseline || needsNewIntent) return false
    const session = epoch.current, key = objectAvatarRequestKey(target)
    const current = () => epoch.current === session && currentTarget.current === key
    const request: SpaceObjectAvatarSave = typeof choice === 'object' && choice !== null
      ? { target: structuredClone(target), beforeRevision: baseline.revision, operationId: mintObjectId(), choice: structuredClone(choice) }
      : { target: structuredClone(target), beforeRevision: baseline.revision, choice }
    freshIntent.current = false
    let sent = false
    try {
      if (request.operationId) { await api.ui.keepObjectAvatarRequest(request as ObjectAvatarAssetRequest); requestsFor(key).set(request.operationId, request as ObjectAvatarAssetRequest) }
      sent = true
      const result = await api.objectAvatars.call('space.object.avatar.save', request)
      if (result.mode === 'asset-publication' && result.state === 'saved' && !await matches(request as ObjectAvatarAssetRequest, result.current)) throw new Error('This receipt belongs to another original request. The kept bytes remain available for inspection.')
      if (request.operationId && result.state !== 'unknown') { await api.ui.retireObjectAvatarRequest(request as ObjectAvatarAssetRequest); requestsFor(key).delete(request.operationId) }
      if (!current()) return false
      setBaseline(result.current)
      if (result.state !== 'saved') { if (request.operationId && result.state === 'unknown') setNeedsNewIntent(true); setIssue(result.issue ?? 'This save is unconfirmed. Read the current choice before deciding a new save.'); await read(true); return false }
      setIssue(null)
      return true
    } catch (error) {
      if (current()) { if (sent && request.operationId) setNeedsNewIntent(true); setIssue((sent ? 'Save unconfirmed. ' : 'Save not sent. ') + presentError(error)); if (sent) await read(true) }
      return false
    }
  }
  return { baseline, pending, issue, reading, needsNewIntent, beginNewIntent: () => { freshIntent.current = true; setNeedsNewIntent(false) }, read, save }
}
