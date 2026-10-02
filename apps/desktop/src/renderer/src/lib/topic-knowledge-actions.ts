import { scratchWorkspaceFilePath, scratchTopicLogicalPath, scratchTopicPhysicalPath, SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type TopicKnowledgeSource, type KnowledgeTopic } from '@agentmux/core/control'
import { api } from './api'
import { useAppStore } from '../store'
import { categoriesFromSpatial } from '../../../shared/topic-categories'
import { desktopBindingsFromSpatial } from './desktop-spatial-state'
import { parseNoteFile } from './note-knowledge'
import { documentKey } from './workbench-tabs'

/** Refresh only the original graph's Host descriptors and bindings, never clone a workface. */
export async function refreshTopicSpatial(): Promise<void> {
  const state = await api.spatial.read()
  if (!state) throw new Error('The original spatial state is not confirmed. Existing workfaces remain available.')
  useAppStore.setState({ topicCategories: categoriesFromSpatial(state.graph), spaceZoneBindings: desktopBindingsFromSpatial(state.graph) })
}
export async function moveKnowledgeTopic(topic: KnowledgeTopic, categoryId: string): Promise<void> {
  const result = await api.topics.call('topic.move', { topicId: topic.topicId, categoryId, expectedRevision: topic.spatialRevision })
  await refreshTopicSpatial()
  const category = useAppStore.getState().topicCategories.find(category => category.categoryId === categoryId)
  if (!category) throw new Error('The Topic transfer was saved; its Category description is still restoring. Refresh this Topic to inspect the result.')
  useAppStore.setState(state => {
    const choice = state.workbenchSpaceSelection
    return choice?.topicId === topic.topicId && choice.zoneId === result.topic.zoneId && result.previousCategorySpaceIds.includes(choice.spaceId ?? '')
      ? { workbenchSpaceSelection: { ...choice, spaceId: category.spaceId } } : state
  })
}
/** Capture only the selected original resource. No terminal or conversation scraping. */
export function selectedKnowledgeSources(workspaceId: string): { title: string; sources: TopicKnowledgeSource[] } | null {
  const state = useAppStore.getState(), layout = state.layouts[workspaceId], choice = state.workbenchSpaceSelection
  const group = layout?.groups.find(group => group.id === (choice?.workspaceId === workspaceId ? choice.groupId : layout.activeGroupId))
  const tab = state.tabs[choice?.workspaceId === workspaceId && choice.tabId ? choice.tabId : group?.activeTabId ?? '']
  if (!tab) return null
  const surface = tab.regions[choice?.workspaceId === workspaceId && choice.regionId ? choice.regionId : tab.layout.activeRegionId]
  if (!surface) return null
  const workspace = state.config?.workspaces.find(workspace => workspace.id === surface.workspaceId)
  if (surface.kind === 'file' && workspace) {
    const document = state.documents[documentKey(workspace.id, surface.path)], note = document && surface.path.endsWith('.note.json') ? parseNoteFile(document) : null
    return { title: surface.path.split('/').at(-1) ?? surface.path, sources: [
      { kind: 'file', hostId: workspace.hostId, path: scratchWorkspaceFilePath(workspace, scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace), surface.path) ?? (() => { throw new Error('The original source file path is not confirmed. Its workface is kept.') })(),
        ...(document?.revision ? { revision: document.revision } : {}) },
      ...(note?.status === 'valid' ? [{ kind: 'note' as const, noteId: note.note.noteId }] : [])
    ] }
  }
  if (surface.kind === 'browser') return { title: surface.title || surface.url, sources: [{ kind: 'url', url: surface.url }] }
  const origin = state.spaceZoneBindings[tab.space?.zoneId ?? '']
  if (origin?.contentKind === 'topic' && origin.topicId)
    return { title: tab.name ?? 'Discussion', sources: [{ kind: 'topic', topicId: origin.topicId, chatId: tab.id, threadId: surface.regionId }] }
  return tab.space?.zoneId ? { title: tab.name ?? 'Current work', sources: [{ kind: 'space', zoneId: tab.space.zoneId, tabId: tab.id, regionId: surface.regionId }] } : null
}
export async function openKnowledgeSource(source: TopicKnowledgeSource): Promise<void> {
  const state = useAppStore.getState()
  if (source.kind === 'url') return api.ui.openExternal(source.url)
  if (source.kind === 'file') {
    const scratch = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID && workspace.hostId === source.hostId)
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, scratch)
    const original = scratch ? topics?.filter(topic => !topic.readError && source.path.startsWith(scratchTopicPhysicalPath(scratch, topic).replace(/\/$/u, '') + '/')) ?? [] : []
    if (scratch && original.length === 1) {
      const topic = original[0]!, root = scratchTopicLogicalPath(scratch, topic)
      if (root !== null) { await state.openFile(root + '/' + source.path.slice(scratchTopicPhysicalPath(scratch, topic).replace(/\/$/u, '').length + 1), undefined, undefined, scratch.id); return }
    }
    const candidates = state.config?.workspaces.filter(workspace => workspace.hostId === source.hostId && source.path.startsWith(workspace.path.replace(/\/$/u, '') + '/')) ?? []
    if (candidates.length !== 1) throw new Error('Choose the original source Workspace before opening this file. Its reference is kept.')
    const workspace = candidates[0]!
    await state.openFile(source.path.slice(workspace.path.replace(/\/$/u, '').length + 1), undefined, undefined, workspace.id); return
  }
  if (source.kind === 'note') {
    const candidates = Object.entries(state.documents).filter(([, document]) => {
      if (!document.path.endsWith('.note.json')) return false
      const note = parseNoteFile(document); return note.status === 'valid' && note.note.noteId === source.noteId
    })
    if (candidates.length !== 1) throw new Error('The original note is not uniquely loaded. Use its source file; this reference is kept.')
    const [key, document] = candidates[0]!
    await state.openFile(document.path, undefined, source.blockId ? { line: 1, noteBlock: { noteId: source.noteId, blockId: source.blockId } } : undefined, key.slice(0, key.indexOf('\0'))); return
  }
  if (source.kind === 'topic') {
    if (!source.chatId) { await state.openScratchTopic(source.topicId); return }
    const tab = state.tabs[source.chatId], groups = Object.entries(state.layouts).flatMap(([workspaceId, layout]) => layout.groups.filter(group => group.tabOrder.includes(source.chatId!)).map(group => ({ workspaceId, groupId: group.id })))
    const origin = tab?.space?.zoneId ? state.spaceZoneBindings[tab.space.zoneId] : undefined
    if (!tab || origin?.topicId !== source.topicId || origin.contentKind !== 'topic' || groups.length !== 1 || source.threadId && !Object.hasOwn(tab.regions, source.threadId)) throw new Error('The original discussion source and position are not uniquely confirmed. Its reference is kept.')
    if (!await state.openScratchTopic(source.topicId)) return
    const current = useAppStore.getState(), latest = current.tabs[tab.id]
    if (latest !== tab) throw new Error('The source discussion changed during navigation. Its original reference is kept.')
    const location = groups[0]!
    useAppStore.getState().activateTab(location.workspaceId, location.groupId, tab.id)
    if (source.threadId) useAppStore.getState().focusRegion(location.workspaceId, tab.id, source.threadId)
    return
  }
  const result = await state.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `knowledge-source:${crypto.randomUUID()}`, operation: 'focus', target: {
    kind: 'space', zoneId: source.zoneId, ...(source.tabId ? { tabId: source.tabId } : {}), ...(source.regionId ? { regionId: source.regionId } : {}) }, inputPolicy: 'target' })
  if (result.operation !== 'focus' || result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed') throw new Error('The original discussion position is not confirmed. Its reference is kept; reopen its exact source workface.')
}
