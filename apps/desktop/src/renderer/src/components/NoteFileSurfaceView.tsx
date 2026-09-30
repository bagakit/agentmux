import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentMuxSpaceLocation } from '@agentmux/core/control'
import { groupIds, regionIds } from '@agentmux/layout'
import { editorSaveAction } from '../lib/editor-save-shortcut'
import { presentError } from '../lib/error-presentation'
import { regionCaretFocusTargets } from '../lib/region-focus'
import { loadedNoteFiles, noteFilesFromDocuments, noteKnowledge, parseNoteFile, type NoteSource } from '../lib/note-knowledge'
import { noteDirectorySourceFacts, noteDirectorySourceKey } from '../lib/note-directory-sources'
import { noteBlockSelectionKey } from '../lib/note-block-selection'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import { spatialCatalog } from '../lib/space-agent-control'
import { surveyInitialZoneSelection, surveySelectReference } from '../lib/survey-workface'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { NoteFileView } from './NoteFileView'

type SourceChoice = { source: NoteSource; blockId: string; location: AgentMuxSpaceLocation; displayName: string; tabName: string; position: string }

/** Rich presentation on the original File surface and its original update/save/reveal owner. */
export function NoteFileSurfaceView({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const key = documentKey(surface.workspaceId, surface.path)
  const document = useAppStore(state => state.documents[key])
  const notes = useAppStore(useShallow(state => noteFilesFromDocuments(state.documents)))
  const knowledge = useMemo(() => noteKnowledge(loadedNoteFiles(notes), 'partial'), [notes])
  const directory = useAppStore(state => state.noteDirectorySources[noteDirectorySourceKey(surface.workspaceId, surface.path)])
  const config = useAppStore(state => state.config)
  const fileRevision = useAppStore(state => state.workspaceFileRevisions[surface.workspaceId] ?? 0)
  const directoryIssues = useAppStore(useShallow(state => (directory?.paths ?? []).map(path => state.documentIssues[documentKey(surface.workspaceId, path)])))
  const directoryFacts = useMemo(() => directory ? noteDirectorySourceFacts(directory, { config, documents: notes,
    workspaceFileRevisions: { [surface.workspaceId]: fileRevision }, documentIssues: Object.fromEntries(directory.paths.map((path, index) => [documentKey(surface.workspaceId, path), directoryIssues[index]])) }) : null,
    [directory, config, notes, fileRevision, directoryIssues, surface.workspaceId])
  const reveal = useAppStore(state => state.documentRevealTargets[key])
  const focusRequest = useAppStore(state => regionCaretFocusTargets(state.regionCaretFocus, surface.regionId) ? state.regionCaretFocus?.nonce : undefined)
  const update = useAppStore(state => state.updateDocument)
  const presentation = useWorkbenchBrowserPresentation()
  const blockPresentation = useMemo(() => presentation.tabHostId && presentation.reference ? { tabHostId: presentation.tabHostId,
    reference: { ...presentation.reference, tabId, regionId: surface.regionId } } : undefined, [presentation.tabHostId, presentation.reference, tabId, surface.regionId])
  const restoredBlock = useAppStore(state => blockPresentation ? state.noteBlockSelections[noteBlockSelectionKey(blockPresentation)] : undefined)
  const onSelectedBlock = useCallback((target: import('../../../shared/note-document').NoteBlockTarget) => {
    if (blockPresentation) useAppStore.getState().setNoteBlockSelection(blockPresentation, target)
  }, [blockPresentation])
  const [notice, setNotice] = useState<string | null>(null), [choices, setChoices] = useState<SourceChoice[]>([])
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
      read?.status !== 'valid' || read.note.noteId !== source.note.noteId || !currentSource?.blocks.has(blockId)) {
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
      return { source, blockId, location, displayName: state.config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId,
        tabName: workbenchTabDisplayName(tab, state.sessions, state.agentNames, state.timelines), position: `${groupIndex < 0 ? location.groupId : `Panel ${groupIndex + 1}`} · ${viewIndex < 0 ? location.regionId : `View ${viewIndex + 1}`}` }
    })
    if (!exact.length) { setChoices([]); setNotice('No original Note display position is confirmed yet. The reference and source identity are preserved.'); return }
    if (exact.length > 1) { setNotice('Choose an original Note display position.'); setChoices(exact); return }
    void openAt(exact[0]!)
  }
  if (!document) return null
  return <div className="note-surface">
    <details className="note-directory-sources"><summary>Note sources <span>{!directoryFacts ? 'Loaded Notes only' : directoryFacts.status === 'reading' ? 'Checking this directory…'
      : directoryFacts.status === 'unknown' ? 'Directory unconfirmed' : `${directoryFacts.confirmedPaths.length} confirmed in this directory${directoryFacts.status === 'partial' ? ' · partial' : ''}`}</span></summary>
      <button type="button" className="note-text-button" disabled={directoryFacts?.status === 'reading'} onClick={() => void useAppStore.getState().refreshNoteDirectorySources(tabId, surface.regionId)}>Refresh directory</button>
      <p className="note-scope">This checks the original Note directory. Other directories may contain more sources.</p>
      {directoryFacts?.unreadPaths.length ? <div className="note-scope"><strong>Not yet read</strong>{directoryFacts.unreadPaths.map(path => <div className="note-unread-source" key={path}><span>{path}</span>
        <button type="button" className="note-text-button" aria-label={`Open Note source ${surface.workspaceId} · ${path}`} onClick={() => void openUnread(path)}>Open</button></div>)}</div> : null}
      {directoryFacts?.unconfirmedPaths.length ? <div className="note-scope"><strong>Unconfirmed sources</strong>{directoryFacts.unconfirmedPaths.map(path => <div key={path}>{path}</div>)}</div> : null}
    </details>
    {directoryFacts?.issues.length ? <div className="note-knowledge-notice" role="status">{directoryFacts.issues.map((issue, index) => <div key={index}>{issue}</div>)}</div> : null}
    {!blockPresentation ? <div className="note-knowledge-notice" role="status">Block selection recovery is unconfirmed for this display. Editing continues; restore its exact display position to resume selection recovery.</div> : null}
    {notice ? <div className="note-knowledge-notice" role="status">{notice}</div> : null}
    {choices.length ? <div className="note-source-choices" aria-label="Original Note positions">{choices.map(choice => <button type="button" className="note-backlink"
      aria-label={`Open Note position ${choice.location.displayWorkspaceId} · ${choice.location.groupId} · ${choice.location.tabId} · ${choice.location.regionId}`}
      title={`${choice.location.displayWorkspaceId} · ${choice.location.groupId} · ${choice.location.tabId} · ${choice.location.regionId}`}
      key={JSON.stringify([choice.location.displayWorkspaceId, choice.location.groupId, choice.location.tabId, choice.location.regionId])} onClick={() => void openAt(choice)}>
      <span title={`${choice.location.displayWorkspaceId} · ${choice.location.groupId} · ${choice.location.tabId} · ${choice.location.regionId}`}>{choice.displayName} · {choice.tabName}</span><small>{choice.source.location.path} · {choice.position}</small>
    </button>)}</div> : null}
    <NoteFileView document={document} knowledge={knowledge} onChange={raw => update(tabId, raw, surface.regionId)} onSave={onSave} onOpen={onOpen}
      {...(blockPresentation ? { onSelectedBlock } : {})} {...(restoredBlock ? { restoredBlock } : {})}
      {...(focusRequest !== undefined ? { focusRequest, canFocus, onFocused } : {})}
      {...(reveal?.noteBlock && presentation.active ? { revealBlock: reveal.noteBlock, onRevealed } : {})} />
  </div>
}
