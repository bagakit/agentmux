import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { SemanticIdentityRecoveryResult } from '@agentmux/core'
import { api } from './api'
import type { ServiceNoticeItem } from './use-service-notices'

type Snapshot = { result: SemanticIdentityRecoveryResult | null; restoring: boolean }
let snapshot: Snapshot = { result: null, restoring: false }
let reading: Promise<void> | undefined
const listeners = new Set<() => void>()
const readSnapshot = () => snapshot
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const publish = (value: Snapshot) => {
  snapshot = value
  for (const listener of listeners) listener()
}

function observe() {
  if (reading || snapshot.restoring) return
  const observed = snapshot
  reading = api.ui.readLocalRuntimeRecovery().then(
    result => { if (snapshot === observed) publish({ result, restoring: false }) },
    () => {}
  ).finally(() => { reading = undefined })
}

async function choose() {
  if (snapshot.restoring) return
  publish({ ...snapshot, restoring: true })
  try { publish({ result: await api.ui.restoreLocalRuntimeIdentity(), restoring: false }) }
  catch { publish({ result: { state: 'needs-backup', code: 'IDENTITY_RECOVERY_UNCONFIRMED' }, restoring: false }) }
}

export function useLocalRuntimeRecovery(active: boolean, onRestored?: () => void) {
  const { result, restoring } = useSyncExternalStore(subscribe, readSnapshot)
  const previous = useRef(result)
  useEffect(() => { if (active) observe() }, [active])
  useEffect(() => {
    if (!active || result?.state !== 'deferred') return
    const retry = setTimeout(observe, 750)
    return () => clearTimeout(retry)
  }, [active, result?.state])
  useEffect(() => {
    const prior = previous.current
    previous.current = result
    if (active && prior?.state === 'needs-backup' && (result?.state === 'restored' || result?.state === 'unchanged')) onRestored?.()
  }, [active, result, onRestored])
  if (!active || result?.state !== 'needs-backup') return { notice: null, restoring }
  const guidance = result.code === 'IDENTITY_BACKUP_UNVERIFIED'
    ? 'That file couldn’t confirm this Mac’s original identity. Choose another backup.'
    : result.code === 'RUNTIME_OWNER_BUSY'
      ? 'The background service is still active. Try again in a moment.'
      : 'Choose a backup of this Mac’s original Runtime identity.'
  const notice: ServiceNoticeItem = {
    id: 'local-runtime-identity', cause: result.code,
    notice: { kind: 'indeterminate', notice: {
      step: 'Restore this Mac’s identity',
      mode: 'The background service needs its original identity to reconnect. Your saved work is still in place.',
      restore: guidance
    } },
    detail: result.code,
    action: { label: restoring ? 'Restoring…' : 'Restore from backup…', run: () => { void choose() } }
  }
  return { notice, restoring }
}
