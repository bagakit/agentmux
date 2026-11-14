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
  catch { publish({ result: { state: 'blocked', code: 'IDENTITY_RECOVERY_UNCONFIRMED' }, restoring: false }) }
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
    const restored = result?.state === 'restored' && prior?.state !== 'restored'
    const foundOriginal = result?.state === 'unchanged' && prior != null && prior.state !== 'unchanged' && prior.state !== 'restored'
    if (active && (restored || foundOriginal)) onRestored?.()
  }, [active, result, onRestored])
  if (!active || result?.state !== 'needs-backup' && result?.state !== 'blocked') return { notice: null, restoring, refresh: observe }
  const blocked = result.state === 'blocked'
  const guidance = blocked ? 'The current identity records were kept. Check again if they have been restored.'
    : result.code === 'IDENTITY_BACKUP_UNVERIFIED' ? 'That file couldn’t confirm this Mac’s original identity. Choose another backup.'
      : 'AgentMux checked its local recovery points. You can import a backup if you already have one.'
  const notice: ServiceNoticeItem = {
    id: 'local-runtime-identity', cause: result.code,
    notice: { kind: 'indeterminate', notice: {
      step: 'Couldn’t verify this Mac’s identity',
      mode: blocked ? 'The background service needs an identity it can verify. Your saved work is still in place.'
        : 'The background service needs its original identity to reconnect. Your saved work is still in place.',
      restore: guidance
    } },
    detail: result.code,
    action: blocked ? { label: 'Check again', run: observe }
      : { label: restoring ? 'Importing…' : 'Import original backup…', run: () => { void choose() } }
  }
  return { notice, restoring, refresh: observe, canImport: !blocked }
}
