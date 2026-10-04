import { executorsForHost } from './executors'
import type { FileDocument } from '@agentmux/core'
import { MOTE_QUICK_MODE_PATH, sameMoteDefaultConversation, parseMoteQuickMode, serializeMoteQuickMode, type MoteQuickDefaults } from '../../../shared/mote-quick-mode'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { readMoteMaterial, saveMoteFile } from './mote-cooperation'
import { confirmedMoteReference, emptyMoteDestination } from './mote-materials-actions'
import { fileNavigationSelection, useAppStore } from '../store'
import { documentKey } from './workbench-tabs'
import { spatialCatalog } from './space-agent-control'
import { moteConversationChoices } from './mote-quick-preferences'

export type SavedMoteQuickMode = { document: FileDocument | null; defaults: MoteQuickDefaults; issue?: string }
export async function readMoteQuickDefaults(scope: MoteWorkfaceScope): Promise<SavedMoteQuickMode> {
  const read = await readMoteMaterial(scope, scope.rootPath + '/' + MOTE_QUICK_MODE_PATH)
  if (read.result.status === 'deleted') return { document: null, defaults: {} }
  if (read.result.status !== 'read') return { document: null, defaults: {}, issue: 'message' in read.result ? read.result.message : 'MOTE.md read is unconfirmed.' }
  const parsed = parseMoteQuickMode(read.result.document.content)
  return parsed.status === 'valid' ? { document: read.result.document, defaults: parsed.defaults }
    : { document: read.result.document, defaults: {}, issue: parsed.message }
}
export async function saveMoteQuickDefaults(scope: MoteWorkfaceScope, defaults: MoteQuickDefaults, saved: SavedMoteQuickMode,
  open: (path: string) => Promise<unknown>, stillCurrent: () => boolean, reference?: WorkbenchProjectionSelection | null): Promise<void> {
  const state = useAppStore.getState(), exact = confirmedMoteReference(state, scope, { reference }) ?? emptyMoteDestination(state, scope, { reference })
  if (!exact || saved.issue) throw new Error(saved.issue ?? 'The original Mote display is unconfirmed. Your choices and work are kept.')
  const navigation = fileNavigationSelection(state), path = scope.rootPath + '/' + MOTE_QUICK_MODE_PATH
  let changed = false
  const unsubscribe = useAppStore.subscribe(current => { if (fileNavigationSelection(current) !== navigation) changed = true })
  let latest: SavedMoteQuickMode
  try {
    latest = await readMoteQuickDefaults(scope)
    if (changed || !stillCurrent() || latest.issue || latest.document?.revision !== saved.document?.revision || latest.document?.content !== saved.document?.content)
      throw new Error(latest.issue ?? 'The saved settings or your later selection changed. Your choices are kept; reread MOTE.md before saving.')
  } finally { unsubscribe() }
  const current = useAppStore.getState()
  const workspace = current.config?.workspaces.find(item => item.id === scope.workspace.id)
  if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || !stillCurrent()) throw new Error('The original Mote resource changed. Your choices are kept.')
  if (defaults.executorId && defaults.executorId !== saved.defaults.executorId && !executorsForHost(current.config, scope.workspace.hostId, current.executorDetections, current.hostExecutorInventories[scope.workspace.hostId]).some(item => item.id === defaults.executorId)) throw new Error('The chosen Agent configuration no longer exists. Your choices are kept; choose an existing Agent.')
  if (defaults.conversation && !sameMoteDefaultConversation(defaults.conversation, saved.defaults.conversation) && !moteConversationChoices(current, scope.topic, scope.workspace.id, spatialCatalog(current, [scope.topic])).some(item => sameMoteDefaultConversation(item, defaults.conversation))) throw new Error('The chosen original conversation changed. Your choices are kept; reread its exact location.')
  const key = documentKey(scope.workspace.id, path)
  if (current.dirtyDocuments[key] || current.documentIssues[key]) throw new Error('The original settings Editor has an unsaved or unconfirmed draft. It is kept; review it before saving.')
  let document = latest.document
  if (!document) {
    await current.createPath({ path, kind: 'file' }, scope.workspace.id)
    const read = await readMoteMaterial(scope, path)
    if (!stillCurrent() || read.result.status !== 'read' || read.result.document.content !== '') throw new Error('Creating MOTE.md is unconfirmed or another edit arrived. Your choices and the original file are kept; inspect it before retrying.')
    document = read.result.document
  }
  await saveMoteFile(scope, path, document, serializeMoteQuickMode(document.content, defaults), open, stillCurrent, exact)
  await useAppStore.getState().refreshScratchTopics(scope.workspace.id, true, scope.topic.id)
}
