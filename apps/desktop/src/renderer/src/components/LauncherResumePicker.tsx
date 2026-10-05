import { TextInput } from '@agentmux/client-ui/input'
import { ConversationMessage } from '@agentmux/client-ui'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { usePathDisplay } from '../hooks/usePathDisplay'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Check, ChevronDown, Clock3, FolderOpen, LoaderCircle, RotateCcw, Search, X } from 'lucide-react'
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentLaunchInput, AgentTimelineSnapshot, NativeAgentSessionsInput, NativeAgentSessionsResult, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { formatRelativeAge } from '../lib/relative-age'
import { filterLauncherResumeRows, launcherCandidateIdentity, launcherCandidateKey, launcherManagedCandidates, launcherNativeRecap, launcherNativeResumeRows, launcherResumeRows, launcherResumeShortId, launcherTimelineRecap, type LauncherRecap, type LauncherResumeRow } from '../lib/launcher-resume'
import { agentProviderLabel } from './AgentProviderIcon'
import { mintObjectId } from '@agentmux/core/object-id'
import { AgentAvatar } from './AgentAvatar'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { SettingsNavigation } from './SettingsNavigation'
import { launcherCatalogWarnings, launcherDiscoveryKey, launcherNativeDiscovery, launcherNativeSourceKey, mergeLauncherNativeCatalog } from '../lib/launcher-native-discovery'
import { launcherPreviewKey, useLauncherResumePreviews } from '../hooks/useLauncherResumePreviews'

type RecapRead = { state: 'loading' | 'ready' | 'error'; recap: LauncherRecap | null; error?: string }
type NativeRead = RecapRead & { page?: import('@agentmux/core').AgentProviderSessionHistoryPage; loadingMore?: boolean; sourceKey: string }
type RecoveryFeedback = { id: string; name: string; outcome: 'failed' | 'restored'; text: string }
const EMPTY_CANDIDATES: ReturnType<typeof useAppStore.getState>['recoveryCandidates'] = []
const EMPTY_ROWS: LauncherResumeRow[] = []
const EMPTY_FACTS = { timelines: {} as Record<string, AgentTimelineSnapshot>, sessions: [] as SessionSnapshot[], names: {} as Record<string, string> }

