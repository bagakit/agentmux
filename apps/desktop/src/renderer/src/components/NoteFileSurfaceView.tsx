import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { NoteSharedFileEditing } from './NoteSharedFileEditing'
import { noteShareUndoRecoveryMessage } from '../lib/note-share-removal'
import { noteHistoryReadParams } from '../lib/note-history-target'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { useShallow } from 'zustand/react/shallow'
import type { AgentMuxSpaceLocation } from '@agentmux/core/control'
import { groupIds, regionIds } from '@agentmux/layout'
import { editorSaveAction } from '../lib/editor-save-shortcut'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { regionCaretFocusTargets } from '../lib/region-focus'
import { loadedNoteFiles, noteFilesFromDocuments, noteKnowledge, parseNoteFile, type NoteSource } from '../lib/note-knowledge'
import { noteDirectorySourceFacts, noteDirectorySourceKey } from '../lib/note-directory-sources'
import { noteBlockSelectionKey } from '../lib/note-block-selection'
import { spatialCatalog } from '../lib/space-agent-control'
import { surveyInitialZoneSelection, surveySelectReference } from '../lib/survey-workface'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { NoteFileView } from './NoteFileView'
import { noteReadingStyle } from '../lib/note-reading-style'
import { openNotebookFile } from '../lib/recall-notebooks'
import type { NoteFileTarget } from '../lib/file-document-consumers'
import { noteReadingReferenceIsSelected, rememberNoteReadingReturn } from '../lib/note-reading-return'
import { NoteReadingReturn } from './NoteReadingReturn'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { useNotebookLibrary } from '../lib/notebook-library'
import { useNoteSourceTitle } from '../lib/note-source-name'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { setNoteComposition } from '../lib/note-live-merge'

type SourceChoice = { source: NoteSource; blockId: string; location: AgentMuxSpaceLocation; displayName: string; tabName: string; position: string }
const SourceScopeIcon = semanticIconComponent('status.unknown')

