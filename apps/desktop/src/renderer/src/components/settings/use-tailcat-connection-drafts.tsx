import { useEffect, useState } from 'react'
import type { HostConfig } from '../../../../shared/contracts'
import { configValuesEqual } from '../../../../shared/config-edit'
import { useAppStore } from '../../store'
import { tailcatDraftRecord, tailcatConnectionDraft, tailcatDraftMatchesSaved, isTailcatDraftHost, type TailcatDraftScope } from '../../lib/tailcat-connection-draft'
import { useResourceDrafts } from './use-resource-drafts'

/** An edit leaf in the original native user document, never a settings writer. */
export function useTailcatConnectionDrafts(saved: Record<string, HostConfig>, scope: TailcatDraftScope) {
  const raw = useAppStore(state => state.tailcatConnectionDrafts)
  const [restored] = useState(() => {
    const entries = tailcatDraftRecord(tailcatDraftRecord(raw)?.[scope]), value = { ...saved }, expected = { ...saved }, withheld = new Set<string>()
    for (const [id, rawEntry] of Object.entries(entries ?? {})) {
      const entry = tailcatConnectionDraft(rawEntry)
      if (!entry || entry.value.id !== id || !tailcatDraftMatchesSaved(entry, saved[id])) { withheld.add(id); continue }
      value[id] = entry.value
      if (entry.expected) expected[id] = entry.expected
      else delete expected[id]
    }
    return { value, expected, withheld }
  })
  const resource = useResourceDrafts(saved, restored)
  const [allowedText, setAllowedText] = useState<Record<string, string>>(() => {
    const entries = tailcatDraftRecord(tailcatDraftRecord(raw)?.[scope])
    return Object.fromEntries(Object.entries(entries ?? {}).flatMap(([id, rawEntry]) => {
      const entry = tailcatConnectionDraft(rawEntry)
      return entry?.allowedText !== undefined && !restored.withheld.has(id) ? [[id, entry.allowedText]] : []
    }))
  })
  const entries = tailcatDraftRecord(tailcatDraftRecord(raw)?.[scope])
  const retainedEntries = Object.entries(entries ?? {}).flatMap(([id, original]) => {
    const entry = tailcatConnectionDraft(original), holder = tailcatDraftRecord(original)
    const rows = Array.isArray(holder?.retained) ? holder.retained : []
    const activeIsForeign = entry && !tailcatDraftMatchesSaved(entry, saved[id])
    return [...rows, ...(activeIsForeign || !entry && !rows.length ? [original] : [])].map((entry, index) => ({ id, index, entry }))
  })
  const issue = !tailcatDraftRecord(raw) || !entries ? 'Saved connection edits are unreadable. Their original data is kept; this editor still works.'
    : retainedEntries.length ? 'An original connection changed or its edit is unreadable. The retained edit was not applied to another target.' : undefined
  useEffect(() => {
    const state = useAppStore.getState(), original = state.tailcatConnectionDrafts, readable = tailcatDraftRecord(original)
    const authored = Object.keys(resource.value).some(id => isTailcatDraftHost(resource.value[id]) && (!configValuesEqual(resource.value[id], resource.expected[id]) || allowedText[id] !== undefined))
    if (!readable && !authored) return
    const all: Record<string, unknown> = readable ?? { retainedUnparsed: [original] }, scopeRecord = tailcatDraftRecord(all[scope])
    if (!scopeRecord && !authored) return
    let opaqueKey = 'unreadable-scope'
    while (Object.hasOwn(resource.value, opaqueKey) || Object.hasOwn(resource.expected, opaqueKey)) opaqueKey += '_'
    const previous = scopeRecord ?? { [opaqueKey]: all[scope] }
    const next = { ...previous }
    for (const id of new Set([...Object.keys(resource.value), ...Object.keys(resource.expected)])) {
      const value = resource.value[id], expected = resource.expected[id]
      if (!isTailcatDraftHost(value) && !isTailcatDraftHost(expected)) continue
      const literalEdit = value?.kind === 'local' && allowedText[id] !== undefined && allowedText[id] !== (expected?.kind === 'local' ? expected.tailcat?.allowedClients.join('\n') ?? '' : '')
      const old = tailcatConnectionDraft(previous[id]), holder = tailcatDraftRecord(previous[id])
      const retained = Array.isArray(holder?.retained) ? holder.retained : []
      const foreign = old ? !tailcatDraftMatchesSaved(old, expected) : Object.hasOwn(previous,id) && !retained.length
      if (!value || configValuesEqual(value, expected) && !literalEdit) {
        if (foreign) continue
        if (retained.length) next[id] = { retained }
        else delete next[id]
      } else {
        const rows = foreign ? [...retained, old ? { ...old, retained: undefined } : previous[id]] : retained
        next[id] = { value, ...(expected ? { expected } : {}), ...(allowedText[id] === undefined ? {} : { allowedText: allowedText[id] }), ...(rows.length ? { retained: rows } : {}) }
      }
    }
    if (!readable || !scopeRecord || !configValuesEqual(previous, next)) useAppStore.setState({ tailcatConnectionDrafts: { ...all, [scope]: next } })
  }, [resource.value, resource.expected, allowedText, raw, scope, restored])
  const retained = <>{issue ? <div role="status" className="host-check-detail"><p>{issue}</p>
    {entries ? retainedEntries.map(({id,index,entry:original}) => {
      const entry = tailcatConnectionDraft(original)
      return <details key={id+index}><summary>Retained edit · {entry?.value.label ?? id}</summary>
        {entry ? <><p>Original key: <code>{entry.value.tailcat?.keyFile ?? 'Default key'}</code></p>
          {entry.value.kind === 'ssh' ? <label>Private destination<input type="password" readOnly value={entry.value.tailcat?.address ?? ''} /></label>
            : <pre>{entry.allowedText ?? entry.value.tailcat?.allowedClients.join('\n') ?? ''}</pre>}</> : <p>The original record is kept without rewriting it.</p>}
        <button type="button" className="small-button" onClick={() => {
          const state=useAppStore.getState(),all=tailcatDraftRecord(state.tailcatConnectionDrafts),current=all&&tailcatDraftRecord(all[scope]);if(!all||!current)return
          const next={...current},holder=tailcatDraftRecord(current[id]),rows=Array.isArray(holder?.retained)?holder.retained:[]
          if(index<rows.length){const remaining=rows.filter((_,i)=>i!==index),active=tailcatConnectionDraft(current[id]);next[id]=active?{...active,retained:remaining}:{retained:remaining};if(!active&&!remaining.length)delete next[id]}
          else delete next[id]
          useAppStore.setState({tailcatConnectionDrafts:{...all,[scope]:next}})
        }}>Discard this retained edit</button></details>
    }) : null}</div> : null}</>
  return { ...resource, retained, allowedText, setAllowedText: (id: string, value: string) => setAllowedText(current => ({ ...current, [id]: value })) }
}
