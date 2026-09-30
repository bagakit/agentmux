import { regionIds } from '@agentmux/layout'
import type { AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialSave } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { workspaceFilePreviewFormat } from '../../../shared/workspace-file-preview'
import type { EditorRegionDiffState } from '../store'
import type { FileWorkbenchState } from './file-workbench-state'
import { effectiveFileRegionMode, fileSupportsInlinePreview, publicFileRegionMode, storedFileRegionMode, type EditorRegionMode } from './file-region-presentation'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { spatialCatalog, type SpatialWorkbench } from './space-agent-control'
import { documentKey } from './workbench-tabs'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'

export type WorkfaceFileViewPorts = {
  get(): SpatialWorkbench & FileWorkbenchState & {
    scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>>
    editorRegionModes: Record<string, EditorRegionMode>
    editorRegionDiffs: Record<string, EditorRegionDiffState | undefined>
  }
  setEditorRegionMode(regionId: string, workspaceId: string, path: string, mode: EditorRegionMode): Promise<void>
  closing(tabId: string): boolean
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
}

/** One File Region mode, consumed by every occurrence; querying never loads content or writes preferences. */
export async function executeWorkfaceFileView(ports: WorkfaceFileViewPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'space.view' }>
): Promise<Extract<AgentMuxSpaceControlResult, { operation: 'space.view' }>> {
  const state = ports.get(), id = request.regionId
  const owners = Object.entries(state.tabs).flatMap(([key, tab]) => key === tab.id && Object.hasOwn(tab.regions, id) &&
    tab.regions[id]?.regionId === id && regionIds(tab.layout.root).includes(id) ? [tab] : [])
  const base: Extract<AgentMuxSpaceControlResult, { operation: 'space.view' }> = { operation: 'space.view', scope: 'file-region', regionId: id,
    tabId: null, workspaceId: null, storedOverride: null, effectiveMode: null, supportedModes: null,
    data: 'unconfirmed', content: { status: 'unconfirmed', reason: null }, changed: false, save: null, locations: [], outcome: 'unknown', issues: [] }
  const refuse = (code: string, message: string) => ({ ...base, outcome: 'refused' as const,
    issues: [{ step: 'target', code, message, recovery: 'Inspect the exact original File Region and its supported modes.' }] })
  if (owners.length !== 1) return refuse('REGION_NOT_OPEN', 'The exact original Region entity is missing or ambiguous.')
  const tab = owners[0]!, surface = tab.regions[id]!
  if (surface.kind !== 'file') return refuse('SPACE_REGION_KIND', 'This command changes only a File Region presentation.')
  const key = documentKey(surface.workspaceId, surface.path), format = workspaceFilePreviewFormat(surface.path)
  const topicWorkspace = state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, topicWorkspace) ?? []
  const catalog = spatialCatalog(state, topics)
  base.tabId = tab.id; base.workspaceId = surface.workspaceId
  base.locations = catalog.locations.filter(location => location.regionId === id && location.tabId === tab.id)
  const read = (current: ReturnType<WorkfaceFileViewPorts['get']>) => {
    const currentBinary = current.documentIssues[key]?.kind === 'binary'
    const currentReadonly = Boolean(currentBinary || format && !format.sourceEditable)
    base.supportedModes = currentReadonly ? ['preview'] : current.documents[key]
      ? fileSupportsInlinePreview(surface.path) ? ['source', 'diff', 'preview'] : ['source', 'diff'] : null
    base.storedOverride = publicFileRegionMode(storedFileRegionMode(current.editorRegionModes, id))
    const mode = effectiveFileRegionMode(current.editorRegionModes, id, surface.path, current.documentIssues[key]?.kind === 'binary')
    base.effectiveMode = publicFileRegionMode(mode)
    base.data = currentBinary ? 'binary-preview' : format && !format.sourceEditable ? 'media-preview' : current.documents[key] ? 'text'
      : current.documentIssues[key] ? 'failed' : 'unconfirmed'
    const diff = Object.hasOwn(current.editorRegionDiffs, id) ? current.editorRegionDiffs[id] : undefined
    base.content = mode === 'diff' ? { status: diff?.error ? 'failed' : diff?.loading ? 'loading' : diff?.diff ? 'available' : 'unconfirmed', reason: diff?.error ?? null }
      : currentReadonly ? { status: 'unconfirmed', reason: 'Preview bytes and decoding belong to the original visible File pane.' }
      : current.documents[key] ? { status: 'available', reason: null }
      : { status: current.documentIssues[key] ? 'failed' : 'unconfirmed', reason: current.documentIssues[key]?.kind === 'read-error' ? current.documentIssues[key].message : null }
  }
  read(state)
  if (request.mode === undefined) return { ...base, outcome: 'read' }
  if (ports.closing(tab.id)) return refuse('TAB_CLOSING', 'The original File Tab is closing; its current content is retained.')
  if (!base.supportedModes) return { ...base, issues: [{ step: 'content', code: 'FILE_FORMAT_UNCONFIRMED',
    message: 'The current original File facts do not yet confirm its supported modes.', recovery: 'Show or inspect this original File; no extra read was initiated by the query.' }] }
  if (!base.supportedModes.includes(request.mode)) return { ...base, outcome: 'refused', issues: [{ step: 'mode', code: 'FILE_MODE_UNSUPPORTED',
    message: 'The requested mode is not supported by the current original File facts.', recovery: 'Choose one of the reported supportedModes; the original File is retained.' }] }
  const before = base.storedOverride
  const input = captureDesktopInput(state.tabs)
  await ports.setEditorRegionMode(id, surface.workspaceId, surface.path, request.mode === 'source' ? 'edit' : request.mode)
  const applied = ports.get()
  if (!Object.hasOwn(applied.tabs, tab.id) || applied.tabs[tab.id]?.regions[id] !== surface) return { ...base, outcome: 'unknown',
    issues: [{ step: 'apply', code: 'SPACE_SOURCE_CHANGED', message: 'The original File Region changed while its mode was being applied.',
      recovery: 'Inspect current facts; no replacement Region is selected and the old request is not replayed.' }] }
  read(applied)
  base.changed = base.storedOverride !== before
  base.save = await ports.save(false)
  if (base.content.status === 'failed') base.issues.push({ step: 'content', code: 'FILE_MODE_CONTENT_UNCONFIRMED',
    message: base.content.reason ?? 'The requested mode content could not be read.', recovery: 'The File and applied mode are retained. Use its existing Retry or Refresh action.' })
  if (base.save.reason) base.issues.push({ step: 'save', code: 'SPACE_SAVE_UNCONFIRMED', message: base.save.reason,
    recovery: 'The applied transient mode is retained; persistence has no disk acknowledgement.' })
  if (desktopInputPreserved(input, input)) {
    await awaitDesktopPresentation(() => true)
    if (!desktopInputPreserved(input, captureDesktopInput(ports.get().tabs))) base.issues.push({ step: 'input',
      code: 'INPUT_PRESERVATION_UNCONFIRMED', message: 'The previous input is no longer confirmed eligible in its original presentation.',
      recovery: 'The applied File mode and original TextDoc are retained; choose the current input explicitly.' })
  }
  base.outcome = base.issues.length ? 'partial' : base.changed ? 'changed' : 'unchanged'
  return base
}
