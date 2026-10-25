import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from './api'
import type { BrowserDirectoryRow } from './browser-resource-view'

/** One visible Browser directory reader; retained rows are observations, never another Browser owner. */
export function useBrowserDirectory(active: boolean) {
  const [rows, setRows] = useState<BrowserDirectoryRow[]>([])
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const observation = useRef<{ active: boolean; reading: boolean; reread: boolean; revision: number } | null>(null)
  const refresh = useCallback(async () => {
    const owner = observation.current
    if (!owner?.active) return
    if (owner.reading) { owner.reread = true; setPending(true); return }
    owner.reading = true
    setPending(true)
    try {
      do {
        owner.reread = false
        const issued = ++owner.revision
        try {
          const result = await api.browser.listTargets()
          if (!owner.active || observation.current !== owner) return
          if (issued !== owner.revision) continue
          setRows(previous => {
            const old = new Map(previous.map(row => [row.target.id, row]))
            const next = result.coverage === 'partial'
              ? new Map(previous.map(row => [row.target.id, { ...row, current: false }])) : new Map<string, BrowserDirectoryRow>()
            for (const target of result.targets) {
              const before = old.get(target.id)
              const locations = before?.target.resource?.locations
              // A partial native row with no positions cannot prove the saved bindings disappeared.
              const previousLocations = result.coverage === 'partial' && !target.resource?.locations.length
                ? locations?.length ? locations : before?.previousLocations : undefined
              next.set(target.id, { target, current: true, ...(previousLocations?.length ? { previousLocations } : {}) })
            }
            return [...next.values()]
          })
          setNotice(result.coverage === 'partial'
            ? [result.warning, 'This query is partial. Pages not observed here keep their last known entry.'].filter(Boolean).join(' ')
            : result.warning ?? '')
        } catch (error) {
          if (!owner.active || observation.current !== owner) return
          if (issued !== owner.revision) continue
          setRows(previous => previous.map(row => ({ ...row, current: false })))
          setNotice(`Refresh failed. Existing pages are kept. ${presentError(error)}`)
        }
      } while (owner.active && observation.current === owner && owner.reread)
    } finally {
      owner.reading = false
      if (owner.active && observation.current === owner) setPending(false)
    }
  }, [])
  useEffect(() => {
    if (!active) { setRows(previous => previous.map(row => ({ ...row, current: false }))); setPending(false); return }
    const owner = { active: true, reading: false, reread: false, revision: 0 }
    observation.current = owner
    const release = api.browser.onTargetsChanged(() => { void refresh() })
    void refresh()
    return () => { owner.active = false; owner.reread = false; observation.current = null; release() }
  }, [active, refresh])
  const invalidate = useCallback((id: string) => {
    if (observation.current) observation.current.revision++
    setRows(previous => previous.map(row => row.target.id === id ? { ...row, current: false } : row))
  }, [])
  const observedIds = useMemo(() => new Set(rows.filter(row => row.current).map(row => row.target.id)), [rows])
  return { rows, observedIds, pending, notice, refresh, invalidate }
}

