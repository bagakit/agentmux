import { useEffect, useRef, useState } from 'react'
import type { RoomBinding } from '@agentmux/core/connections'
import { api } from './api'
import { groupTarget, groupWindowLimit, readGroupDiagnosis, retainGroupDiagnosis, type GroupDiagnosis } from './group-diagnosis'

export type CheckedGroupDiagnosis = { report: GroupDiagnosis | null; checking: boolean; checkedAt: number | null }
export const connectorDiagnosisKey = (binding: RoomBinding) => JSON.stringify(groupTarget(binding))

/** A visible header owns only a bounded, disposable reading of its exact original groups. */
export function useConnectorGroupDiagnosis(bindings: RoomBinding[], version: number, visible: boolean, syncEnabled: boolean | null) {
  const source = api.connections.call
  const targets = bindings.slice(0, groupWindowLimit).map(groupTarget)
  const identity = JSON.stringify(targets)
  const current = useRef({ identity, source, visible }); current.current = { identity, source, visible }
  const [request, setRequest] = useState(0)
  const [read, setRead] = useState<{ source: typeof source; entries: Record<string, CheckedGroupDiagnosis> } | null>(null)
  useEffect(() => {
    if (!visible || !targets.length) return
    let live = true
    const accepts = () => live && current.current.visible && current.current.identity === identity && current.current.source === source && api.connections.call === source
    setRead(previous => ({ source, entries: Object.fromEntries(targets.map(target => {
      const key = JSON.stringify(target), before = previous?.source === source ? previous.entries[key] : undefined
      return [key, { report: before?.report ?? null, checkedAt: before?.checkedAt ?? null, checking: true }]
    })) }))
    for (const target of targets) {
      const key = JSON.stringify(target)
      void readGroupDiagnosis(source, target).then(report => {
        if (!accepts()) return
        const checkedAt = Date.now()
        setRead(previous => ({ source, entries: { ...previous?.entries, [key]: {
          report: retainGroupDiagnosis(previous?.source === source ? previous.entries[key]?.report ?? null : null, report), checkedAt, checking: false
        } } }))
      })
    }
    return () => { live = false }
  }, [identity, source, version, visible, request, syncEnabled])
  return { entries: read?.source === source ? read.entries : {}, check: () => setRequest(value => value + 1), limit: groupWindowLimit }
}
