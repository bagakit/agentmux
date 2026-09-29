import { ArrowUpRight, ChevronDown, Globe2, LoaderCircle, Minus, NotebookPen, SquareTerminal, X } from 'lucide-react'
import type { SessionSnapshot, TerminalThemeId, WorkspaceRecord } from '../../../shared/contracts'
import { DESKTOP_ACTIONS } from '../../../shared/desktop-actions'
import { useAppStore } from '../store'
import { EMPTY_LAUNCHER_DRAFT, useLauncherState, type LauncherSection, type LauncherSectionMode } from '../lib/launcher-state'
import { InlineComposer } from './InlineComposer'
import { TerminalView } from './TerminalView'

type UtilityKind = 'terminal' | 'browser' | 'note'
export function LauncherSecondarySurfaces({ workspace, tabGroupId, launcherRef, launcherId, sections, onSectionChange, warmSession, warmPending, terminalThemeId, terminalFontSize, visible, busy, onRun, onStorageIssue }: {
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
  onStorageIssue(): void
}) {
  const draft = useLauncherState(state => state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT)
  const writeDraft = useLauncherState(state => state.setDraft)
  const promoteWarmTerminal = useAppStore(state => state.promoteWarmTerminal)
  const createBrowser = useAppStore(state => state.createBrowser)
  const createNote = useAppStore(state => state.createNote)
  function setDraft(field: 'browser' | 'note', value: string) { if (!writeDraft(launcherId, field, value)) onStorageIssue() }
  const disabled = !workspace || busy !== null
  function openTerminal() { void onRun('terminal', () => promoteWarmTerminal(tabGroupId, launcherRef)) }
  function openBrowser() { void onRun('browser', () => createBrowser(tabGroupId, launcherRef, draft.browser.trim() || 'about:blank')) }
  function openNote(content?: string) {
    void onRun('note', async () => {
      await createNote(tabGroupId, launcherRef, content)
      // A late result must not consume an edit the user made while the note was saving.
      if (content !== undefined && useLauncherState.getState().drafts[launcherId]?.note === content) setDraft('note', '')
    })
  }
  const labels = { terminal: 'Terminal', browser: 'Browser', note: 'Note' }
  const icons = { terminal: SquareTerminal, browser: Globe2, note: NotebookPen }
  const actions = { terminal: openTerminal, browser: openBrowser, note: () => openNote() }
  function header(kind: UtilityKind) {
    const Icon = icons[kind], expanded = sections[kind] === 'expanded'
    return <header className="launcher-utility__head">
      <span><Icon size={14} /><strong>{labels[kind]}</strong>{kind === 'terminal' && expanded ? <small>{warmSession ? 'Reusable shell' : warmPending ? 'Warming shell…' : 'Shell not attached'}</small> : null}</span>
      <span className="launcher-section-actions">
        <button type="button" className="icon-button" disabled={disabled} aria-label={kind === 'note' ? 'Create note' : kind === 'terminal' && warmSession ? 'Open reusable Terminal in tab' : `Open ${labels[kind]}`}
          title={kind === 'note' ? 'Open blank note' : 'Open in tab'} data-agentmux-action={kind === 'terminal' ? DESKTOP_ACTIONS.claimReusableTerminal : kind === 'browser' ? DESKTOP_ACTIONS.openBrowser : DESKTOP_ACTIONS.createNote}
          data-agentmux-session-id={kind === 'terminal' ? warmSession?.id : undefined} onClick={actions[kind]}>{busy === kind ? <LoaderCircle size={13} className="spin" /> : <ArrowUpRight size={13} />}</button>
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
          {sections.browser !== 'hidden' ? <section className="launcher-utility" data-section="browser" data-mode={sections.browser}>{header('browser')}
            {sections.browser === 'expanded' ? <form className="launcher-browser-input" onSubmit={event => { event.preventDefault(); if (!disabled) openBrowser() }}><Globe2 size={14} /><input aria-label="Browser address or search" value={draft.browser} disabled={busy === 'browser'} placeholder="Search or enter a URL" onChange={event => setDraft('browser', event.target.value)} /><button type="submit" className="icon-button" disabled={disabled} aria-label="Go to Browser address or search" title="Open address or search"><ArrowUpRight size={14} /></button></form> : null}
          </section> : null}
          {sections.note !== 'hidden' ? <section className="launcher-utility" data-section="note" data-mode={sections.note}>{header('note')}
            {sections.note === 'expanded' ? <><div className="composer launcher-note-composer"><InlineComposer aria-label="Note draft" value={draft.note} onValueChange={value => setDraft('note', value)} disabled={false} autoFocus={false} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && !disabled) { event.preventDefault(); openNote(draft.note) } }} placeholder="Capture a thought…" /></div><footer className="launcher-note-actions"><span>Markdown · {workspace?.name ?? 'Current workspace'}</span><button type="button" className="small-button" disabled={disabled} onClick={() => openNote(draft.note)}>{busy === 'note' ? 'Saving…' : 'Save & open note'}<ArrowUpRight size={12} /></button></footer></> : null}
          </section> : null}
        </div>
      </div>
    </div>
    {(['terminal', 'browser', 'note'] as const).some(kind => sections[kind] === 'hidden') ? <div className="launcher-restores" aria-label="Restore hidden surfaces">{(['terminal', 'browser', 'note'] as const).filter(kind => sections[kind] === 'hidden').map(kind => { const Icon = icons[kind]; return <button type="button" className="launcher-restore" key={kind} aria-label={`Restore ${labels[kind]}`} onClick={() => onSectionChange(kind, 'expanded')}><Icon size={14} />{labels[kind]}<ChevronDown size={12} /></button> })}</div> : null}
  </>
}