export function LauncherResumePicker({ workspace, disabled = false }: { workspace?: WorkspaceRecord | undefined; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const displayPath = usePathDisplay()
  const config = useAppStore(state => open ? state.config : null)
  const savedCandidates = useAppStore(state => open ? state.recoveryCandidates : EMPTY_CANDIDATES)
  const [facts, setFacts] = useState(EMPTY_FACTS)
  const recoverSession = useAppStore(state => state.recoverSession)
  const resumeNativeSession = useAppStore(state => state.resumeNativeSession)
  const [catalogs, setCatalogs] = useState<NativeAgentSessionsResult[]>([])
  const [discovery, setDiscovery] = useState<{ pending: NativeAgentSessionsInput[]; total: number; errors: string[] }>({ pending: [], total: 0, errors: [] })
  const [discoveryPaused, setDiscoveryPaused] = useState(false)
  const [discoveryRetry, setDiscoveryRetry] = useState(0)
  const nativeOperations = useRef<Record<string, { request: AgentLaunchInput; source: import('@agentmux/core').AgentNativeSessionCandidate; capabilities: import('@agentmux/core').AgentCapabilities; attempted: boolean }>>({})
  const presentationOwner = useRef(0)
  const settings = useContext(SettingsNavigation)
  const [preferredScope, setScope] = useState<'project' | 'global'>('project')
  const scope = workspace ? preferredScope : 'global'
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reads, setReads] = useState<Record<string, RecapRead>>({})
  const [nativeReads, setNativeReads] = useState<Record<string, NativeRead>>({})
  const [recapRetry, setRecapRetry] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<RecoveryFeedback | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const nativeLastMessageRef = useRef<HTMLElement>(null)
  const requestOwner = useRef(0)
  const nativeRequestOwner = useRef(0)
  const selectionOwner = useRef<string | undefined>(undefined)
  const listId = useId()
  const topics = useAppStore(state => scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
  const candidates = useMemo(() => launcherManagedCandidates(savedCandidates, facts.sessions), [savedCandidates, facts.sessions])
  const sourceRows = useMemo(() => open ? [
    ...launcherResumeRows({ topics, candidates, config, workspace, timelines: facts.timelines,
      agentNames: facts.names, sessions: facts.sessions,
      nativeRecaps: Object.fromEntries(Object.entries(reads).map(([id, read]) => [id, read.recap])) }),
    ...launcherNativeResumeRows({ topics, catalogs, managed: candidates, config, workspace }).map(row => {
      if (!('native' in row.candidate)) return row
      const read = nativeReads[launcherCandidateKey(row.candidate)]
      return read?.sourceKey === JSON.stringify([row.candidate.hostId, row.candidate.executorId, launcherNativeSourceKey(row.candidate.native.source)])
        ? { ...row, recap: read.recap } : row
    })
  ].sort((left, right) => right.candidate.updatedAt - left.candidate.updatedAt || launcherCandidateKey(left.candidate).localeCompare(launcherCandidateKey(right.candidate))) : EMPTY_ROWS,
  [open, candidates, catalogs, config, workspace, facts, reads, nativeReads, topics])
  const previews = useLauncherResumePreviews(open, list, sourceRows, selectedId, recapRetry)
  const rows = useMemo(() => sourceRows.map(row => row.recap ? row : { ...row, recap: previews[launcherPreviewKey(row)]?.recap ?? null }), [sourceRows, previews])
  const filtered = useMemo(() => filterLauncherResumeRows(rows, scope, query), [rows, scope, query])
  const idLabels = useMemo(() => {
    const sorted = rows.map(row => row.candidate).sort((a, b) => launcherCandidateIdentity(a) < launcherCandidateIdentity(b) ? -1 : launcherCandidateIdentity(a) > launcherCandidateIdentity(b) ? 1 : 0)
    return new Map(sorted.map((candidate, index) => {
      const id = launcherCandidateIdentity(candidate)
      const neighbors = sorted.slice(Math.max(0, index - 1), index + 2)
      return [id, launcherResumeShortId(id, neighbors)]
    }))
  }, [rows])
  const savedSelection = filtered.find(row => launcherCandidateKey(row.candidate) === selectedId) ?? filtered[0]
  const selectedKey = savedSelection ? launcherCandidateKey(savedSelection.candidate) : undefined
  const selectedSessionId = savedSelection && !('native' in savedSelection.candidate) ? savedSelection.candidate.agentSessionId : undefined
  const selectedHostId = savedSelection?.candidate.hostId
  const nativeCandidate = savedSelection && 'native' in savedSelection.candidate ? savedSelection.candidate : undefined
  const nativeSourceKey = nativeCandidate ? JSON.stringify([nativeCandidate.hostId, nativeCandidate.executorId, launcherNativeSourceKey(nativeCandidate.native.source)]) : undefined
  if (selectionOwner.current !== selectedKey) presentationOwner.current += 1
  selectionOwner.current = selectedKey
  const selectedTimeline = useAppStore(state => open && selectedSessionId ? state.timelines[selectedSessionId] : undefined)
  const selectedName = useAppStore(state => open && selectedSessionId ? state.agentNames[selectedSessionId] : undefined)
  const selectedSessionSelector = useMemo(() => {
    let previous: SessionSnapshot[] | undefined
    let value: SessionSnapshot | undefined
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (!open || !selectedSessionId) return undefined
      if (previous !== state.sessions) { previous = state.sessions; value = state.sessions.find(session => session.id === selectedSessionId) }
      return value
    }
  }, [open, selectedSessionId])
  const selectedSession = useAppStore(selectedSessionSelector)
  const savedSession = useMemo(() => facts.sessions.find(session => session.id === selectedSessionId), [facts.sessions, selectedSessionId])
  const selected = useMemo(() => savedSelection && selectedSessionId && !('native' in savedSelection.candidate) ? launcherResumeRows({ topics,
    candidates: [savedSelection.candidate], config, workspace,
    timelines: selectedTimeline ? { [selectedSessionId]: selectedTimeline } : facts.timelines,
    agentNames: selectedName === undefined ? {} : { [selectedSessionId]: selectedName },
    sessions: selectedSession ? [selectedSession] : savedSession ? [savedSession] : [],
    nativeRecaps: { [selectedSessionId]: reads[selectedSessionId]?.recap }
  })[0] : savedSelection, [savedSelection, selectedSessionId, config, workspace, selectedTimeline, selectedName, selectedSession, savedSession, facts.timelines, reads, topics])
  const selectedTimelineRecap = selectedSessionId ? launcherTimelineRecap(selectedTimeline ?? facts.timelines[selectedSessionId]) : null
  const projectCount = rows.filter(row => row.inProject).length
  const selectedHostConfigured = Boolean(config?.hosts.some(host => host.id === selectedHostId))
  const selectedNativeRead = selectedKey && nativeReads[selectedKey]?.sourceKey === nativeSourceKey ? nativeReads[selectedKey] : undefined
  const nativeMessages = selectedNativeRead?.page?.items.filter(item => item.kind === 'user-message' || item.kind === 'assistant-message') ?? []
  const selectedRead = selectedSessionId ? reads[selectedSessionId] : selectedNativeRead
  const selectedProviderLabel = selected ? agentProviderLabel(selected.candidate.providerId) : ''
  const discoveryPlan = launcherNativeDiscovery(config, workspace, scope)
  const readNativeResource = useCallback(async (input: import('@agentmux/core').AgentSessionHistoryResourceRequest) => {
    if (!nativeCandidate) throw new Error('Select the original saved conversation before reading its recorded content.')
    const result = await api.sessions.nativeHistoryResource({ hostId: nativeCandidate.hostId, executorId: nativeCandidate.executorId,
      nativeSource: nativeCandidate.native.source, ...input })
    if (result.hostId !== nativeCandidate.hostId || result.executorId !== nativeCandidate.executorId ||
      launcherNativeSourceKey(result.nativeSource) !== launcherNativeSourceKey(nativeCandidate.native.source)) {
      throw new Error('Recorded content returned another saved conversation source.')
    }
    return result
  }, [nativeSourceKey])

  // Show the latest recorded speech on first read. Older-page reads keep the reader's position.
  useEffect(() => {
    if (!open || selectedNativeRead?.state !== 'ready') return
    const message = nativeLastMessageRef.current
    const detail = message?.closest<HTMLElement>('.launcher-resume__detail')
    const scroller = detail && detail.scrollHeight > detail.clientHeight ? detail : detail?.closest<HTMLElement>('.launcher-resume__body')
    if (scroller && message) scroller.scrollTop += message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
  }, [open, nativeSourceKey, selectedNativeRead?.state])

  // Discovery observes metadata. Every source publishes independently, so a slow
  // Host cannot hide completed conversations or restart reads on unrelated Settings updates.
  useEffect(() => {
    if (!open || !config || discoveryPaused) return
    let current = true
    const requests = discoveryPlan.requests
    setDiscovery({ pending: requests, total: requests.length, errors: [] })
    for (const input of requests) {
      const label = `${config.hosts.find(host => host.id === input.hostId)?.label ?? input.hostId} · ${config.executors[input.executorId]?.label ?? input.executorId}`
      const finish = (errors: string[]) => {
        if (!current) return
        setDiscovery(state => ({ ...state,
          pending: state.pending.filter(request => launcherDiscoveryKey(request) !== launcherDiscoveryKey(input)),
          errors: [...state.errors, ...errors.map(error => `${label}: ${error}`)] }))
      }
      void Promise.resolve().then(() => api.sessions.nativeSessions(input)).then(catalog => {
        if (!current) return
        if (catalog.hostId !== input.hostId || catalog.executorId !== input.executorId) throw new Error('Conversation discovery returned another Host or Executor.')
        setCatalogs(previous => mergeLauncherNativeCatalog(previous, catalog))
        finish(launcherCatalogWarnings(catalog))
      }).catch(error => finish([presentError(error)]))
    }
    return () => { current = false }
  }, [open, discoveryPlan.key, discoveryRetry, discoveryPaused])

  // Pin the first available choice. Later source completions cannot silently select
  // a newer conversation while its details are being read or Resume is in flight.
  useEffect(() => {
    if (open && selectedKey && !filtered.some(row => launcherCandidateKey(row.candidate) === selectedId)) setSelectedId(selectedKey)
  }, [open, selectedKey, selectedId])

  useEffect(() => {
    if (!open || !nativeCandidate || !selectedKey || !nativeSourceKey) return
    const key = selectedKey, sourceKey = nativeSourceKey
    const owner = ++nativeRequestOwner.current
    let current = true
    setNativeReads(values => ({ ...values, [key]: { state: 'loading', recap: null, sourceKey } }))
    void Promise.resolve().then(() => api.sessions.nativeHistoryPage({ hostId: nativeCandidate.hostId, executorId: nativeCandidate.executorId,
      source: nativeCandidate.native.source, limit: 100 })).then(page => {
      if (!current || nativeRequestOwner.current !== owner) return
      if (page.hostId !== nativeCandidate.hostId || page.executorId !== nativeCandidate.executorId ||
        launcherNativeSourceKey(page.nativeSource) !== launcherNativeSourceKey(nativeCandidate.native.source) ||
        page.source.providerId !== nativeCandidate.providerId || page.source.nativeSessionId !== nativeCandidate.nativeSessionId) {
        throw new Error('Conversation details returned another saved source.')
      }
      setNativeReads(values => ({ ...values, [key]: { state: 'ready', recap: launcherNativeRecap(page), page, sourceKey } }))
    }).catch(error => {
      if (current && nativeRequestOwner.current === owner) setNativeReads(values => ({ ...values, [key]: { state: 'error', recap: null, error: presentError(error), sourceKey } }))
    })
    return () => { current = false }
  }, [open, selectedKey, nativeSourceKey, recapRetry])

  useEffect(() => {
    if (!open || !selectedSessionId || !selectedHostId || selectedTimelineRecap) return
    if (reads[selectedSessionId]?.state === 'ready') return
    const owner = ++requestOwner.current
    let current = true
    setReads(values => ({ ...values, [selectedSessionId]: { state: 'loading', recap: null } }))
    void api.sessions.historyPage({ hostId: selectedHostId, agentSessionId: selectedSessionId }, { limit: 6 }).then(page => {
      if (!current || owner !== requestOwner.current) return
      if (page.agentSessionId !== selectedSessionId) throw new Error('Conversation read returned another Session identity.')
      const recap = launcherNativeRecap(page)
      setReads(values => ({ ...values, [selectedSessionId]: { state: 'ready', recap } }))
    }).catch(cause => {
      if (!current || owner !== requestOwner.current) return
      setReads(values => ({ ...values, [selectedSessionId]: { state: 'error', recap: null, error: presentError(cause) } }))
    })
    return () => { current = false }
  }, [open, selectedSessionId, selectedHostId, selectedTimelineRecap?.text, recapRetry])

  function changeOpen(value: boolean) {
    presentationOwner.current += 1
    setOpen(value)
    if (value) {
      setDiscoveryPaused(false)
      const state = useAppStore.getState()
      const ids = new Set(launcherManagedCandidates(state.recoveryCandidates, state.sessions).map(candidate => candidate.agentSessionId))
      setFacts({
        timelines: Object.fromEntries([...ids].flatMap(id => state.timelines[id] ? [[id, state.timelines[id]!]] : [])),
        names: Object.fromEntries([...ids].flatMap(id => state.agentNames[id] ? [[id, state.agentNames[id]!]] : [])),
        sessions: state.sessions.filter(session => ids.has(session.id))
      })
      setScope('project'); setQuery(''); setSelectedId(null); setFeedback(null)
    } else setFacts(EMPTY_FACTS)
  }

  function choose(id: string) { presentationOwner.current += 1; setSelectedId(id); setFeedback(null) }
  function changeScope(value: 'project' | 'global') { presentationOwner.current += 1; setDiscoveryPaused(false); setScope(value); setSelectedId(null); setFeedback(null) }
  function changeQuery(value: string) { presentationOwner.current += 1; setQuery(value); setSelectedId(null); setFeedback(null) }

  async function readOlderNativeMessages() {
    if (!nativeCandidate || !selectedKey || !nativeSourceKey || !selectedNativeRead?.page?.nextCursor || selectedNativeRead.loadingMore) return
    const key = selectedKey, sourceKey = nativeSourceKey, page = selectedNativeRead.page, owner = nativeRequestOwner.current
    const current = () => nativeRequestOwner.current === owner && selectionOwner.current === key
    setNativeReads(values => {
      const { error: _error, ...previous } = values[key]!
      return { ...values, [key]: { ...previous, loadingMore: true } }
    })
    try {
      const older = await api.sessions.nativeHistoryPage({ hostId: nativeCandidate.hostId, executorId: nativeCandidate.executorId,
        source: nativeCandidate.native.source, cursor: page.nextCursor!, limit: 100 })
      if (!current()) return
      if (older.hostId !== nativeCandidate.hostId || older.executorId !== nativeCandidate.executorId ||
        launcherNativeSourceKey(older.nativeSource) !== launcherNativeSourceKey(nativeCandidate.native.source) ||
        older.source.providerId !== page.source.providerId || older.source.nativeSessionId !== page.source.nativeSessionId) {
        throw new Error('The older messages belong to another saved conversation.')
      }
      const items = [...new Map([...older.items, ...page.items].map(item => [item.id, item])).values()]
      setNativeReads(values => ({ ...values, [key]: { ...values[key]!, page: { ...older, items }, loadingMore: false, sourceKey } }))
    } catch (error) {
      if (current()) setNativeReads(values => ({ ...values, [key]: { ...values[key]!, loadingMore: false, error: presentError(error) } }))
    }
  }

  async function resume(row: LauncherResumeRow) {
    if (busyId || disabled) return
    const key = launcherCandidateKey(row.candidate)
    const id = launcherCandidateIdentity(row.candidate)
    const owner = presentationOwner.current
    const stillSelected = () => presentationOwner.current === owner && selectionOwner.current === key
    const fail = (text: string) => setFeedback({ id, name: row.name, outcome: 'failed', text })
    setBusyId(key); setFeedback(null)
    try {
      if (!row.workspace) {
        if (!useAppStore.getState().config?.hosts.some(host => host.id === row.candidate.hostId)) {
          fail('This Host is not configured. Add it in Settings to open this saved Session in its original project.')
          return
        }
        // Main commits and publishes config before returning. Reuse that owner; a later config.get
        // snapshot could overwrite a newer edit. The candidate's original execution address is exact.
        await api.workspaces.add({ hostId: row.candidate.hostId, path: row.candidate.workspacePath })
      }
      if ('native' in row.candidate) {
        const operation = nativeOperations.current[key] ??= structuredClone({ request: {
          agentSessionId: mintObjectId(), createOperationId: crypto.randomUUID(), hostId: row.candidate.hostId,
          executorId: row.candidate.executorId, workspacePath: row.candidate.workspacePath,
          nativeResumeSource: row.candidate.native.source }, source: row.candidate.native, capabilities: row.candidate.capabilities, attempted: false })
        const retry = operation.attempted
        operation.attempted = true
        const recovered = await resumeNativeSession(operation.request, operation.source, operation.capabilities, stillSelected, retry)
        if (recovered && stillSelected()) changeOpen(false)
        else if (!recovered && stillSelected()) fail(useAppStore.getState().sessions.find(session => session.id === operation.source.managed?.agentSessionId)?.status.detail
          ?? 'Recovery did not confirm a current Session for the original conversation. Its saved history is kept; retry to check this same resume operation.')
        return
      }
      const before = useAppStore.getState()
      const current = before.sessions.find(session => session.id === id)
      if (current && stillSelected()) before.selectSession(id)
      // Core can report that this stable Session already owns a newer Run. Re-read that exact
      // identity instead of retrying the obsolete Run or starting a replacement Agent.
      if (current?.status.continuityConflict === 'session-run-changed') await before.refreshSession(id)
      const recovered = await recoverSession(id, crypto.randomUUID(), { stillCurrent: stillSelected })
      if (recovered) {
        if (stillSelected()) changeOpen(false)
        else setFeedback({ id, name: row.name, outcome: 'restored', text: 'This saved Session was restored in its original project. Its current Run remains available.' })
        return
      }
      const state = useAppStore.getState()
      fail(state.sessions.find(session => session.id === id)?.status.detail
        ?? 'Recovery did not confirm a current Run. The saved Session is kept; retry to check attachment or resume.')
    } catch (cause) {
      if ('native' in row.candidate && cause && typeof cause === 'object' && 'controlFailure' in cause &&
        (cause.controlFailure as { disposition?: string } | undefined)?.disposition === 'not_applied') delete nativeOperations.current[key]
      fail(`${presentError(cause)}. The saved Session and its project are kept. Retry this same Session to check attachment or resume.`)
    } finally { setBusyId(null) }
  }

  function moveSelection(step: number) {
    if (!filtered.length) return
    const current = filtered.findIndex(row => launcherCandidateKey(row.candidate) === selectedKey)
    const next = filtered[(current + step + filtered.length) % filtered.length]!
    choose(launcherCandidateKey(next.candidate))
    document.getElementById(`${listId}-${launcherCandidateKey(next.candidate)}`)?.scrollIntoView?.({ block: 'nearest' })
  }

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Trigger asChild>
      <button type="button" className="small-button launcher-resume-trigger" disabled={disabled}
        title="Choose a saved Session from this project or all projects">
        <RotateCcw size={13} aria-hidden="true" /><span>Resume</span><ChevronDown size={11} aria-hidden="true" />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="dialog-scrim launcher-resume__scrim" />
      <Dialog.Content className="dialog-surface launcher-resume" aria-busy={busyId !== null}
        onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus() }}>
        <header className="launcher-resume__header">
          <div><Dialog.Title>Resume a Session</Dialog.Title>
            <Dialog.Description>Pick up where you left off, in its original project.</Dialog.Description></div>
          <Dialog.Close className="icon-button" aria-label="Close resume picker"><X size={15} /></Dialog.Close>
        </header>
        <div className="launcher-resume__controls">
          <div className="launcher-resume__scope" aria-label="Session scope">
            {workspace ? <button type="button" aria-pressed={scope === 'project'} onClick={() => changeScope('project')}>
              This project <span>{projectCount}</span>
            </button> : null}
            <button type="button" aria-pressed={scope === 'global'} onClick={() => changeScope('global')}>
              All projects <span>{rows.length}</span>
            </button>
          </div>
          <label className="launcher-resume__search"><Search size={14} aria-hidden="true" />
            <TextInput ref={searchRef} aria-label="Search saved Sessions" role="combobox" aria-expanded="true"
              aria-controls={listId} aria-activedescendant={selectedKey ? `${listId}-${selectedKey}` : undefined}
              placeholder="Search Agent, ID, project or known recap…" value={query} onChange={event => changeQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1) }
                if (event.key === 'Enter' && selected) { event.preventDefault(); void resume(selected) }
              }} />
            {query ? <button type="button" className="icon-button" aria-label="Clear Session search" onClick={() => { changeQuery(''); searchRef.current?.focus() }}><X size={12} /></button> : null}
          </label>
          <button type="button" className="icon-button" aria-label="Refresh discovery" title="Refresh saved conversations"
            onClick={() => { setDiscoveryPaused(false); setDiscoveryRetry(value => value + 1); setRecapRetry(value => value + 1) }}><RotateCcw size={14} /></button>
        </div>
        <div className="launcher-resume__body">
          <div className="launcher-resume__list" ref={setList} id={listId} role="listbox" aria-label="Saved Sessions">
            {filtered.map(savedRow => {
              const row = selected && launcherCandidateKey(selected.candidate) === launcherCandidateKey(savedRow.candidate) ? selected : savedRow
              const candidate = row.candidate
              const key = launcherCandidateKey(candidate)
              const identity = launcherCandidateIdentity(candidate)
              const preview = previews[launcherPreviewKey(row)]
              const active = selectedKey === key
              return <button type="button" role="option" aria-selected={active} className="launcher-resume__row"
                id={`${listId}-${key}`} data-resume-key={key} key={key} onClick={() => choose(key)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1); searchRef.current?.focus() }
                }}>
                <span className="launcher-resume__row-head"><AgentAvatar label={row.name} providerId={candidate.providerId} size={18} />
                  <strong>{row.name}</strong>{active ? <Check size={12} aria-hidden="true" /> : null}
                  <time dateTime={new Date(candidate.updatedAt).toISOString()} title={new Date(candidate.updatedAt).toLocaleString()}>{formatRelativeAge(Date.now() - candidate.updatedAt, ' ago')}</time></span>
                <span className="launcher-resume__row-recap" title={row.recap ? `${row.recap.source}: ${row.recap.displayText ?? row.recap.text}` : preview?.error}>
                  {row.recap ? <><span>{row.recap.source === 'Last assistant message' ? 'Reply' : 'Input'} · </span>{row.recap.displayText ?? row.recap.text}</>
                    : preview?.state === 'error' ? 'Preview could not be read'
                    : preview?.state === 'ready' ? 'No text on this page'
                    : preview?.state === 'loading' ? 'Reading preview…' : 'Preview not read yet'}
                </span>
                <span className="launcher-resume__row-meta"><span title={`${row.executorName} · ${row.projectName} · ${row.hostName}`}>
                  {row.executorName}{scope === 'global' ? ` · ${row.projectName} · ${row.hostName}` : ''}</span>
                  <code title={identity}>#{idLabels.get(identity)}</code><span className="launcher-resume__row-state">{row.stateLabel}</span></span>
              </button>
            })}
            {!filtered.length ? <div className="launcher-resume__empty"><FolderOpen size={23} aria-hidden="true" />
              <strong>{discovery.pending.length || discoveryPaused || discovery.errors.length ? query ? 'No matches among listed Sessions' : 'Discovering saved conversations'
                : query ? 'No matching Sessions' : scope === 'project' ? 'No saved Sessions in this project' : 'No saved Sessions yet'}</strong>
              <p>{discovery.pending.length || discoveryPaused || discovery.errors.length ? 'Some conversation sources are still unconfirmed. Completed sources appear here as they are read.'
                : query ? 'Try an Agent name, Session ID, project or a recap already available here.' : scope === 'project' ? 'Switch to All projects to continue work elsewhere.' : 'Your saved Sessions will appear here.'}</p>
              {scope === 'project' ? <button type="button" className="small-button" onClick={() => changeScope('global')}>Browse all projects <ArrowRight size={12} /></button> : null}
            </div> : null}
          </div>
          {selected ? <section className="launcher-resume__detail" aria-label="Selected Session details">
            <div className="launcher-resume__detail-heading"><AgentAvatar label={selected.name} providerId={selected.candidate.providerId} size={24} />
              <div><strong>{selected.name}</strong><span>{selectedProviderLabel === selected.executorName ? selectedProviderLabel : `${selectedProviderLabel} · ${selected.executorName}`}</span></div></div>
            {nativeCandidate ? <div className="launcher-resume__conversation"><h3>Conversation</h3>
              {selectedNativeRead?.state === 'loading' ? <p className="launcher-resume__muted"><LoaderCircle size={12} className="spin" /> Reading this saved conversation…</p> : null}
              {selectedNativeRead?.page ? <>
                {nativeMessages.map((item, index) => <article key={`${nativeSourceKey}:${item.id}`} ref={index === nativeMessages.length - 1 ? nativeLastMessageRef : undefined} className="launcher-resume__message">
                  <ConversationMessage compact content={item.contentParts} messageId={item.id} providerId={selectedNativeRead.page!.source.providerId}
                    name={item.kind === 'user-message' ? 'Input' : 'Assistant'} workspaceRoot={nativeCandidate.workspacePath}
                    nativeResourceRecord={{ source: selectedNativeRead.page!.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
                    readHistoryResource={readNativeResource} />
                </article>)}
                {!nativeMessages.length ? <p className="launcher-resume__muted">No user or assistant messages on this page.</p> : null}
                {selectedNativeRead.page.nextCursor ? <button type="button" className="small-button" disabled={selectedNativeRead.loadingMore}
                  onClick={() => void readOlderNativeMessages()}>{selectedNativeRead.loadingMore ? 'Reading older messages…' : 'Read older messages'}</button> : null}
              </> : null}
              {selectedNativeRead?.error ? <div className="launcher-resume__recap-notice" role="status"><span>Conversation could not be read: {selectedNativeRead.error}. The original conversation and Resume remain available.</span>
                <button type="button" className="small-button" onClick={() => setRecapRetry(value => value + 1)}>Retry conversation</button></div> : null}
            </div> : <div className="launcher-resume__recap"><h3>Recap</h3>
              {selected.recap ? <><p>{selected.recap.text}</p><small>{selected.recap.source} · {selected.recap.origin === 'native' ? 'Provider conversation' : 'Captured conversation'}</small></>
                : selectedRead?.state === 'loading' ? <p className="launcher-resume__muted"><LoaderCircle size={12} className="spin" /> Reading this Session’s recap…</p>
                  : <p className="launcher-resume__muted">No recap available. This Session has no readable conversation excerpt.</p>}
              {!selected.recap && selectedRead?.state === 'error' ? <div className="launcher-resume__recap-notice" role="status">
                <span>Recap could not be read: {selectedRead.error}. Resume remains available.</span>
                <button type="button" className="small-button" onClick={() => setRecapRetry(value => value + 1)}>Retry recap</button>
              </div> : null}
            </div>}
            <dl className="launcher-resume__facts">
              <div><dt>Project</dt><dd>{selected.projectName}{!selected.workspace ? <small>Project is not registered</small> : null}</dd></div>
              <div><dt>Directory</dt><dd className="launcher-resume__path" title={selected.candidate.workspacePath}>{displayPath(selected.candidate.workspacePath, selected.candidate.hostId)}</dd></div>
              <div><dt>Host</dt><dd>{selected.hostName}{selected.hostName !== selected.candidate.hostId ? <small>{selected.candidate.hostId}</small> : null}</dd></div>
              <div><dt>{'native' in selected.candidate ? 'Provider Session ID' : 'Session ID'}</dt><dd><code>{launcherCandidateIdentity(selected.candidate)}</code></dd></div>
              {!('native' in selected.candidate) && selected.candidate.nativeSessionId ? <div><dt>Provider Session ID</dt><dd><code>{selected.candidate.nativeSessionId}</code></dd></div> : null}
              <div><dt>Last active</dt><dd><Clock3 size={11} aria-hidden="true" /><time dateTime={new Date(selected.candidate.updatedAt).toISOString()}>{new Date(selected.candidate.updatedAt).toLocaleString()}</time></dd></div>
            </dl>
            <div className="launcher-resume__state" role="status"><strong>{selected.stateLabel}</strong><p>{selected.stateDetail}</p></div>
            {!selectedHostConfigured ? <div className="launcher-resume__state" role="status"><strong>Host is not configured</strong><p>Configure this Session’s original Host to open its project.</p>
              {settings ? <button type="button" className="small-button" onClick={() => { setOpen(false); settings.open('hosts') }}>Configure Host</button> : null}</div> : null}
          </section> : null}
        </div>
        {discovery.pending.length || discoveryPaused ? <div className="launcher-resume__discovery" role="status">
          <div><span>{discoveryPaused ? 'Discovery updates paused' : <><LoaderCircle size={12} className="spin" /> Reading saved conversations</>} · {discovery.total - discovery.pending.length}/{discovery.total} sources checked</span>
            <button type="button" className="small-button" onClick={() => { if (discoveryPaused) { setDiscoveryPaused(false); setDiscoveryRetry(value => value + 1) } else setDiscoveryPaused(true) }}>
              {discoveryPaused ? 'Refresh discovery' : 'Pause updates'}</button></div>
          <details><summary>{discovery.pending.length} {discovery.pending.length === 1 ? 'source' : 'sources'} still unconfirmed · Listed Sessions remain available</summary>
            <ul>{discovery.pending.map(input => <li key={launcherDiscoveryKey(input)}>{config?.hosts.find(host => host.id === input.hostId)?.label ?? input.hostId} · {config?.executors[input.executorId]?.label ?? input.executorId}</li>)}</ul></details>
        </div> : null}
        {discovery.errors.length ? <div className="launcher-resume__feedback launcher-resume__catalog-notice" role="status">
          <details><summary><strong>{discovery.errors.length} discovery {discovery.errors.length === 1 ? 'notice' : 'notices'}</strong><span> · Listed Sessions remain available</span></summary>
            {discovery.errors.map((error, index) => <p key={index}>{error}</p>)}
          </details><button type="button" className="small-button" onClick={() => { setDiscoveryPaused(false); setDiscoveryRetry(value => value + 1) }}>Retry discovery</button>
        </div> : null}
        {feedback ? <div className="launcher-resume__feedback" role="status"><strong>{feedback.outcome === 'restored' ? 'Session restored' : 'Restoring this Session did not complete'} · {feedback.name}</strong><code>{feedback.id}</code><p>{feedback.text}</p></div> : null}
        <footer className="launcher-resume__footer"><span>{filtered.length} {filtered.length === 1 ? 'Session' : 'Sessions'}{workspace && scope === 'project' ? ` · ${workspace.name}` : ' · all projects'}</span>
          <button type="button" className="primary-button" disabled={!selected || busyId !== null || disabled}
            onClick={() => selected && void resume(selected)}>
            {busyId ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}
            {busyId ? 'Restoring…' : selectedSession?.status.continuityConflict === 'session-run-changed' ? 'Open current Session' : selected && !selected.workspace && selectedHostConfigured ? 'Open project & resume' : 'Resume Session'}
          </button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
