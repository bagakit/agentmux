import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import { launcherCandidateKey, launcherNativeRecap, type LauncherRecap, type LauncherResumeRow } from '../lib/launcher-resume'
import { launcherNativeSourceKey } from '../lib/launcher-native-discovery'

type Preview = { state: 'loading' | 'ready' | 'error'; recap: LauncherRecap | null; error?: string }

/** This key fences display reads; it does not grant a recovery or execution capability. */
export function launcherPreviewKey(row: LauncherResumeRow): string {
  const candidate = row.candidate
  return JSON.stringify('native' in candidate
    ? [candidate.hostId, candidate.executorId, launcherNativeSourceKey(candidate.native.source)]
    : [candidate.hostId, candidate.agentSessionId, candidate.providerId, candidate.nativeSessionId, candidate.nativeHandle, candidate.run])
}

async function readPreview(row: LauncherResumeRow): Promise<LauncherRecap | null> {
  const candidate = row.candidate
  if ('native' in candidate) {
    const page = await api.sessions.nativeHistoryPage({ hostId: candidate.hostId, executorId: candidate.executorId,
      source: candidate.native.source, limit: 100 })
    if (page.hostId !== candidate.hostId || page.executorId !== candidate.executorId ||
      launcherNativeSourceKey(page.nativeSource) !== launcherNativeSourceKey(candidate.native.source) ||
      page.source.providerId !== candidate.providerId || page.source.nativeSessionId !== candidate.nativeSessionId) {
      throw new Error('Conversation preview returned another saved source.')
    }
    return launcherNativeRecap(page)
  }
  const page = await api.sessions.historyPage({ hostId: candidate.hostId, agentSessionId: candidate.agentSessionId }, { limit: 100 })
  const nativeId = candidate.nativeSessionId ?? candidate.nativeHandle?.sessionId
  if (page.agentSessionId !== candidate.agentSessionId || page.source.providerId !== candidate.providerId ||
    (nativeId !== undefined && page.source.nativeSessionId !== nativeId)) {
    throw new Error('Conversation preview returned another Session identity.')
  }
  return launcherNativeRecap(page)
}

/** Read only visible candidates. Keep excerpts separate from the selected full conversation. */
export function useLauncherResumePreviews(open: boolean, list: HTMLDivElement | null,
  rows: readonly LauncherResumeRow[], selectedKey: string | null, retry: number) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const cache = useRef<Record<string, Preview>>({})
  const current = useRef({ rows, selectedKey, open })
  current.current = { rows, selectedKey, open }
  const visible = useRef(new Set<string>())
  const generation = useRef(0)
  const inFlight = useRef(0)
  const observer = useRef<IntersectionObserver | null>(null)
  const pump = useRef(() => {})

  pump.current = () => {
    if (!current.current.open || !observer.current) return
    while (inFlight.current < 2) {
      const row = current.current.rows.find(row => visible.current.has(launcherCandidateKey(row.candidate)) &&
        launcherCandidateKey(row.candidate) !== current.current.selectedKey && !row.recap && !cache.current[launcherPreviewKey(row)])
      if (!row) return
      const key = launcherPreviewKey(row), owner = generation.current
      cache.current = { ...cache.current, [key]: { state: 'loading', recap: null } }
      setPreviews(cache.current)
      inFlight.current += 1
      const publish = (preview: Preview) => {
        if (generation.current !== owner || !current.current.open ||
          !current.current.rows.some(candidate => launcherPreviewKey(candidate) === key)) return
        cache.current = { ...cache.current, [key]: preview }
        setPreviews(cache.current)
      }
      void readPreview(row).then(recap => publish({ state: 'ready', recap }))
        .catch(error => publish({ state: 'error', recap: null, error: presentError(error) }))
        .finally(() => { inFlight.current -= 1; pump.current() })
    }
  }

  useEffect(() => {
    generation.current += 1
    cache.current = {}; setPreviews({}); visible.current.clear()
    if (!open || !list || typeof IntersectionObserver === 'undefined') return
    observer.current = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.resumeKey
        if (key) { if (entry.isIntersecting) visible.current.add(key); else visible.current.delete(key) }
      }
      pump.current()
    }, { root: list })
    for (const element of list.querySelectorAll('[data-resume-key]')) observer.current.observe(element)
    return () => { generation.current += 1; observer.current?.disconnect(); observer.current = null; visible.current.clear() }
  }, [open, list, retry])

  useEffect(() => {
    const reading = observer.current
    if (!reading || !list) return
    reading.disconnect(); visible.current.clear()
    for (const element of list.querySelectorAll('[data-resume-key]')) reading.observe(element)
  })
  return previews
}
