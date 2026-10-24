import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import { api } from './api'
import { useWorkbenchDocument } from './workbench-document'
import { groupTarget, groupWindowLimit, readGroupDiagnosis, retainGroupDiagnosis, type GroupDiagnosis } from './group-diagnosis'

export type CheckedGroupDiagnosis = { report: GroupDiagnosis | null; checking: boolean; checkedAt: number | null }
export const connectorDiagnosisKey = (binding: RoomBinding) => JSON.stringify(groupTarget(binding))

/** A visible header owns only a bounded, disposable reading of its exact original groups. */
export function useConnectorGroupDiagnosis(bindings: RoomBinding[], version: number, visible: boolean, syncEnabled: boolean | null, hostingTarget?: ConnectionHostingTarget | null, observedBindings: RoomBinding[] = []) {
  const document = useWorkbenchDocument()
  const originalSource = api.connections.call, owner = JSON.stringify(hostingTarget)
  const source: typeof api.connections.call = useMemo(() => (method, params) => {
    if (hostingTarget === null) return Promise.reject(new Error('The original bot hosting owner is unconfirmed.'))
    return originalSource(method, params, hostingTarget)
  }, [originalSource, owner])
  const targets = (observedBindings.length ? observedBindings : bindings).slice(0, groupWindowLimit).map(groupTarget)
  const identity = JSON.stringify([targets, hostingTarget])
  const observed = JSON.stringify(observedBindings.map(connectorDiagnosisKey))
  const pending = useRef<{ source: typeof source; reads: Map<string, Promise<GroupDiagnosis>> }>({ source, reads: new Map() })
  const lastRead = useRef<{ source: typeof source; key: string } | null>(null)
  const current = useRef({ identity, source, visible }); current.current = { identity, source, visible }
  const [request, setRequest] = useState(0)
  const [read, setRead] = useState<{ source: typeof source; entries: Record<string, CheckedGroupDiagnosis> } | null>(null)
  useEffect(() => {
    if (!visible || !targets.length || hostingTarget === null) { lastRead.current = null; return }
    const readKey = JSON.stringify([bindings.map(groupTarget), hostingTarget, version, request, syncEnabled])
    const needsInitial = lastRead.current?.source !== source || lastRead.current.key !== readKey
    let live = true, reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const watched = new Set<string>(JSON.parse(observed))
    const accepts = () => live && current.current.visible && current.current.identity === identity && current.current.source === source && api.connections.call === originalSource
    if (pending.current.source !== source) pending.current = { source, reads: new Map() }
    const reads = pending.current.reads
    async function check(refreshOnly = false) {
      if (!accepts() || reading || document.visibilityState === 'hidden') return
      const selected = refreshOnly ? targets.filter(target => watched.has(JSON.stringify(target))) : targets
      if (!selected.length) return
      clearTimeout(timer); reading = true
      lastRead.current = { source, key: readKey }
      setRead(previous => ({ source, entries: Object.fromEntries(bindings.map(groupTarget).map(target => {
        const key = JSON.stringify(target), before = previous?.source === source ? previous.entries[key] : undefined
        return [key, { report: before?.report ?? null, checkedAt: before?.checkedAt ?? null,
          checking: selected.some(item => JSON.stringify(item) === key) || before?.checking === true }]
      })) }))
      await Promise.all(selected.map(async target => {
        const key = JSON.stringify(target)
        let result = reads.get(key)
        if (!result) {
          result = readGroupDiagnosis(source, target)
          reads.set(key, result)
          void result.finally(() => { if (reads.get(key) === result) reads.delete(key) })
        }
        const report = await result
        if (!accepts()) return
        setRead(previous => ({ source, entries: { ...previous?.entries, [key]: {
          report: retainGroupDiagnosis(previous?.source === source ? previous.entries[key]?.report ?? null : null, report), checkedAt: Date.now(), checking: false
        } } }))
      }))
      reading = false
      // Host recovery owns the work. This open surface only observes its original results.
      if (accepts() && watched.size && document.visibilityState !== 'hidden') timer = setTimeout(() => { void check(true) }, 5000)
    }
    const resume = () => { clearTimeout(timer); void check(true) }
    document.addEventListener('visibilitychange', resume)
    document.defaultView?.addEventListener('focus', resume)
    if (needsInitial || watched.size) void check(!needsInitial)
    return () => {
      live = false; clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      document.defaultView?.removeEventListener('focus', resume)
    }
  }, [identity, source, version, visible, request, syncEnabled, observed, document])
  return { entries: read?.source === source ? read.entries : {}, check: () => setRequest(value => value + 1), limit: groupWindowLimit }
}
