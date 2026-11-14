import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { RecoveryGeneration } from '@agentmux/core'
import type { DesktopStorageRecoveryRead } from '../../../shared/storage-recovery'
import { api } from './api'
import { storageRecoveryNotice } from './storage-recovery-notice'
import { useLocalRuntimeRecovery } from './use-local-runtime-recovery'

/** Only caches exact owner observations for this mounted reader; no backup state or persistence owner. */
export function useStorageRecoveryNotice() {
  const { notice: identityRecovery, refresh: refreshIdentity } = useLocalRuntimeRecovery(!__AGENTMUX_WEB_PREVIEW__)
  const hasIdentityRecoveryNotice = Boolean(identityRecovery)
  const [read, setRead] = useState<DesktopStorageRecoveryRead | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastPoint = useRef<{ runtimeId: string; value: RecoveryGeneration } | null>(null)
  const mounted = useRef(false), observation = useRef(0)
  const accept = useCallback((value: DesktopStorageRecoveryRead, generation: number) => {
    if (!mounted.current || generation !== observation.current) return
    if (value.status.lastGeneration) lastPoint.current = { runtimeId: value.owner.runtimeId, value: value.status.lastGeneration }
    else if (lastPoint.current?.runtimeId !== value.owner.runtimeId) lastPoint.current = null
    setRead(value); setError(null)
  }, [])
  const check = useCallback(async () => {
    const generation = ++observation.current
    try { accept(await api.ui.readStorageRecovery(), generation) }
    catch (error) {
      if (mounted.current && generation === observation.current) {
        setError(presentError(error))
        refreshIdentity()
      }
    }
  }, [accept, refreshIdentity])
  useEffect(() => {
    if (__AGENTMUX_WEB_PREVIEW__ || hasIdentityRecoveryNotice) return
    mounted.current = true
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const observe = async () => { await check(); if (!stopped) timer = setTimeout(() => { void observe() }, 5_000) }
    void observe()
    return () => { stopped = true; mounted.current = false; ++observation.current; clearTimeout(timer) }
  }, [check, hasIdentityRecoveryNotice])
  const retry = useCallback(async () => {
    if (!read) { await check(); return }
    const generation = ++observation.current
    try { accept(await api.ui.createStorageBackup(read.owner), generation) }
    catch (error) { if (mounted.current && generation === observation.current) setError(presentError(error)) }
  }, [read, accept, check])
  const point = lastPoint.current?.value ?? null
  const backupNotice = useMemo(() => storageRecoveryNotice(read, point, error, () => { void retry() }, () => { void check() }), [read, point, error, retry, check])
  return identityRecovery ?? backupNotice
}
