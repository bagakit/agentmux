import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Check, ChevronDown, Clock3, FolderOpen, LoaderCircle, RotateCcw, Search, X } from 'lucide-react'
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentTimelineSnapshot, SessionSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { useAppStore } from '../store'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import { formatRelativeAge } from '../lib/relative-age'
import { filterLauncherResumeRows, launcherNativeRecap, launcherResumeRows, launcherResumeShortId, launcherTimelineRecap, type LauncherRecap, type LauncherResumeRow } from '../lib/launcher-resume'
import { agentProviderLabel } from './AgentProviderIcon'
import { AgentAvatar } from './AgentAvatar'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { SettingsNavigation } from './SettingsNavigation'

type RecapRead = { state: 'loading' | 'ready' | 'error'; recap: LauncherRecap | null; error?: string }
type RecoveryFeedback = { id: string; name: string; outcome: 'failed' | 'restored'; text: string }
const EMPTY_CANDIDATES: ReturnType<typeof useAppStore.getState>['recoveryCandidates'] = []
const EMPTY_ROWS: LauncherResumeRow[] = []
const EMPTY_FACTS = { timelines: {} as Record<string, AgentTimelineSnapshot>, sessions: [] as SessionSnapshot[], names: {} as Record<string, string> }

export function LauncherResumePicker({ workspace, disabled = false }: { workspace?: WorkspaceRecord | undefined; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const config = useAppStore(state => open ? state.config : null)
  const candidates = useAppStore(state => open ? state.recoveryCandidates : EMPTY_CANDIDATES)
  const [facts, setFacts] = useState(EMPTY_FACTS)
  const recoverSession = useAppStore(state => state.recoverSession)
  const settings = useContext(SettingsNavigation)
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reads, setReads] = useState<Record<string, RecapRead>>({})
  const [recapRetry, setRecapRetry] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<RecoveryFeedback | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const requestOwner = useRef(0)
  const selectionOwner = useRef<string | undefined>(undefined)
  const listId = useId()
  const rows = useMemo(() => open ? launcherResumeRows({
    candidates, config, workspace, timelines: facts.timelines, agentNames: facts.names, sessions: facts.sessions,
    nativeRecaps: Object.fromEntries(Object.entries(reads).map(([id, read]) => [id, read.recap]))
  }) : EMPTY_ROWS, [open, candidates, config, workspace, facts, reads])
  const filtered = useMemo(() => filterLauncherResumeRows(rows, scope, query), [rows, scope, query])
  const savedSelection = filtered.find(row => row.candidate.agentSessionId === selectedId) ?? filtered[0]
  const selectedSessionId = savedSelection?.candidate.agentSessionId
  const selectedHostId = savedSelection?.candidate.hostId
  selectionOwner.current = selectedSessionId
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
  const selected = useMemo(() => savedSelection && selectedSessionId ? launcherResumeRows({
    candidates: [savedSelection.candidate], config, workspace,
    timelines: selectedTimeline ? { [selectedSessionId]: selectedTimeline } : facts.timelines,
    agentNames: selectedName === undefined ? {} : { [selectedSessionId]: selectedName },
    sessions: selectedSession ? [selectedSession] : savedSession ? [savedSession] : [],
    nativeRecaps: { [selectedSessionId]: reads[selectedSessionId]?.recap }
  })[0] : undefined, [savedSelection, selectedSessionId, config, workspace, selectedTimeline, selectedName, selectedSession, savedSession, facts.timelines, reads])
  const selectedTimelineRecap = selectedSessionId ? launcherTimelineRecap(selectedTimeline ?? facts.timelines[selectedSessionId]) : null
  const projectCount = rows.filter(row => row.inProject).length
  const selectedHostConfigured = Boolean(config?.hosts.some(host => host.id === selectedHostId))
  const selectedRead = selectedSessionId ? reads[selectedSessionId] : undefined
  const selectedProviderLabel = selected ? agentProviderLabel(selected.candidate.providerId) : ''

  // Opening takes one candidate-only snapshot for search. Subsequent live work is owned by the
  // selected detail, through exact-key selectors and one-row derivation. An unrelated Timeline
  // append never rebuilds the list; a closed launcher never observes conversation bodies/details.
  // Only this visible selection owns a bounded native conversation read. Leaving the dialog or
  // choosing another Session discards its reply; recap failure never gates attachment/resume.
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
    setOpen(value)
    if (value) {
      const state = useAppStore.getState()
      const ids = new Set(state.recoveryCandidates.map(candidate => candidate.agentSessionId))
      setFacts({
        timelines: Object.fromEntries([...ids].flatMap(id => state.timelines[id] ? [[id, state.timelines[id]!]] : [])),
        names: Object.fromEntries([...ids].flatMap(id => state.agentNames[id] ? [[id, state.agentNames[id]!]] : [])),
        sessions: state.sessions.filter(session => ids.has(session.id))
      })
      setScope('project'); setQuery(''); setSelectedId(null); setFeedback(null)
    } else setFacts(EMPTY_FACTS)
  }

  function choose(id: string) { setSelectedId(id); setFeedback(null) }

  async function resume(row: LauncherResumeRow) {
    if (busyId || disabled) return
    const id = row.candidate.agentSessionId
    const fail = (text: string) => setFeedback({ id, name: row.name, outcome: 'failed', text })
    setBusyId(id); setFeedback(null)
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
      const before = useAppStore.getState()
      const current = before.sessions.find(session => session.id === id)
      if (current) before.selectSession(id)
      // Core can report that this stable Session already owns a newer Run. Re-read that exact
      // identity instead of retrying the obsolete Run or starting a replacement Agent.
      if (current?.status.continuityConflict === 'session-run-changed') await before.refreshSession(id)
      const recovered = await recoverSession(id, crypto.randomUUID())
      if (recovered) {
        if (selectionOwner.current === id) setOpen(false)
        else setFeedback({ id, name: row.name, outcome: 'restored', text: 'This saved Session was restored in its original project. Its current Run remains available.' })
        return
      }
      const state = useAppStore.getState()
      fail(state.sessions.find(session => session.id === id)?.status.detail
        ?? 'Recovery did not confirm a current Run. The saved Session is kept; retry to check attachment or resume.')
    } catch (cause) {
      fail(`${presentError(cause)}. The saved Session and its project are kept. Retry this same Session to check attachment or resume.`)
    } finally { setBusyId(null) }
  }

  function moveSelection(step: number) {
    if (!filtered.length) return
    const current = filtered.findIndex(row => row.candidate.agentSessionId === selectedSessionId)
    const next = filtered[(current + step + filtered.length) % filtered.length]!
    choose(next.candidate.agentSessionId)
    document.getElementById(`${listId}-${next.candidate.agentSessionId}`)?.scrollIntoView?.({ block: 'nearest' })
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
            <button type="button" aria-pressed={scope === 'project'} onClick={() => { setScope('project'); setSelectedId(null); setFeedback(null) }}>
              This project <span>{projectCount}</span>
            </button>
            <button type="button" aria-pressed={scope === 'global'} onClick={() => { setScope('global'); setSelectedId(null); setFeedback(null) }}>
              All projects <span>{rows.length}</span>
            </button>
          </div>
          <label className="launcher-resume__search"><Search size={14} aria-hidden="true" />
            <input ref={searchRef} aria-label="Search saved Sessions" role="combobox" aria-expanded="true"
              aria-controls={listId} aria-activedescendant={selectedSessionId ? `${listId}-${selectedSessionId}` : undefined}
              placeholder="Search recap, Agent, ID or project…" value={query} onChange={event => { setQuery(event.target.value); setSelectedId(null); setFeedback(null) }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1) }
                if (event.key === 'Enter' && selected) { event.preventDefault(); void resume(selected) }
              }} />
            {query ? <button type="button" className="icon-button" aria-label="Clear Session search" onClick={() => { setQuery(''); searchRef.current?.focus() }}><X size={12} /></button> : null}
          </label>
        </div>
        <div className="launcher-resume__body">
          <div className="launcher-resume__list" id={listId} role="listbox" aria-label="Saved Sessions">
            {filtered.map(savedRow => {
              const row = selected?.candidate.agentSessionId === savedRow.candidate.agentSessionId ? selected : savedRow
              const candidate = row.candidate
              const active = selectedSessionId === candidate.agentSessionId
              return <button type="button" role="option" aria-selected={active} className="launcher-resume__row"
                id={`${listId}-${candidate.agentSessionId}`} key={candidate.agentSessionId} onClick={() => choose(candidate.agentSessionId)}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1); searchRef.current?.focus() }
                }}>
                <span className="launcher-resume__row-head"><AgentAvatar label={row.name} providerId={candidate.providerId} size={18} />
                  <strong>{row.name}</strong>{active ? <Check size={12} aria-hidden="true" /> : null}</span>
                <span className={`launcher-resume__row-recap${row.recap ? '' : ' launcher-resume__row-recap--unknown'}`}>
                  {row.recap?.text ?? 'No recap available'}</span>
                <span className="launcher-resume__row-meta"><span>{row.executorName} · {row.projectName}</span>
                  <time dateTime={new Date(candidate.updatedAt).toISOString()} title={new Date(candidate.updatedAt).toLocaleString()}>{formatRelativeAge(Date.now() - candidate.updatedAt, ' ago')}</time></span>
                <span className="launcher-resume__row-identity"><span>{row.hostName}</span><code title={candidate.agentSessionId}>#{launcherResumeShortId(candidate.agentSessionId, candidates)}</code><span>{row.stateLabel}</span></span>
              </button>
            })}
            {!filtered.length ? <div className="launcher-resume__empty"><FolderOpen size={23} aria-hidden="true" />
              <strong>{query ? 'No matching Sessions' : scope === 'project' ? 'No saved Sessions in this project' : 'No saved Sessions yet'}</strong>
              <p>{query ? 'Try an Agent name, Session ID or project.' : scope === 'project' ? 'Switch to All projects to continue work elsewhere.' : 'Sessions with retained Core identities will appear here.'}</p>
              {scope === 'project' ? <button type="button" className="small-button" onClick={() => setScope('global')}>Browse all projects <ArrowRight size={12} /></button> : null}
            </div> : null}
          </div>
          {selected ? <section className="launcher-resume__detail" aria-label="Selected Session details">
            <div className="launcher-resume__detail-heading"><AgentAvatar label={selected.name} providerId={selected.candidate.providerId} size={24} />
              <div><strong>{selected.name}</strong><span>{selectedProviderLabel === selected.executorName ? selectedProviderLabel : `${selectedProviderLabel} · ${selected.executorName}`}</span></div></div>
            <div className="launcher-resume__recap"><h3>Recap</h3>
              {selected.recap ? <><p>{selected.recap.text}</p><small>{selected.recap.source} · {selected.recap.origin === 'native' ? 'Provider conversation' : 'Captured conversation'}</small></>
                : selectedRead?.state === 'loading' ? <p className="launcher-resume__muted"><LoaderCircle size={12} className="spin" /> Reading this Session’s recap…</p>
                  : <p className="launcher-resume__muted">No recap available. This Session has no readable conversation excerpt.</p>}
              {!selected.recap && selectedRead?.state === 'error' ? <div className="launcher-resume__recap-notice" role="status">
                <span>Recap could not be read: {selectedRead.error}. Resume remains available.</span>
                <button type="button" className="small-button" onClick={() => setRecapRetry(value => value + 1)}>Retry recap</button>
              </div> : null}
            </div>
            <dl className="launcher-resume__facts">
              <div><dt>Project</dt><dd>{selected.projectName}{!selected.workspace ? <small>Project is not registered</small> : null}</dd></div>
              <div><dt>Directory</dt><dd className="launcher-resume__path">{selected.candidate.workspacePath}</dd></div>
              <div><dt>Host</dt><dd>{selected.hostName}{selected.hostName !== selected.candidate.hostId ? <small>{selected.candidate.hostId}</small> : null}</dd></div>
              <div><dt>Session ID</dt><dd><code>{selected.candidate.agentSessionId}</code></dd></div>
              <div><dt>Last active</dt><dd><Clock3 size={11} aria-hidden="true" /><time dateTime={new Date(selected.candidate.updatedAt).toISOString()}>{new Date(selected.candidate.updatedAt).toLocaleString()}</time></dd></div>
            </dl>
            <div className="launcher-resume__state" role="status"><strong>{selected.stateLabel}</strong><p>{selected.stateDetail}</p></div>
            {!selectedHostConfigured ? <div className="launcher-resume__state" role="status"><strong>Host is not configured</strong><p>Configure this Session’s original Host to open its project.</p>
              {settings ? <button type="button" className="small-button" onClick={() => { setOpen(false); settings.open('hosts') }}>Configure Host</button> : null}</div> : null}
          </section> : null}
        </div>
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
