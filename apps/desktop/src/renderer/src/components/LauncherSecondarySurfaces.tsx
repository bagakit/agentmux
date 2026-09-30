import { ArrowUpRight, ChevronDown, Globe2, LoaderCircle, Minus, NotebookPen, SquareTerminal, X } from 'lucide-react'
import type { SessionSnapshot, TerminalThemeId, WorkspaceRecord } from '../../../shared/contracts'
import { DESKTOP_ACTIONS } from '../../../shared/desktop-actions'
import { useAppStore } from '../store'
import { EMPTY_LAUNCHER_DRAFT, useLauncherState, type LauncherSection, type LauncherSectionMode } from '../lib/launcher-state'
import { InlineComposer } from './InlineComposer'
import { useEffect, useRef, useState } from 'react'
import { BrowserAddressInput, type BrowserAddressInputHandle } from './BrowserAddressInput'
import { TerminalView } from './TerminalView'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'

type UtilityKind = 'terminal' | 'browser' | 'note'
export function LauncherSecondarySurfaces({ workspace, tabGroupId, launcherRef, launcherId, sections, onSectionChange, warmSession, warmPending, terminalThemeId, terminalFontSize, visible, busy, onRun }: {
  workspace: WorkspaceRecord | undefined
  tabGroupId: string
  launcherRef: { tabId: string; regionId: string } | undefined
  launcherId: string
  sections: Record<LauncherSection, LauncherSectionMode>
  onSectionChange(section: LauncherSection, mode: LauncherSectionMode): void
  warmSession: SessionSnapshot | null
  warmPending: boolean
  terminalThemeId: TerminalThemeId | undefined
  terminalFontSize: number
  visible: boolean
  busy: UtilityKind | 'agent' | null
  onRun(kind: UtilityKind, action: () => Promise<unknown>): Promise<void>
}) {
  const draft = useLauncherState(state => state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT)
  const writeDraft = useLauncherState(state => state.setDraft)
  const promoteWarmTerminal = useAppStore(state => state.promoteWarmTerminal)
  const createBrowser = useAppStore(state => state.createBrowser)
  const createNote = useAppStore(state => state.createNote)
  const revealCreatedNote = useAppStore(state => state.revealCreatedNote)
  const retryCreatedNote = useAppStore(state => state.retryCreatedNote)
  const projection = useWorkbenchBrowserPresentation().projection
  const browserInput = useRef<BrowserAddressInputHandle>(null)
  const [browserClosing, setBrowserClosing] = useState(false)
  const browserCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const browserRow = useRef<HTMLElement>(null)
  function cancelBrowserClose() {
    if (browserCloseTimer.current) clearTimeout(browserCloseTimer.current)
    browserCloseTimer.current = null
    setBrowserClosing(false)
  }
  // Only the short visual exit is local. The existing section owner receives the final intent.
  function collapseBrowser() {
    cancelBrowserClose()
    onSectionChange('browser', 'collapsed')
    if (!visible || browserRow.current?.closest('[hidden], [inert]') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    setBrowserClosing(true)
    browserCloseTimer.current = setTimeout(() => {
      browserCloseTimer.current = null
      setBrowserClosing(false)
    }, 180)
  }
  useEffect(() => {
    cancelBrowserClose()
    return () => { if (browserCloseTimer.current) clearTimeout(browserCloseTimer.current) }
  }, [workspace?.id, launcherId, visible])
  useEffect(() => { if (sections.browser !== 'collapsed') cancelBrowserClose() }, [sections.browser])
  const [inputHistoryNotice, setInputHistoryNotice] = useState<string | null>(null)
  function setDraft(field: 'browser' | 'note', value: string) { writeDraft(launcherId, field, value) }
  const disabled = !workspace || busy !== null
  function openTerminal() { void onRun('terminal', () => promoteWarmTerminal(tabGroupId, launcherRef)) }
  function openBrowser(submittedAddress: string) { void onRun('browser', () => createBrowser(tabGroupId, launcherRef, submittedAddress.trim() || 'about:blank')) }
  function openNote(content?: string) {
    void onRun('note', async () => {
      const references = projection?.selection.filter(reference => reference.displayWorkspaceId === projection.displayWorkspaceId && reference.tabId === launcherRef?.tabId && reference.regionId === launcherRef.regionId)
      if (projection && references?.length !== 1) throw new Error('The exact Note display Group is unconfirmed. Its original draft is retained.')
      const receipt = await createNote(projection ? references![0]!.groupId : tabGroupId, launcherRef, content, projection)
      // A late result must not consume an edit the user made while the note was saving.
      if (receipt.status === 'written' && receipt.revealed && content !== undefined && useLauncherState.getState().drafts[launcherId]?.note === content) setDraft('note', '')
    })
  }
  function recoverNote(retry: boolean) {
    void onRun('note', async () => {
      const receipt = await (retry ? retryCreatedNote(launcherId, projection) : revealCreatedNote(launcherId, projection))
      if (receipt?.status === 'written' && receipt.revealed && useLauncherState.getState().drafts[launcherId]?.note === receipt.draft) setDraft('note', '')
    })
  }
  const labels = { terminal: 'Terminal', browser: 'Browser', note: 'Note' }
  const icons = { terminal: SquareTerminal, browser: Globe2, note: NotebookPen }
  const actions = { terminal: openTerminal, note: () => openNote() }
  function header(kind: UtilityKind) {
    const Icon = icons[kind], expanded = sections[kind] === 'expanded'
    return <header className="launcher-utility__head">
      <span><Icon size={14} /><strong>{labels[kind]}</strong>{kind === 'terminal' && expanded ? <small>{warmSession ? 'Reusable shell' : warmPending ? 'Warming shell…' : 'Shell not attached'}</small> : null}</span>
      <span className="launcher-section-actions">
        {kind !== 'browser' ? <button type="button" className="icon-button" disabled={disabled} aria-label={kind === 'note' ? 'Create note' : kind === 'terminal' && warmSession ? 'Open reusable Terminal in tab' : `Open ${labels[kind]}`}
          title={kind === 'note' ? 'Open blank note' : 'Open in tab'} data-agentmux-action={kind === 'terminal' ? DESKTOP_ACTIONS.claimReusableTerminal : DESKTOP_ACTIONS.createNote}
          data-agentmux-session-id={kind === 'terminal' ? warmSession?.id : undefined} onClick={actions[kind]}>{busy === kind ? <LoaderCircle size={13} className="spin" /> : <ArrowUpRight size={13} />}</button> : null}
        <button type="button" className="icon-button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${labels[kind]}`} title={expanded ? 'Collapse' : 'Expand'} onClick={() => onSectionChange(kind, expanded ? 'collapsed' : 'expanded')}>{expanded ? <Minus size={13} /> : <ChevronDown size={13} />}</button>
        <button type="button" className="icon-button" aria-label={`Close ${labels[kind]}`} title={`Close ${labels[kind]}`} onClick={() => onSectionChange(kind, 'hidden')}><X size={13} /></button>
      </span>
    </header>
  }
  return <>
    <div className="launch-surface__alt">
      <div className="launch-surfaces-stack">
        {sections.terminal !== 'hidden' ? <section className="launcher-utility launch-terminal" data-section="terminal" data-mode={sections.terminal}>
          {header('terminal')}
          {sections.terminal === 'expanded' ? warmSession && terminalThemeId && workspace ? <div className="launch-terminal__body"><TerminalView session={warmSession} themeId={terminalThemeId} fontSize={terminalFontSize} interactiveResize={false} visible={visible} autoFocus={false} linkOrigin={{ workspaceId: workspace.id, tabGroupId }} /></div> : <div className="launcher-terminal-pending"><span>{warmPending ? 'Preparing a reusable host shell…' : 'The shell preview is not available.'}</span><button type="button" className="small-button" disabled={disabled} onClick={openTerminal}>Open Terminal<ArrowUpRight size={12} /></button></div> : null}
        </section> : null}
        <div className="launch-surface-quick-grid">
          {sections.browser !== 'hidden' ? <section ref={browserRow} className="launcher-utility launcher-browser" data-section="browser" data-mode={sections.browser} data-closing={browserClosing || undefined}>
            {sections.browser === 'expanded' || browserClosing ? <form className="launcher-browser-input" onSubmit={event => { event.preventDefault(); if (!disabled && !browserClosing) browserInput.current?.submit() }}><Globe2 size={15} aria-label="Browser" /><span className="launcher-browser-field" inert={browserClosing}><BrowserAddressInput ref={browserInput} aria-label="Browser address or search" value={draft.browser} disabled={busy === 'browser' || browserClosing} submitDisabled={disabled || browserClosing} placeholder="Search or enter a URL" historyTarget={workspace ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => setDraft('browser', value)} onSubmit={openBrowser} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} /></span><button type="submit" className="icon-button" disabled={disabled || browserClosing} data-agentmux-action={DESKTOP_ACTIONS.openBrowser} aria-label="Go to Browser address or search" title="Open address or search"><ArrowUpRight size={14} /></button><span className="launcher-section-actions"><button type="button" className="icon-button" aria-label="Collapse Browser" title="Collapse Browser" onClick={collapseBrowser}><Minus size={13} /></button><button type="button" className="icon-button" aria-label="Close Browser" title="Close Browser" onClick={() => { cancelBrowserClose(); onSectionChange('browser', 'hidden') }}><X size={13} /></button></span></form> : header('browser')}
            {inputHistoryNotice ? <p className="launcher-persistence-notice" role="status">{inputHistoryNotice}</p> : null}
          </section> : null}
          {sections.note !== 'hidden' ? <section className="launcher-utility" data-section="note" data-mode={sections.note}>{header('note')}
            {sections.note === 'expanded' ? <><div className="composer launcher-note-composer"><InlineComposer aria-label="Note draft" value={draft.note} onValueChange={value => setDraft('note', value)} disabled={false} autoFocus={false} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !disabled) { event.preventDefault(); openNote(draft.note) } }} placeholder="Capture a thought…" /></div><footer className="launcher-note-actions"><span>Note · {workspace?.name ?? 'Current workspace'}</span><button type="button" className="small-button" disabled={disabled} onClick={() => openNote(draft.note)}>{busy === 'note' ? 'Saving…' : 'Save & open note'}<ArrowUpRight size={12} /></button></footer></> : null}
            {draft.noteCreation && !draft.noteCreation.revealed ? <div role="status" className="launcher-persistence-notice"><span>{draft.noteCreation.issue ?? 'The Note creation result is awaiting confirmation. Its original identity and draft remain retained.'}</span>{draft.noteCreation.status === 'error' ? <button type="button" className="small-button" disabled={disabled} onClick={() => recoverNote(true)}>Retry same Note</button> : draft.noteCreation.path ? <button type="button" className="small-button" disabled={disabled} onClick={() => recoverNote(false)}>Check / open same Note</button> : null}</div> : null}
          </section> : null}
        </div>
      </div>
    </div>
    {(['terminal', 'browser', 'note'] as const).some(kind => sections[kind] === 'hidden') ? <div className="launcher-restores" aria-label="Restore hidden surfaces">{(['terminal', 'browser', 'note'] as const).filter(kind => sections[kind] === 'hidden').map(kind => { const Icon = icons[kind]; return <button type="button" className="launcher-restore" key={kind} aria-label={`Restore ${labels[kind]}`} onClick={() => onSectionChange(kind, 'expanded')}><Icon size={14} />{labels[kind]}<ChevronDown size={12} /></button> })}</div> : null}
  </>
}
