import { useEffect, useRef, useState } from 'react'
import { parseHostRouteConfiguration, type HostRouteParams, type HostRouteSettings } from '@agentmux/core/host-route'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { DesktopHostRouteTarget } from '../../../../shared/host-routes'
import { api } from '../../lib/api'
import { acknowledgeHostRouteSave, hostRouteDraft, hostRouteSaveRefusal, putHostRouteDraft, readHostRouteDraft, type HostRouteDraft } from '../../lib/host-route-draft'
import { checkpointHostRouteDrafts, useAppStore } from '../../store'

/** One policy owner and its private edit. There is no automatic write or retry. */
export function useHostRoutePolicy(target: DesktopHostRouteTarget & { expectedRuntimeId: string }, active: boolean) {
  const raw = useAppStore(state => state.hostRouteDrafts)
  const [observed, setObserved] = useState<HostRouteSettings>(), [issue, setIssue] = useState(''), [busy, setBusy] = useState(false)
  const reader = useRef<AbortController | undefined>(undefined), epoch = useRef(0), producer = useRef(false), mounted = useRef(true)
  let retained: HostRouteDraft | undefined, draftIssue = ''
  try { retained = readHostRouteDraft(raw, target.expectedRuntimeId) } catch (cause) { draftIssue = presentError(cause) }
  const edit = retained ?? (observed ? hostRouteDraft(observed) : undefined)
  function change(update: (current: HostRouteDraft) => HostRouteDraft) {
    const current = readHostRouteDraft(useAppStore.getState().hostRouteDrafts, target.expectedRuntimeId) ?? (observed ? hostRouteDraft(observed) : undefined)
    if (!current) throw Error('Read this original route policy before editing it.')
    useAppStore.setState(state => ({ hostRouteDrafts: putHostRouteDraft(state.hostRouteDrafts, target.expectedRuntimeId, update(current)) }))
  }
  async function inspect() {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    const token = ++epoch.current; setIssue('')
    try {
      const next = await api.hostRoutes.call(target, 'route.inspect', {}, controller.signal)
      if (!controller.signal.aborted && epoch.current === token) setObserved(next)
    } catch (cause) { if (!controller.signal.aborted && epoch.current === token) setIssue(presentError(cause)) }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reader.current?.abort() } }, [])
  useEffect(() => { if (active) void inspect(); return () => reader.current?.abort() }, [active])
  async function save(): Promise<HostRouteSettings | undefined> {
    if (producer.current || !edit) return
    producer.current = true; setBusy(true); setIssue(''); ++epoch.current; reader.current?.abort()
    const runtimeId = target.expectedRuntimeId
    let dispatched = false, acknowledged = false, input: HostRouteParams['route.configure'] | undefined
    try {
      const current = readHostRouteDraft(useAppStore.getState().hostRouteDrafts, runtimeId) ?? edit
      input = { operationId: crypto.randomUUID(), expectedRevision: current.baseline.revision, configuration: parseHostRouteConfiguration(current.configuration) }
      const original = input
      change(value => ({ ...value, retainedSaves: [...value.retainedSaves, { input: original }] }))
      await checkpointHostRouteDrafts()
      if (!readHostRouteDraft(useAppStore.getState().hostRouteDrafts, runtimeId)?.retainedSaves.some(value => value.input.operationId === original.operationId)) throw Error('The original route intent changed before dispatch. No save was sent.')
      dispatched = true
      const receipt = await api.hostRoutes.call(target, 'route.configure', original)
      let currentBaseline = receipt.settings
      useAppStore.setState(state => {
        const value = readHostRouteDraft(state.hostRouteDrafts, runtimeId)
        if (!value) return state
        const accepted = acknowledgeHostRouteSave(value, original, receipt.settings)
        currentBaseline = accepted.baseline
        return { hostRouteDrafts: putHostRouteDraft(state.hostRouteDrafts, runtimeId, accepted) }
      })
      acknowledged = true
      if (mounted.current) setObserved(currentBaseline)
      await checkpointHostRouteDrafts()
      return receipt.settings
    } catch (cause) {
      const refusal = dispatched && !acknowledged ? hostRouteSaveRefusal(cause) : undefined
      if (input && (!dispatched || refusal)) {
        const original = input
        try { change(value => ({ ...value, retainedSaves: value.retainedSaves.map(row => row.input.operationId === original.operationId
          ? { ...row, ...(!dispatched ? { notSent: true as const } : {}), ...(refusal ? { refusal } : {}) } : row) })) }
        catch { /* Preserve the opaque original record; the existing draft read reports its gap. */ }
      }
      if (mounted.current) setIssue(`${acknowledged ? 'Policy saved at the original Core. The local edit checkpoint is unconfirmed.' : refusal ? 'The original Core refused this save. Your edit is retained.' : dispatched ? 'The save result is unconfirmed. Check the original policy; it was not retried.' : 'The save was not sent. Your edit is retained.'} ${presentError(cause)}`)
    }
    finally { producer.current = false; if (mounted.current) setBusy(false) }
  }
  function rebase(useSaved: boolean) {
    if (!observed) return
    change(current => ({ ...current, baseline: observed, ...(useSaved ? { configuration: { routes: observed.routes, grants: observed.grants } } : {}) }))
    setIssue('')
  }
  return { observed, edit, issue: draftIssue || issue, busy, inspect, save, change, rebase }
}