/** Rich presentation on the original File surface and its original update/save/reveal owner. */
export function NoteFileSurfaceView({ tabId, surface, visible = true }: { tabId: string; surface: FileWorkbenchSurface; visible?: boolean }) {
  const ownerDocument = useWorkbenchDocument()
  const key = documentKey(surface.workspaceId, surface.path)
  const presentationId = useId(), occurrence = `${surface.regionId}/${presentationId}`
  const presentation = useWorkbenchBrowserPresentation()
  // A passive visible preview reads the original content without claiming input.
  // Retain the original editor without deriving a global graph for a hidden projection.
  // Pending input still finishes in its original owner; visibility does not cancel a save.
  const displayed = useRef<{ key: string; document: import('../../../shared/contracts').FileDocument | undefined; notes: ReturnType<typeof noteFilesFromDocuments> }>({ key, document: undefined, notes: {} })
  const compositionChanged = useCallback((active: boolean) => setNoteComposition(key, occurrence, active), [key, occurrence])
  useEffect(() => () => setNoteComposition(key, occurrence, false), [key, occurrence])
  const document = useAppStore(state => visible || displayed.current.key !== key ? state.documents[key] : displayed.current.document)
  const dirty = useAppStore(state => Boolean(state.dirtyDocuments[key]))
  const saving = useAppStore(state => Boolean(state.savingDocuments[key]))
  const sharedUndoIssue = useAppStore(state => state.documents[key]?.noteEditing?.shareUndo ? state.documentIssues[key] : undefined)
  const notes = useAppStore(useShallow(state => visible || displayed.current.key !== key ? noteFilesFromDocuments(state.documents) : displayed.current.notes))
  if (visible || displayed.current.key !== key) displayed.current = { key, document, notes }
  const knowledge = useMemo(() => noteKnowledge(loadedNoteFiles(notes), 'partial'), [notes])
  const directory = useAppStore(state => state.noteDirectorySources[noteDirectorySourceKey(surface.workspaceId, surface.path)])
  const config = useAppStore(state => state.config)
  const fileRevision = useAppStore(state => state.workspaceFileRevisions[surface.workspaceId] ?? 0)
  const directoryIssues = useAppStore(useShallow(state => (directory?.paths ?? []).map(path => state.documentIssues[documentKey(surface.workspaceId, path)])))
  const directoryFacts = useMemo(() => directory ? noteDirectorySourceFacts(directory, { config, documents: notes,
    workspaceFileRevisions: { [surface.workspaceId]: fileRevision }, documentIssues: Object.fromEntries(directory.paths.map((path, index) => [documentKey(surface.workspaceId, path), directoryIssues[index]])) }) : null,
    [directory, config, notes, fileRevision, directoryIssues, surface.workspaceId])
  const directoryScope = !directoryFacts ? 'Loaded Notes only' : directoryFacts.status === 'reading' ? 'Checking this directory…'
    : directoryFacts.status === 'unknown' ? 'Directory unconfirmed' : `${directoryFacts.confirmedPaths.length} confirmed in this directory${directoryFacts.status === 'partial' ? ' · partial' : ''}`
  const reveal = useAppStore(state => state.documentRevealTargets[key])
  const focusRequest = useAppStore(state => regionCaretFocusTargets(state.regionCaretFocus, surface.regionId) ? state.regionCaretFocus?.nonce : undefined)
  const update = useAppStore(state => state.updateNoteDocument)
  const blockPresentation = useMemo(() => presentation.tabHostId && presentation.reference ? { tabHostId: presentation.tabHostId,
    reference: { ...presentation.reference, tabId, regionId: surface.regionId } } : undefined, [presentation.tabHostId, presentation.reference, tabId, surface.regionId])
  const restoredBlock = useAppStore(state => blockPresentation ? state.noteBlockSelections[noteBlockSelectionKey(blockPresentation)] : undefined)
  const onSelectedBlock = useCallback((target: import('../../../shared/note-document').NoteBlockTarget) => {
    if (blockPresentation) useAppStore.getState().setNoteBlockSelection(blockPresentation, target)
  }, [blockPresentation])
  const [notice, setNotice] = useState<string | null>(null), [choices, setChoices] = useState<SourceChoice[]>([])
  const sourceName = useNoteSourceTitle()
  const choiceOpener = useRef<HTMLElement | null>(null), restoreChoiceFocus = useRef(false)
  useEffect(() => { setChoices([]); setNotice(null) }, [key])
  const onRevealed = useCallback(() => {
    if (reveal?.noteBlock && blockPresentation) useAppStore.getState().setNoteBlockSelection(blockPresentation, reveal.noteBlock)
    if (useAppStore.getState().documentRevealTargets[key] === reveal) useAppStore.getState().clearDocumentRevealTarget(key)
  }, [key, reveal, blockPresentation])
  const onSave = () => {
    const state = useAppStore.getState(), issue = state.documentIssues[key]
    if (editorSaveAction({ dirty: Boolean(state.dirtyDocuments[key]), saving: Boolean(state.savingDocuments[key]), ...(issue ? { issue: issue.kind } : {}) }) === 'save') void state.saveDocument(tabId, surface.regionId)
  }
  const canFocus = useCallback(() => useAppStore.getState().regionCaretFocus?.nonce === focusRequest, [focusRequest])
  const onFocused = useCallback((nonce: number) => { useAppStore.getState().clearRegionCaretFocus(nonce) }, [])
  async function openUnread(path: string) {
    const state = useAppStore.getState(), reference = blockPresentation?.reference, currentTab = state.tabs[tabId], currentRead = state.noteDirectorySources[noteDirectorySourceKey(surface.workspaceId, surface.path)]
    const resource = state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)
    const layout = reference ? state.layouts[reference.displayWorkspaceId] : undefined
    if (!directory || currentRead !== directory || directory.status !== 'listed' || !directory.paths.includes(path) || !resource || resource.hostId !== directory.hostId || resource.path !== directory.workspacePath ||
      !reference || !currentTab?.space || !layout || !groupIds(layout.root).includes(reference.groupId) || !layout.groups.find(group => group.id === reference.groupId)?.tabOrder.includes(tabId)) {
      setNotice('The original source directory or display position is unconfirmed. The unread path is retained. Restore this position and refresh its sources before opening it.'); return
    }
    try {
      const opened = await state.openFile(path, reference.groupId, undefined, surface.workspaceId, true, { displayWorkspaceId: reference.displayWorkspaceId,
        space: currentTab.space, resource: { hostId: directory.hostId, path: directory.workspacePath }, ...(presentation.projection ? { projection: presentation.projection } : {}) })
      setNotice(opened ? null : 'The source was retained, but its display could not be confirmed. Choose it again after restoring this position.')
    } catch (error) { setNotice(presentError(error)) }
  }
  async function openAt({ source, blockId, location }: SourceChoice) {
    const state = useAppStore.getState(), targetTab = state.tabs[location.tabId], targetRegion = targetTab?.regions[location.regionId]
    const original = state.documents[documentKey(source.location.workspaceId, source.location.path)]
    const resource = state.config?.workspaces.find(workspace => workspace.id === source.location.workspaceId)
    const read = original ? parseNoteFile(original) : null
    const currentSource = original ? noteKnowledge([{ location: source.location, document: original }]).sources[0] : undefined
    if (!resource || !targetTab?.space || targetRegion?.kind !== 'file' || targetRegion.workspaceId !== source.location.workspaceId || targetRegion.path !== source.location.path ||
      read?.status !== 'valid' || read.note.noteId !== source.note.noteId || !currentSource || !currentSource.blocks.has(blockId) && !currentSource.blockForwardings?.some(forwarding => forwarding.blockId === blockId)) {
      setNotice('The original Note resource or display position is no longer confirmed. Its exact target is retained.'); return
    }
    const heldSelection = state.surveyZoneSelection
    const catalog = presentation.projection?.catalog ?? spatialCatalog(state, [])
    if (!catalog.locations.some(candidate => candidate.tabId === location.tabId && candidate.regionId === location.regionId && candidate.displayWorkspaceId === location.displayWorkspaceId && candidate.groupId === location.groupId)) {
      setNotice('The original Note display position is still restoring. Its exact target is retained.'); return
    }
    const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
    const projection = presentation.survey ? {
      entity: { kind: 'zone' as const, zoneId: targetTab.space.zoneId }, presentationId: presentation.projection?.presentationId ?? 'survey',
      displayWorkspaceId: location.displayWorkspaceId, catalog, selection: [reference],
      onSelect() {
        const current = useAppStore.getState()
        if (current.mainSurface !== 'survey' || current.surveyZoneSelection !== heldSelection) return
        const currentCatalog = spatialCatalog(current, [])
        const selection = surveyInitialZoneSelection(currentCatalog, targetTab.space!.zoneId, current.layouts, current.tabs, location.displayWorkspaceId)
        current.setSurveyZoneSelection(surveySelectReference(selection, reference))
      }
    } : undefined
    try {
      const opened = await state.openFile(source.location.path, location.groupId, { line: 1, noteBlock: { noteId: source.note.noteId, blockId } }, source.location.workspaceId, true,
        { displayWorkspaceId: location.displayWorkspaceId, space: targetTab.space, resource: { hostId: resource.hostId, path: resource.path }, reference, ...(projection ? { projection } : {}) })
      if (!opened) { setNotice('The original Note was retained, but its display could not be confirmed. Choose its position again.'); return }
      restoreChoiceFocus.current = false
      setChoices([]); setNotice(null)
    } catch (error) { setNotice(presentError(error)) }
  }
  const onOpen = (source: NoteSource, blockId: string) => {
    const state = useAppStore.getState(), catalog = presentation.projection?.catalog ?? spatialCatalog(state, [])
    const positions = new Map<string, AgentMuxSpaceLocation>()
    for (const location of catalog.locations) {
      const region = state.tabs[location.tabId]?.regions[location.regionId]
      if (region?.kind !== 'file' || region.workspaceId !== source.location.workspaceId || region.path !== source.location.path) continue
      positions.set(JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]), location)
    }
    const exact = [...positions.values()].map(location => {
      const tab = state.tabs[location.tabId]!, layout = state.layouts[location.displayWorkspaceId], groups = layout ? groupIds(layout.root) : []
      const groupIndex = groups.indexOf(location.groupId), viewIndex = regionIds(tab.layout.root).indexOf(location.regionId)
      const tabIndex = layout?.groups.find(group => group.id === location.groupId)?.tabOrder.indexOf(location.tabId) ?? -1
      const contexts = Object.values(useNotebookLibrary.getState().state?.pages ?? {}).filter(page => page.workface?.zoneId === location.zoneId)
      return { source, blockId, location, displayName: contexts.length === 1 ? contexts[0]!.title : state.config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId,
        tabName: tab.name || sourceName(source) || source.location.path, position: `${groupIndex < 0 ? location.groupId : `Panel ${groupIndex + 1}`} · ${tabIndex < 0 ? location.tabId : `Tab ${tabIndex + 1}`} · ${viewIndex < 0 ? location.regionId : `View ${viewIndex + 1}`}` }
    })
    if (!exact.length) { setChoices([]); setNotice('No original Note display position is confirmed yet. The reference and source identity are preserved.'); return }
    const current = blockPresentation?.reference
    const local = current && exact.find(choice => choice.location.displayWorkspaceId === current.displayWorkspaceId && choice.location.groupId === current.groupId &&
      choice.location.tabId === current.tabId && choice.location.regionId === current.regionId)
    if (local) { setChoices([]); setNotice(null); void openAt(local); return }
    if (exact.length > 1) {
      choiceOpener.current = ownerDocument.activeElement?.nodeType === 1 ? ownerDocument.activeElement as HTMLElement : null
      restoreChoiceFocus.current = true
      setNotice(null); setChoices(exact); return
    }
    void openAt(exact[0]!)
  }
  const originalResource = config?.workspaces.find(item => item.id === surface.workspaceId)
  async function openOriginal(target: NoteFileTarget, blockId?: string, signal?: AbortSignal) {
    const state = useAppStore.getState(), reference = blockPresentation?.reference, tab = state.tabs[tabId]
    if (!reference || !tab?.space) throw new Error('The original display position is unconfirmed. The Note link and current draft are kept; restore this position and retry.')
    let placed: import('../lib/workbench-projection').WorkbenchProjectionSelection | undefined
    const original = document && parseNoteFile(document), mapping = state.config?.workspaces.find(value => value.id === surface.workspaceId)
    const opened = await openNotebookFile({ noteId: target.noteId, resource: target }, undefined, reference, blockId ? { noteId: target.noteId, blockId } : undefined,
      { reference, space: tab.space, ...(presentation.projection ? { projection: presentation.projection } : {}), onPlaced: result => { placed = result } }, signal)
    if (!opened) throw new Error('Opening the original file was not confirmed. Your current reading position and exact link are kept; retry when ready.')
    const selected = useAppStore.getState()
    if (!placed || selected.mainSurface !== state.mainSurface || !noteReadingReferenceIsSelected(selected, placed))
      throw new Error('The original file was read, but its display position was not confirmed. Your source and draft are kept; retry opening this exact target.')
    if (original?.status === 'valid' && mapping) {
      rememberNoteReadingReturn({ from: reference, to: placed, surface: state.mainSurface,
        original: { hostId: mapping.hostId, workspaceId: mapping.id, workspacePath: mapping.path, path: surface.path, noteId: original.note.noteId },
        title: original.note.title ?? 'original Note' })
    }
  }
  async function openPage(page: NotebookPage, blockId?: string, signal?: AbortSignal) { await openOriginal({ ...page.resource, noteId: page.noteId }, blockId, signal) }
  const sharedRead = useMemo(() => {
    try { return noteHistoryReadParams(useAppStore.getState(), scratchTopicsForConfig(useAppStore.getState().config, useAppStore.getState().scratchTopicSnapshots) ?? [], tabId, surface.regionId) } catch { return undefined }
  }, [tabId, surface.regionId, surface.workspaceId, surface.path, config])
  const sharedNote = useMemo(() => document ? parseNoteFile(document) : null, [document])
  const hasIncludes = useMemo(() => {
    const has = (node: import('@tiptap/core').JSONContent): boolean => node.type === 'noteInclude' || Boolean(node.content?.some(has))
    if (sharedNote?.status !== 'valid') return false
    const originalReferences = new Set<string>()
    const references = (node: import('@tiptap/core').JSONContent) => { if (node.type === 'blockReference' && typeof node.attrs?.target?.noteId === 'string') originalReferences.add(node.attrs.target.noteId); node.content?.forEach(references) }
    references(sharedNote.note.content)
    return has(sharedNote.note.content) || knowledge.sources.some(source => originalReferences.has(source.note.noteId) && has(source.note.content))
  }, [sharedNote, knowledge])
  if (!document) return null
  return <div className="note-surface" style={noteReadingStyle(config?.notes)}>

    {document.noteEditing?.shareUndo ? <div className="note-knowledge-notice" role="status">{saving ? 'Saving this shared-reference removal…' : sharedUndoIssue && 'message' in sharedUndoIssue ? sharedUndoIssue.message : noteShareUndoRecoveryMessage(document.noteEditing)}
      {!saving && <><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().inspectNoteShareUndo(surface.workspaceId, surface.path)}>Check this removal</button><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().continueNoteShareUndo(surface.workspaceId, surface.path)}>Continue this removal</button></>}
    </div> : document.noteEditing?.shareUndoReceipt?.retained.length ? <div className="note-knowledge-notice" role="status">{document.noteEditing.shareUndoReceipt.status === 'partial' ? noteShareUndoRecoveryMessage(document.noteEditing) : [...new Set(document.noteEditing.shareUndoReceipt.retained.map(value => value.message))].join(' ')}</div> : null}

    {directoryFacts?.issues.length ? <div className="note-knowledge-notice" role="status">{directoryFacts.issues.map((issue, index) => <div key={index}>{issue}</div>)}</div> : null}
    {!blockPresentation ? <div className="note-knowledge-notice" role="status">Block selection recovery is unconfirmed for this display. Editing continues; restore its exact display position to resume selection recovery.</div> : null}
    {notice && !choices.length ? <div className="note-knowledge-notice" role="status">{notice}</div> : null}
    <Dialog.Root open={presentation.active && choices.length > 0} onOpenChange={open => { if (!open) setChoices([]) }}>
      <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="notebook-create-dialog dialog-surface note-position-dialog" onCloseAutoFocus={event => {
        event.preventDefault()
        if (restoreChoiceFocus.current && presentation.active && choiceOpener.current?.isConnected) choiceOpener.current.focus({ preventScroll: true })
      }}>
      <header><Dialog.Title>Open {choices[0] ? sourceName(choices[0].source) ?? choices[0].source.location.path : 'Note'}</Dialog.Title><Dialog.Close asChild><button type="button" className="small-button" aria-label="Close Note positions">Close</button></Dialog.Close></header>
      <Dialog.Description className="notebook-create-description">This note is open in several places. Choose where to show its block.</Dialog.Description>
      {notice ? <p className="note-knowledge-notice" role="status">{notice}</p> : null}
      <div className="note-source-choices" aria-label="Original Note positions">{choices.map(choice => <button type="button" className="note-backlink"
      aria-label={`Open Note position ${choice.location.displayWorkspaceId} · ${choice.location.groupId} · ${choice.location.tabId} · ${choice.location.regionId}`}
      title={`${choice.location.displayWorkspaceId} · ${choice.location.groupId} · ${choice.location.tabId} · ${choice.location.regionId}`}
      key={JSON.stringify([choice.location.displayWorkspaceId, choice.location.groupId, choice.location.tabId, choice.location.regionId])} onClick={() => void openAt(choice)}>
      <span>{choice.displayName} · {choice.tabName}</span><small>{choice.position}</small>
    </button>)}</div>
      </Dialog.Content></DocumentOverlayPortal>
    </Dialog.Root>
    <NoteReadingReturn />
    <NoteSharedFileEditing target={{ workspaceId: surface.workspaceId, path: surface.path, hostId: originalResource?.hostId ?? '', workspacePath: originalResource?.path ?? '', noteId: sharedNote?.status === 'valid' ? sharedNote.note.noteId : '' }} read={sharedRead} occurrence={occurrence} active={presentation.active} hasIncludes={hasIncludes} knowledge={knowledge} onOpen={onOpen} onOpenOriginal={openOriginal}>
    <NoteFileView sourceCoverage={
      <details className="note-directory-sources" aria-label="Note sources"><summary title={directoryScope} aria-description={directoryScope}>Sources{directoryFacts?.status !== 'complete' ? <SourceScopeIcon size={12} /> : null}</summary>
        <button type="button" className="note-text-button" disabled={directoryFacts?.status === 'reading'} onClick={() => void useAppStore.getState().refreshNoteDirectorySources(tabId, surface.regionId)}>Refresh directory</button>
        <p className="note-scope">{directoryScope}. This checks the original Note directory. Other directories may contain more sources.</p>
        {directoryFacts?.issues.length ? <p className="note-scope" role="status">{directoryFacts.issues.join(' ')}</p> : null}
        {directoryFacts?.unreadPaths.length ? <div className="note-scope"><strong>Not yet read</strong>{directoryFacts.unreadPaths.map(path => <div className="note-unread-source" key={path}><span>{path}</span>
          <button type="button" className="note-text-button" aria-label={`Open Note source ${surface.workspaceId} · ${path}`} onClick={() => void openUnread(path)}>Open</button></div>)}</div> : null}
        {directoryFacts?.unconfirmedPaths.length ? <div className="note-scope"><strong>Unconfirmed sources</strong>{directoryFacts.unconfirmedPaths.map(path => <div key={path}>{path}</div>)}</div> : null}
      </details>
    } {...(originalResource ? { resource: { hostId: originalResource.hostId, workspaceId: originalResource.id, workspacePath: originalResource.path, path: surface.path } } : {})} document={document} dirty={dirty} knowledge={knowledge} onCheckOriginal={() => void useAppStore.getState().refreshDocument(surface.workspaceId, surface.path)} onChange={(raw, before) => update(tabId, raw, before ?? document.content, surface.regionId)} onSave={onSave} onOpen={onOpen} onOpenPage={openPage} onOpenOriginal={openOriginal} onCompositionChange={compositionChanged}
      onSnapshotIssue={(displayed, incoming) => { if (originalResource) useAppStore.getState().retainNoteEditorDraft(tabId, surface.regionId, displayed, incoming, { hostId: originalResource.hostId, path: originalResource.path }, 'retain') }}
      onKeepDisplayedDraft={(displayed, incoming) => { if (originalResource) useAppStore.getState().retainNoteEditorDraft(tabId, surface.regionId, displayed, incoming, { hostId: originalResource.hostId, path: originalResource.path }, 'keep-displayed') }}
      {...(blockPresentation ? { onSelectedBlock } : {})} {...(restoredBlock ? { restoredBlock } : {})}
      {...(presentation.active && focusRequest !== undefined ? { focusRequest, canFocus, onFocused } : {})}
      {...(reveal?.noteBlock && presentation.active ? { revealBlock: reveal.noteBlock, onRevealed } : {})} />
    </NoteSharedFileEditing>
  </div>
}
