import { registerExecutionBindingIpc } from './execution-binding-ipc.js'
import { ExecutionBindingReaders } from './execution-binding-readers.js'
import { AgentExecutionBindingService } from '@agentmux/core'
import { preparePublicUserProfile } from '@agentmux/host/author-profile'
import { fileUploadRevision, parseFileUploadIdentity, parseFileUploadResult } from '@agentmux/core/files'
import { captureGoalDiscussionLauncherLaunch, confirmGoalDiscussionLauncherLaunch, handoffGoalDiscussion, launcherCreationSpatialIntent } from './goal-discussion-handoff.js'
import { desktopGoalControl, desktopGoalChanges, observeDesktopGoalChanges, readDesktopGoals, confirmDesktopGoalParticipation, reconcileDesktopGoalDispatch } from './desktop-goals.js'
import { hostGoalRecord } from '@agentmux/host/goal-projection'
import { sessionRecoveryOperationResult } from './session-recovery-operation'
import { registerMoteChatIpc } from './mote-chat-ipc.js'
import { callCapsuleFromApp } from './capsule-ipc.js'
import { capsulePresentation, resolveCapsuleColdDocument, createCapsuleBrowserDocument } from './capsule-presentation.js'
import { capsuleDocumentIpc } from './capsule-document-ipc.js'
import { CapsuleReplyAuthority } from './capsule-reply-authority.js'
import { AgentLearningAuthority } from './agent-learning-authority.js'
import { registerAgentLearningIpc } from './agent-learning-ipc.js'
import type { CapsulePort } from '@agentmux/core/capsule'
import { mintObjectId } from '@agentmux/core/object-id'
import { ClientIncidentIpcOwner } from './client-incident-ipc.js'
import { ClientIncidentRuntimeOwner } from './client-incident-runtime.js'
import type { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { isAgentSchedule } from '@agentmux/core'
import { NoteFileMutations } from './note-file-mutations.js'
import { parseFileShareUndoParams, parseFileShareUndoResult } from '@agentmux/core/files'
import { NoteSharedUndoOwner } from '@agentmux/host/note-shared-undo-owner'
import { NoteSharedFileDeleteOwner } from '@agentmux/host/note-shared-file-delete-owner'
import { NoteSharedBlockOwner } from '@agentmux/host/note-shared-block-owner'
import { parseFileShareParams, parseFileShareResult, parseFileShareInspectParams, parseFileShareInspectResult } from '@agentmux/core/files'
import { RendererAllocationSampler } from './renderer-allocations.js'
import type { PerformanceSceneOwner } from './performance-scene.js'
import type { RendererHeapSnapshotOwner } from './renderer-heap-snapshot.js'
import { registerHeapSnapshotFileIpc } from './renderer-heap-snapshot-ipc.js'
import { isApplicationAccessMethod, parseApplicationAccessParams, type AgentMuxApplicationAccessOwner } from '@agentmux/core'
import { registerConversationReadIpc } from './conversation-read-ipc'
import { registerBrowserResourceIpc } from './browser-resource-ipc.js'
import { browserAgentAuthority } from './browser-agent-authority.js'
import { createBrowserInputContextPorts, registerBrowserInputContextIpc } from './browser-input-context-ipc.js'
import { RendererV8Profiler } from './renderer-v8-profile.js'
import { RendererCacheController } from './renderer-cache.js'
import { RendererMemoryInspector } from './renderer-memory.js'
import { RendererAnimationInspector } from './renderer-animations.js'
import { registerPerformanceCaptureIpc } from './performance-capture-ipc.js'
import { RendererTimelineTracer } from './renderer-trace.js'
import { ConversationLandmarkStore } from '@agentmux/core'
import { registerMoteConnectionIpc } from './mote-connection-ipc.js'
import { NativeOverlayWindows } from './native-overlay-windows.js'
import type { WorkbenchWindows } from './workbench-windows.js'
import { WORKBENCH_WINDOW_RESPONSE } from '../shared/workbench-windows.js'
import { goalRoleInputNote } from '@agentmux/host/goal-role-input'
import { registerConnectorIpc } from './connector-ipc.js'
import { parseGoalDelegationParams, parseGoalDelegationResult, type GoalDelegationParamsMap } from '@agentmux/core/goal-delegation'
import { observeTerminalBrightness, terminalPaletteChanged, terminalPaletteForAppearance } from './terminal-theme.js'
import { exportThemeFile, writeThemeFile } from './theme-file-export.js'
import { themeObservation } from '@agentmux/host/theme-observation'
import { MoteAvatarSeriesOwner } from './mote-avatar-series.js'
import { MoteAvatarControl } from './mote-avatar-control.js'
import { createMoteAvatarWriter } from './mote-avatar-writer.js'
import type { MoteAvatarWriteParameterMap } from '@agentmux/core/mote-avatar-write'
import type { MoteAvatarSeriesParameterMap } from '@agentmux/core/mote-avatar-series'
import { readInputObservation, resolveToolkitWorkspacePath } from '@agentmux/core/control'
import { assertGoalDispatchReference, type GoalDispatchReference } from '../shared/goal-dispatch.js'
import { isDemandStoreError, parseDemandDispatchIntent, sameDemandDispatchIntent, type DemandDispatchIntent } from '@agentmux/demand'
import { resolveGoalsPreferences } from '@agentmux/host/goals-preferences'
import { assertGoalPmoIntent, goalPmoOperation, type GoalPmoIntent } from '@agentmux/host/goal-pmo-origin'
import { NotesStorageOwner } from './notes-storage-owner.js'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { DeliveryAttemptStore, parseDeliveryAttempt, type DeliveryAttempt } from '@agentmux/core'
import { SpaceObjectImages } from './space-object-images.js'
import type { SpaceObjectImageTarget, ObjectAvatarInput, ObjectAvatarRef } from '@agentmux/host/object-avatars'
import { homedir, hostname } from 'node:os'
import { FileUploadOwner } from '@agentmux/host/file-upload-owner'
import { GitPublicControl } from './git-public-control.js'
import { NoteTitleFileWriter } from '@agentmux/host/note-title-file-writer'
import { createNotebookObservationServices } from './notebook-observation-requests.js'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { parseFileHistoryParams, parseFileHistoryResult, parseFileRestoreParams, parseFileRestoreResult, parseFileUndoParams, parseFileUndoResult } from '@agentmux/core/files'
import { registerMotePreferencesIpc } from './mote-preferences-ipc.js'
import { HtmlFilePreviews } from './html-file-previews.js'
import { FilePreviewResources } from './file-preview-resources.js'
import { FileDiagramRenderer } from './file-diagram-renderer.js'
import { FileBuilds } from './file-builds.js'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import type { SpatialLinkIngress } from './spatial-link-ingress.js'
import type { WebUrlIngress } from './web-url-ingress.js'
import { executeBrowserDefaultControl, inspectDefaultBrowser, openDefaultBrowserSettings } from './browser-default.js'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { AgentMuxNotebookStore, AgentMuxNotesStorage, type NotebookWrite } from '@agentmux/core/notebook-store'
import {AgentMuxSpatialStateStore,spatialCatalog} from '@agentmux/core/spatial-state'
import { displayLabel } from '@agentmux/core/spatial-graph'
import { NameChangeAudit, nameChangeRequests, desktopNameContext, unknownNameContext } from './name-change-audit.js'
import type { AgentMuxNameContext } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import { sessionReopenResult } from '../shared/session-reopen-result.js'
import { sessionLaunchResult } from '../shared/session-launch-result.js'
import { sessionInputWriteResult, sessionInputOperationResult } from '../shared/session-input-result.js'
import { sessionObservationResult } from '../shared/session-observation-result.js'
import { sessionAgentLaunchResult } from '../shared/session-agent-launch-result.js'
import { NATIVE_BROWSER_VISIBILITY_CHANNEL, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../shared/contracts.js'
import type { ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import { inspectDesktopClient, registerLoadedIdentityIpc } from './client-observation.js'
import { inspectNotifications, clientNotificationsPort } from './notification-observation.js'
import { inspectMoteContext, moteContextEvidencePort } from './mote-context-observation.js'
import { observeClientRpcSnapshot } from './rpc-client-observations.js'
import { SessionHistoryObservationOwners } from './session-history-observation.js'
import { registerHostRuntimeObservationIpc } from './host-runtime-observation-ipc.js'
import { registerSearchIpc } from './search-ipc.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { createResourceMetricsPort, observeRendererResources } from './resource-usage-control.js'
import { ToolkitOwner } from './toolkit-owner.js'
import { performanceLaunch } from './toolkit-asset.js'
import { registerToolkitIpc } from './toolkit-ipc.js'
import { registerDeviceManagementIpc } from './device-management-ipc.js'
import { resolvePerformancePreferences } from '../shared/toolkit-preferences.js'
import { projectBrowserControlEvent, projectBrowserControlOperation, projectBrowserControlResult } from './browser-completion-control.js'
import { observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority } from './workbench-storage-authority.js'
import type { DesktopLoadedRenderer, DesktopPackageIdentity } from '../shared/client-observation.js'
import { projectAppearance } from './project-appearance.js'
import { executeBrowserTaskControl } from './browser-task-control.js'
import { discoverAgentSkills, mintAgentSessionId, runProcess } from '@agentmux/core'
import { registerNativeDesktopIpc } from './native-desktop-ipc.js'
import { registerScreenshotShortcut } from './screenshot-shortcut.js'
import { ScreenCapture } from './screen-capture.js'
import { GlobalScreenshot } from './global-screenshot.js'
import { SystemScreenshotEditor } from './system-screenshot-editor.js'
import { getDesktopNativeUiOwner, getNativeDesktopOwner } from './native-desktop-owner.js'
import { createNativeDesktopPublicOwner } from './native-desktop-public.js'
import { readBookmark } from './bookmark-file.js'
import { bookmarkKindForPath } from '../shared/bookmark-file.js'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  AgentMuxControlServer,
  connectAgentMuxRpc,
  defaultAgentMuxControlSocketPath,
  agentMuxRpcHttpOptions,
  AgentMuxError,
  AGENTMUX_CONTROL_SCHEMA_VERSION, parseAgentMuxControlRequest,
  type AgentPromptCondition,
  type AgentExecutorId,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxRunInputData,
  type AgentMuxAgentWriteInput
} from '@agentmux/core'
import type {
  AgentAttentionNotifyInput,
  AgentLaunchInput,
  AgentSessionControl,
  AppConfig,
  BrowserAnnotationMarker,
  BrowserBounds,
  BrowserPresentationGeometry,
  BrowserPresentationOccurrence,
  BrowserPresentationCaptureAck,
  BrowserPresentationActivation,
  BrowserProfileDeleteApproval,
  BrowserViewport,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  DesktopControlResponse,
  HostConfig,
  KeepOneOfFanOutInput,
  KeepOneOfFanOutOutcome,
  MoveWorkspacePathInput,
  RemoveWorktreeInput,
  RemoveWorktreeOutcome,
  WorktreeRemovalNotice,
  RunFanOutInput,
  RunFanOutResult,
  SessionControl,
  SessionInputWriteResult,
  TerminalLaunchInput,
  WorkspaceFileWriteInput,
  WorkspaceRecord
} from '../shared/contracts.js'
import type {
  CreatePullRequestInput,
  GitBranchCompareInput,
  GitBranchDiffDescriptor,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions
} from '../shared/git-contracts.js'
import type { AgentMuxControlErrorCode, AgentMuxInteractionResponse } from '@agentmux/core'
import type { SessionHistoryPageOptions } from '../shared/contracts.js'
import { AGENT_ATTENTION_ACTIVATE_CHANNEL, CONTROL_CANCEL_CHANNEL, CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, SESSION_HISTORY_OBSERVATION_CHANNEL, CONNECTION_METADATA_CHANGED_CHANNEL, CONNECTION_METADATA_OBSERVATION_CHANNEL, WORKSPACE_FILE_INVALIDATED_CHANNEL } from '../shared/contracts.js'
import { createAgentNotifier } from './agent-notifier.js'
import { ExternalBrowserBridge } from './browser-external-bridge.js'
import { ExternalBrowserOwner } from './browser-external-owner.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { browserColdDescriptor, coldBrowserTargets } from './browser-cold-descriptor.js'
import { BrowserRecoveryPreviewStore } from './browser-recovery-preview.js'
import type { BrowserRecoveryPreviewReadResult, BrowserRecoveryPreviewScope } from '../shared/browser-recovery-preview.js'
import { browserResourceLocations } from './browser-resource-directory.js'
import type { NativeOverlayRegion } from '../shared/native-overlay.js'
import { BrowserOperationFileStore, BrowserOperationJournal, BROWSER_OPERATION_JOURNAL_FILE, browserOperationAlreadyExistsError } from './browser-operation-journal.js'
import { browserRunResult } from '../shared/browser-run-result.js'
import { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import { BrowserStepEvidenceStore } from './browser-step-evidence.js'
import { BrowserResultArtifactStore } from './browser-result-artifact.js'
import type { BrowserResultReadOptions } from '../shared/browser-result-artifact.js'
import { BrowserDemonstrationFileStore, BrowserDemonstrationRecorder, BROWSER_DEMONSTRATION_FILE } from './browser-demonstration-recorder.js'
import { BrowserUploads } from './browser-uploads.js'
import { BrowserDownloads } from './browser-downloads.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore, BROWSER_TASK_ASSETS_FILE } from './browser-task-assets.js'
import type { BrowserTaskAssetRunInput, BrowserTaskContent, BrowserTaskBatchInput } from '../shared/browser-task-assets.js'
import { verifiedBrowserWorkspace } from './browser-workspace-binding.js'
import { BrowserProfileManager } from './browser-profile-manager.js'
import { BrowserInputHistoryStore } from './browser-input-history.js'
import type { BrowserInputHistoryTarget, BrowserInputHistoryScope } from '../shared/browser-input-history.js'
import { nativeImageFromBrowserPng } from './browser-image.js'
import { savePastedImage } from './pasted-image-write.js'
import { readPastedImage } from './pasted-image-read.js'
import { ConfigStore } from './config-store.js'
import { ConfigOwner } from './config-owner.js'
import { resolveBrowserAgentControl } from '../shared/browser-agent-control.js'
import { registerThemeBootstrap, themeBootstrap } from './theme-bootstrap.js'
import { resolveTheme } from '@agentmux/client-ui/theme'
import { executeSettingsControl } from './settings-control.js'
import { checkSettingsHost, executeSettingsHostsControl } from './settings-hosts-control.js'
import { readHostCreationTrust, approveHostCreationTrust } from './settings-host-creation-trust.js'
import { SettingsHostsUpgradeOwner } from './settings-hosts-upgrade.js'
import { RemoteCoreUpgradeManager, type RemoteCoreUpgradeExpected } from '@agentmux/core'
import { executeSettingsExecutorRefreshControl, refreshSettingsExecutor } from './settings-executor-refresh-control.js'
import { executeSettingsResourcesControl } from './settings-resources-control.js'
import { executeSettingsBrowserControl, forgetBrowserAppLink } from './settings-browser-control.js'
import { APP_LINK_SCHEME_CHOICES, CONFIG_CHANGED_CHANNEL, type AppLinkSchemeChoice } from '../shared/contracts.js'
import { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import { normalizeExternalUrl } from './external-url.js'
import { assertManualPromptSenderTrusted, assertSenderTrusted, assertToolkitSenderTrusted, senderTrust, type PrivilegedChannel } from './ipc-sender-trust.js'
import { executeCrashLogControl, requestCrashLogReveal } from './crash-log-access.js'
import { FileObservationRegistry } from './file-observation-registry.js'
import { runOwnerDisposals } from './owner-disposal.js'
import { RuntimeController } from './runtime-controller.js'
import { desktopBusinessSocketPath } from './desktop-host.js'
import { ScratchTopics } from './scratch-topics.js'
import type { MoteAvatarInput, MoteAvatarRef } from '../shared/mote-avatars.js'
import { configWithRuntimeBindings, saveRuntimeConfig } from './runtime-config-transaction.js'
import { WorkspaceFiles, workspaceFileObserverCount } from './workspace-files.js'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'

import { WorktreeService } from './worktree-service.js'
import { WorktreeCloseoutOwner } from './worktree-closeout.js'
import { worktreeExecutionReferences } from './worktree-execution-references.js'
import { runFanOutRequest } from './fanout-request.js'
import { createSpaceZoneResource } from './space-zone-resources.js'
import type { SpaceZoneResourceInput } from '../shared/space-addresses.js'
import { sessionSnapshotPayload } from './session-snapshot-payload.js'
import { rebindLocalFolder } from './workspace-rebind.js'
import { executeSettingsWorkspaceAddControl, registerWorkspace } from './settings-workspace-add-control.js'
import { GitService } from './git-service.js'
import { GhService } from './gh-service.js'

function workspace(config: AppConfig, id: string): WorkspaceRecord {
  const item = config.workspaces.find((entry) => entry.id === id)
  if (!item) throw new Error(`Unknown workspace: ${id}`)
  return item
}

export async function openExternalFromRenderer(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  renderer: WebContents,
  rawUrl: string
): Promise<void> {
  if (event.sender !== renderer) throw new Error('Untrusted external URL sender')
  await shell.openExternal(normalizeExternalUrl(rawUrl))
}

export async function registerIpc(args: {
  window: BrowserWindow
  workbenchWindows: WorkbenchWindows
  configStore: ConfigStore
  initialConfig: AppConfig
  runtime: RuntimeController
  applicationAccess: AgentMuxApplicationAccessOwner

  workspaceFiles?: WorkspaceFiles
  scratchTopics: ScratchTopics
  environmentWarning?: () => string | undefined
  onRendererUpdateReady?: (token: string) => void
  onRendererStartupFailure?: (input: unknown) => boolean
  webLinks?: WebUrlIngress
  spatialLinks?: SpatialLinkIngress
  performanceScene?: PerformanceSceneOwner
  appMemory?: import('./app-memory-evidence.js').AppMemoryEvidenceOwner
  performanceHeap?: RendererHeapSnapshotOwner
  clientIncidents?: ClientIncidentArchive
  loadedPackage?: DesktopPackageIdentity | null
  loadedRenderer?: () => DesktopLoadedRenderer | null
}): Promise<() => Promise<void>> {
  const contents = args.window.webContents
  const capsuleClient: CapsulePort = { call: async (method, params) =>
    await callCapsuleFromApp(args.runtime.callOriginalCore.bind(args.runtime), method, params) as never }
  const capsuleReplies = new CapsuleReplyAuthority(capsuleClient, args.runtime)
  const agentLearningAuthority = new AgentLearningAuthority(args.runtime)
  const spatialState = new AgentMuxSpatialStateStore()
  const nameAudit = new NameChangeAudit(spatialState)
  args.scratchTopics.setNameAudit(nameAudit)
  let config = args.initialConfig
  const initialPalette = terminalPaletteForAppearance(config.appearance, nativeTheme.shouldUseDarkColors)
  args.runtime.setTerminalViewColors({
    foreground: initialPalette.foreground,
    background: initialPalette.background
  })
  const updateTerminalBrightness = () => {
    args.window.setBackgroundColor(resolveTheme(config.appearance, nativeTheme.shouldUseDarkColors).variant.colors.background)
    if (config.appearance.terminalTheme !== 'workspace') return
    const palette = terminalPaletteForAppearance(config.appearance, nativeTheme.shouldUseDarkColors)
    args.runtime.setTerminalViewColors({ foreground: palette.foreground, background: palette.background })
  }
  const initialRuntime = await args.runtime.prepare(config)
  const incidentIpc = args.clientIncidents ? new ClientIncidentIpcOwner({ archive: args.clientIncidents, contents,
    windowId: args.window.id, generation: () => args.runtime.rendererGeneration(contents),
    buildId: () => args.loadedPackage?.sourceCommit ?? null, rendererBuildId: () => args.loadedRenderer?.()?.id ?? null }) : null
  const runtimeIncidents = incidentIpc && args.clientIncidents
    ? new ClientIncidentRuntimeOwner(args.runtime, args.clientIncidents, incidentIpc.mainProducer()) : null
  let initialBindingError: unknown
  try {
    const bound = configWithRuntimeBindings(config, initialRuntime)
    if (bound !== config) config = await args.configStore.save(bound)
  } catch (error) { initialBindingError = error }
  try { args.runtime.commit(initialRuntime) }
  catch (error) { runtimeIncidents?.dispose(); throw error }
  // Directory metadata maintenance is advisory and never holds up the original Runtime/input.
  const scratchForIdentity = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  if (scratchForIdentity) void Promise.resolve().then(() => args.scratchTopics.normalizeDirectoryIdentities(scratchForIdentity, { shortenMotes: true }))
    .catch(error => process.stderr.write(`Directory identity startup maintenance: ${String(error)}\n`))
  if (initialBindingError) args.runtime.reportBindingSaveFailure(initialRuntime, initialBindingError)
  let releaseExecutorConfigEdit: (() => void) | undefined
  let toolkit: ToolkitOwner
  let fileBuilds: FileBuilds | undefined
  const configOwner = new ConfigOwner({
    nameAudit,
    read: () => config,
    prepare: (current, next) => toolkit.prepareConfig(current, next),
    save: async (next) => {
      const validated = args.configStore.validate(next)
      const release = await args.runtime.reserveExecutorConfigEdit(config, validated)
      try {
        const saved = await saveRuntimeConfig({ runtime: args.runtime, configWriter: args.configStore, next: validated })
        // Keep the reservation until the sole owner publishes the new authoritative config.
        releaseExecutorConfigEdit = release
        return saved
      } catch (cause) { release(); throw cause }
    },
    publish: (saved) => {
      const paletteChanged = terminalPaletteChanged(saved.appearance, config.appearance)
      for (const previous of config.workspaces) {
        const next = saved.workspaces.find(item => item.id === previous.id)
        if (!next || next.hostId !== previous.hostId || next.path !== previous.path) fileBuilds?.invalidateWorkspace(previous.id)
      }
      config = saved
      args.window.setBackgroundColor(resolveTheme(saved.appearance, nativeTheme.shouldUseDarkColors).variant.colors.background)
      toolkit.configurationChanged()
      releaseExecutorConfigEdit?.()
      releaseExecutorConfigEdit = undefined
      if (paletteChanged) {
        const palette = terminalPaletteForAppearance(saved.appearance, nativeTheme.shouldUseDarkColors)
        args.runtime.setTerminalViewColors({ foreground: palette.foreground, background: palette.background })
      }
      if (!args.window.isDestroyed() && !contents.isDestroyed()) contents.send(CONFIG_CHANGED_CHANNEL, saved)
    }
  })
  const fileObservations = new FileObservationRegistry()
  const notesStorage = new AgentMuxNotesStorage(undefined, undefined, { beforeSourceCleanup: async changes => { await notesStorageOwner.confirmResources(await notesStorage.inspect()); for (const change of changes) await fileObservations.unobserve(change.from.workspaceId + '\0' + change.from.path) } })
  const notesStorageOwner = new NotesStorageOwner(configOwner, spatialState, snapshot => { if (!args.window.isDestroyed() && !contents.isDestroyed()) contents.send('notesStorage:changed', snapshot) }, notesStorage)
  const notesStorageReady = notesStorageOwner.initialize().catch(error => process.stderr.write('Notes directory recovery remains available: ' + String(error) + '\n'))
  const hostUpgrades = new SettingsHostsUpgradeOwner(new RemoteCoreUpgradeManager({
    stateDirectory: join(app.getPath('userData'), 'remote-core-upgrades')
  }), configOwner, args.runtime)
  toolkit = new ToolkitOwner({ openRunPort: () => args.runtime.toolkitRunPort(), launch: performanceLaunch,
    config: configOwner, receiptPath: join(app.getPath('userData'), 'toolkit-receipts.json'),
    enabled: () => resolvePerformancePreferences(configOwner.current).enabled })
  void toolkit.load().catch(error => process.stderr.write('Toolkit loading remains unconfirmed: ' + String(error) + '\n'))
  const files = args.workspaceFiles ?? new WorkspaceFiles((id) => args.runtime.executionHost(id), {
    primaryMoteWorkspace: async () => config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  })
  const htmlPreviews = new HtmlFilePreviews(files, id => config.workspaces.find(item => item.id === id))
  const previewResources = new FilePreviewResources(files, id => config.workspaces.find(item => item.id === id))
  const diagramPreviews = new FileDiagramRenderer()
  const builds = fileBuilds = new FileBuilds(id => args.runtime.executionHost(id), id => config.workspaces.find(item => item.id === id), files)
  const releaseHtmlPreviews = () => { htmlPreviews.releaseAll(); previewResources.cancelAll(); diagramPreviews.cancelAll(); void builds.releaseAll() }
  let channelMetadata: ReturnType<typeof registerConnectorIpc> | undefined
  const releaseRendererResources = () => { controlBridge.dispose(); releaseHtmlPreviews(); channelMetadata?.releaseReaders() }
  const releaseNavigatedHtmlPreviews = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) {
      if (!inPlace) { controlBridge.dispose(); channelMetadata?.releaseReaders() }
      releaseHtmlPreviews()
    }
  }
  const deliveryAttempts = { hostId: 'local', store: new DeliveryAttemptStore(join(app.getPath('userData'), 'client-delivery-attempts'), { clientJournal: true }) }
  const worktrees = new WorktreeService((id) => args.runtime.executionHost(id), { save: (next, expected) => configOwner.edit(expected, next) })
  const worktreeCloseout = new WorktreeCloseoutOwner({ config: configOwner, spatial: spatialState, worktrees,
    prepare: async () => {
      const result = await controlBridge.execute({ operation: 'worktree.closeout.prepare', requestId: mintObjectId() })
      if (result.operation !== 'worktree.closeout.prepare' || result.diskDurability !== 'confirmed') throw new Error('Original workface save is unconfirmed. Keep the directory and retry after restoring its workface.')
    },
    executionReferences: async workspace => {
      const host = args.runtime.rpcClients().find(item => item.hostId === workspace.hostId)
      if (!host) throw new Error('The original Runtime Host is unavailable.')
      return await worktreeExecutionReferences(workspace, host.client)
    }
  })
  const git = new GitService((id) => args.runtime.executionHost(id))
  const publicGit = new GitPublicControl({ config: () => config, git, worktrees, closeWorktree: input => worktreeCloseout.publicClose(input) })
  // `git` is handed in rather than let GhService build its own: the PR readiness read asks git and gh
  // about the same repository in one breath, and two separately-constructed services could resolve a
  // workspace's host differently.
  const gh = new GhService((id) => args.runtime.executionHost(id), git)
  const browserProfiles = new BrowserProfileManager()
  void browserProfiles.initialize().catch(error => {
    // Profile metadata is a Browser service failure, not authority to stop healthy Agents or
    // prevent the host from loading. The manager retains the cause for Browser requests below.
    process.stderr.write(`browser_profile_initialization_failed=${JSON.stringify(error instanceof Error ? error.message : String(error))}\n`)
  })
  const browserInputHistory = new BrowserInputHistoryStore(join(app.getPath('userData'), 'browser-input-history'))
  const browserRecoveryPreviews = new BrowserRecoveryPreviewStore(join(app.getPath('userData'), 'browser-recovery-previews'))
  const browserOperationJournal = new BrowserOperationJournal(
    new BrowserOperationFileStore(join(app.getPath('userData'), BROWSER_OPERATION_JOURNAL_FILE))
  )
  await browserOperationJournal.ready()
  const browserDemonstrations = new BrowserDemonstrationRecorder(
    new BrowserDemonstrationFileStore(join(app.getPath('userData'), BROWSER_DEMONSTRATION_FILE))
  )
  // One payload/ledger owner is consumed by both actual page transports.
  const browserRefs = new BrowserRefLedgerStore()
  const browserEvidence = new BrowserStepEvidenceStore(join(app.getPath('userData'), 'browser-step-evidence'))
  const browserResults = new BrowserResultArtifactStore(join(app.getPath('userData'), 'browser-results'))
  const browserUploads = new BrowserUploads(join(app.getPath('userData'), 'browser-uploads'), files, id => workspace(config, id))
  const externalBridge = new ExternalBrowserBridge(join(app.getPath('userData'), 'browser-external-targets.json'), () => {
    if (!contents.isDestroyed()) contents.send('browser:targetsChanged')
  }, (browserId, navigationId) => {
    void browserUploads.releaseDocument(browserId, navigationId).catch(error => console.warn('Selected-file snapshots could not be released after the original document ended:', error))
  })
  await externalBridge.ready()
  const externalBrowsers = new ExternalBrowserOwner(externalBridge, { journal: browserOperationJournal,
    refs: browserRefs, evidence: browserEvidence, results: browserResults, uploads: browserUploads,
    validateScreenshot: image => { nativeImageFromBrowserPng(image, bytes => nativeImage.createFromBuffer(bytes)) } })
  const browsers = new BrowserViewManager(args.window, browserProfiles, browserRefs, {
    // Read the current owner fact so a remembered answer or explicit Forget takes effect immediately.
    rememberedSchemes: async () => config.browser.appLinkSchemes ?? {},
    rememberScheme: async (scheme, choice) => {
      // Only the native human choice creates this answer; Settings exposes Forget, never an allow setter.
      await configOwner.update((current) => ({
        ...current,
        browser: { ...current.browser, appLinkSchemes: { ...current.browser.appLinkSchemes, [scheme]: choice } }
      }))
    },
    // Browser and Popup have already authorized this handoff through their original app-link owner.
    openExternal: async (target) => {
      if (/^amux:/iu.test(target)) {
        if (!args.spatialLinks) throw new Error('Object link navigation is unavailable in this window. The original workface and Agents are kept; retry the exact link in the main Desktop window.')
        const issue = await args.spatialLinks.receive(target)
        if (issue) throw new Error(issue)
        return
      }
      // Keep Electron's native receiver for third-party applications.
      return shell.openExternal(target)
    }
  }, browserOperationJournal, browserEvidence, browserResults, browserDemonstrations,
  new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(app.getPath('userData'), BROWSER_TASK_ASSETS_FILE)), { nameAudit }),
  new BrowserDownloads(join(app.getPath('userData'), 'browser-downloads'), files, id => workspace(config, id)),
  browserUploads, () => resolveBrowserAgentControl(configOwner.current.browser.agentControl), browserRecoveryPreviews,
  {}, browserAgentAuthority(args.runtime))
  const disposeBrowserFeedbackPreferences = configOwner.subscribe((saved, previous) => {
    if (JSON.stringify(saved.browser.agentControl) !== JSON.stringify(previous.browser.agentControl)) browsers.refreshAgentFeedback()
  })
  const capsuleDocuments = capsuleDocumentIpc({ browsers, capsules: capsuleClient, theme: () => {
    const theme = themeBootstrap(configOwner.current.appearance, nativeTheme.shouldUseDarkColors)
    return { mode: theme.mode, tokens: theme.variables }
  } })
  browsers.capsuleDocumentReady = id => { void capsuleDocuments.pushTheme(id) }
  const updateCapsuleThemes = () => {
    for (const id of browsers.capsuleDocumentIds()) void capsuleDocuments.pushTheme(id)
  }
  const disposeCapsuleAppearance = configOwner.subscribe((saved, previous) => {
    if (saved.appearance !== previous.appearance) updateCapsuleThemes()
  })
  nativeTheme.on('updated', updateCapsuleThemes)
  const browserInputContextPorts = createBrowserInputContextPorts({ hostId: deliveryAttempts.hostId,
    browsers, home: app.getPath('home'), directory: join(app.getPath('userData'), 'browser-input-context'),
    createFromBuffer: bytes => nativeImage.createFromBuffer(bytes) })
  const inputContextCaptures = browserInputContextPorts.captures
  const ensureBrowser = (id: string, input?: Parameters<BrowserViewManager['restore']>[1]) => browsers.ensure(id, async () => {
    let saved = browserColdDescriptor((await spatialState.read())?.graph ?? null, id)
    workspace(config, saved.workspaceId)
    if (saved.mode !== 'private' && !saved.capsuleId) {
      await browserProfiles.initialize()
      // Profile IO must not revive a Region removed while this consumer was waiting.
      saved = browserColdDescriptor((await spatialState.read())?.graph ?? null, id)
      workspace(config, saved.workspaceId)
    }
    if (saved.capsuleId) saved = resolveCapsuleColdDocument(saved, await capsuleClient.call('capsule.inspect', { capsuleId: saved.capsuleId }))
    return saved
  }, input)
  const resolveRecoveryPreviewScope = async (id: string): Promise<BrowserRecoveryPreviewScope | null> => {
    const original = browsers.recoveryPreviewScope(id)
    if (original) return original
    const savedState = await spatialState.read()
    // A live/released owner created during the disk read remains the identity authority.
    const current = browsers.recoveryPreviewScope(id)
    if (current) return current
    const saved = browserColdDescriptor(savedState?.graph ?? null, id)
    if (saved.mode === 'normal' && !saved.profileId) return null
    return saved.mode === 'private'
      ? { browserId: id, workspaceId: saved.workspaceId, mode: 'private', profileId: null }
      : { browserId: id, workspaceId: saved.workspaceId, mode: 'normal', profileId: saved.profileId! }
  }
  browsers.setPresentationWindowOwner((document, occurrence) => 'kind' in occurrence
    ? args.workbenchWindows.windowForDocument(document) : args.workbenchWindows.presentationWindow(document, occurrence))
  const nativeChrome = new NativeOverlayWindows(args.window, browsers, args.workbenchWindows)
  const releaseNativeWindowOwner = args.workbenchWindows.setNativeOwner({ requestClose: window => browsers.requestNativeWindowClose(window), windowSize: async target => {
    const graph = (await spatialState.read())?.graph
    const regions = graph?.regions.filter(region => region.tabId === target.tabId && region.kind === 'browser' &&
      (target.kind === 'tab' || region.regionId === target.regionId)) ?? []
    return regions.length === 1 && regions[0]?.browserId ? browsers.nativeWindowSize(regions[0].browserId) : null
  }, beforeClosing: async window => {
    await browsers.returnWindow(window)
    nativeChrome.releaseWindow(window)
  } })
  browsers.onNativeVisibilityChange = (_visibility, window) => nativeChrome.visibilityChanged(window)
  browsers.onNativeInput = (owner, input) => nativeChrome.forwardBrowserInput(owner, input)
  const currentMetricsWindow = (): import('@agentmux/core/control').MetricsWindow | null => {
    if (args.window.isDestroyed() || contents.isDestroyed() || contents.isLoadingMainFrame()) return null
    const generation = args.runtime.rendererGeneration(contents)
    return generation === null ? null : { windowId: args.window.id, webContentsId: contents.id, generation }
  }
  const inputSender = (event: IpcMainInvokeEvent): import('@agentmux/core/control').InputPerformanceSender => {
    let window: import('@agentmux/core/control').MetricsWindow | null = null
    try { if (event.sender === contents) window = currentMetricsWindow() } catch { /* Optional observation cannot gate input. */ }
    return { webContentsId: event.sender.id, window }
  }
  const releaseResourceObservation = args.runtime.resourceSampler.setObservationSources({
    observeRuntime: () => args.runtime.resourceUsageObservation(),
    observeDiagnostics: (signal, generation) => args.runtime.performanceDiagnostics(signal, generation),
    rendererWindow: currentMetricsWindow,
    observeRenderer: signal => observeRendererResources(controlBridge, currentMetricsWindow, signal, () => contents.isDestroyed() ? null : contents.getOSProcessId()),
    processOwners: () => ({
      rendererPids: [...contents.mainFrame.framesInSubtree
        .filter((frame) => !frame.detached && frame.osProcessId > 0)
        .map((frame) => frame.osProcessId), ...nativeChrome.resourceProcessIds()],
      browserPids: browsers.resourceProcessIds()
    }),
    mainOwners: () => ({
      ...args.runtime.resourceOwnerCounts(),
      ...browsers.resourceOwnerCounts(),
      fileWatchers: workspaceFileObserverCount()
    })
  })
  const notifier = createAgentNotifier({
    window: args.window,
    onActivate: (sessionId) => {
      // Main focuses the window; WHERE to go inside it is the renderer's call, so the id is forwarded
      // rather than resolved here — View and Region truth belongs to the renderer.
      if (args.window.isDestroyed()) return
      contents.send(AGENT_ATTENTION_ACTIVATE_CHANNEL, sessionId)
    }
  })


  const channels: string[] = []
  let acceptingControl = true
  const controlBridge = new DesktopControlIpcBridge({
    isAvailable: () => acceptingControl && !args.window.isDestroyed() && !contents.isDestroyed(),
    sendRequest: (request) => contents.send(CONTROL_REQUEST_CHANNEL, request),
    sendCancellation: (cancellation) => contents.send(CONTROL_CANCEL_CHANNEL, cancellation)
  })
  contents.on('render-process-gone', releaseRendererResources)
  contents.on('did-start-navigation', releaseNavigatedHtmlPreviews)
  const currentRendererCaptureTarget = () => {
    const window = currentMetricsWindow()
    if (!window) return null
    const pid = contents.getOSProcessId()
    const processMetric = app.getAppMetrics().find(metric => metric.pid === pid)
    return processMetric && processMetric.creationTime > 0 ? { ...window, pid, creationTime: processMetric.creationTime } : null
  }
  const allocations = new RendererAllocationSampler(contents, currentRendererCaptureTarget)
  const profiler = new RendererV8Profiler(contents, currentRendererCaptureTarget)
  const cache = new RendererCacheController(controlBridge, currentRendererCaptureTarget)
  const memory = new RendererMemoryInspector(contents, currentRendererCaptureTarget)
  const animations = new RendererAnimationInspector(contents, currentRendererCaptureTarget)
  const tracer = new RendererTimelineTracer(contents, currentRendererCaptureTarget)
  const metrics = createResourceMetricsPort({ sampler: args.runtime.resourceSampler, currentWindow: currentMetricsWindow, profiler, tracer, memory, animations, allocations, cache,
    ...(args.performanceHeap ? { heap: { owner: args.performanceHeap, dependencies: { contents, currentTarget: currentRendererCaptureTarget,
      host: () => ({ kind: 'unix-host' as const, hostId: 'local' as const, hostname: hostname(), mainPid: process.pid }) } } } : {}),
    ...(args.appMemory ? { appMemory: args.appMemory } : {}),
    ...(args.performanceScene ? { scene: { owner: args.performanceScene, currentTarget: currentRendererCaptureTarget, loaded: () => ({ mainPid: process.pid,
      package: args.loadedPackage ?? null, renderer: contents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null }) } } : {}) })
  const closeMetrics = () => metrics.dispose()
  contents.once('destroyed', closeMetrics)
  const acceptControl = (event: IpcMainEvent, response: DesktopControlResponse): void => {
    // 发送者判据走 senderTrust（被行为测试直接质询）；这个频道的处置是**静默返回**而非抛，所以那半件
    // 留在这里。requestId 的形状检查不是发送者关切，也留在 shell——不塞进纯判据里。
    if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, contents).trusted) return
    if (!response || typeof response.requestId !== 'string') return
    controlBridge.accept(response)
  }
  const executeControlOwner = async (
    request: AgentMuxControlRequest, signal?: AbortSignal
  ): Promise<AgentMuxControlResult> => {
    if (request.operation === 'browser.release') return { operation: request.operation,
      receipt: await browsers.release(request.browserId, request.navigationId) }
    if (request.operation === 'space.mote.preferences.read' || request.operation === 'space.mote.preferences.save') {
      if (request.kind === 'quick') return controlBridge.execute(request, signal)
      throw new AgentMuxError('Connection preferences belong to their original background Host. Use that Host endpoint; the Mote files and Agents are retained.', 'CONTROL_UNAVAILABLE')
    }
    if(request.operation==='space.ls' || request.operation==='space.inspect') {
      if(!request.presentation && !('requestId' in request.target)) {
        const state=await spatialState.read()
        if(state) return {operation:request.operation,catalog:spatialCatalog(state.graph,request.target)}
      }
    }
    if(request.operation==='space.bind' || request.operation==='space.unbind') {
      const state=await spatialState.read()
      if(state) {
        const next=await spatialState.bind(request.binding,request.operation==='space.unbind')
        return {operation:request.operation,requestId:request.requestId,binding:request.binding,catalog:spatialCatalog(next.graph),
          outcome:request.operation==='space.bind'?'linked':'unlinked',save:{layoutApplied:true,localStorageWritten:false,storageFlushRequested:false,diskDurability:'confirmed',reason:null},issues:[]}
      }
    }

    if (request.operation === 'inspect.notifications') return await inspectNotifications(request, {
      renderer: () => contents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null,
      generation: () => args.runtime.rendererGeneration(contents),
      execute: input => controlBridge.execute(input, signal)
    })
    if (request.operation === 'inspect.mote-context') return await inspectMoteContext(request, {
      renderer: () => contents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null,
      generation: () => args.runtime.rendererGeneration(contents),
      execute: input => controlBridge.execute(input)
    })
    if (request.operation === 'inspect.client') return await inspectDesktopClient(request, {
      pid: process.pid, package: args.loadedPackage ?? null,
      renderer: () => contents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null,
      generation: () => args.runtime.rendererGeneration(contents),
      storage: () => observeWorkbenchStorageAuthority(contents.session, {
        userData: app.getPath('userData'), sessionData: app.getPath('sessionData')
      }),
      runtimes: () => args.runtime.connectedRuntimeIdentities(), execute: (input) => controlBridge.execute(input)
    })
    if (request.operation === 'settings.browser.default.inspect' || request.operation === 'settings.browser.default.open-settings') return executeBrowserDefaultControl(request)
    if (request.operation === 'diagnostics.crash-log.get' || request.operation === 'diagnostics.crash-log.reveal') return await executeCrashLogControl(request)
    if (request.operation === 'settings.get' || request.operation === 'settings.set') return await executeSettingsControl(request, configOwner, notesStorageOwner)
    if (request.operation === 'settings.workspaces.add') return await executeSettingsWorkspaceAddControl(request, configOwner, id => args.runtime.executionHost(id))
    if (request.operation === 'settings.hosts.list' || request.operation === 'settings.hosts.update' || request.operation === 'settings.hosts.test' || request.operation === 'settings.hosts.upgrade-check' || request.operation === 'settings.hosts.upgrade' || request.operation === 'settings.hosts.upgrade-inspect') return await executeSettingsHostsControl(request, configOwner, args.runtime, hostUpgrades)
    if (request.operation === 'settings.executors.refresh') return await executeSettingsExecutorRefreshControl(request, configOwner, runtimeIncidents ?? args.runtime)
    if (request.operation === 'settings.browser.links.list' || request.operation === 'settings.browser.links.forget') {
      return await executeSettingsBrowserControl(request, configOwner)
    }
    if (request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get' ||
        request.operation === 'settings.resource.add' || request.operation === 'settings.resource.update' ||
        request.operation === 'settings.resource.remove') return await executeSettingsResourcesControl(request, configOwner)
    const result = projectBrowserControlResult(await controlBridge.execute(request, signal))
    if (request.operation === 'focus' && request.inputPolicy === 'target' && result.operation === 'focus' && result.presentation.state === 'window' && result.presentation.windowId && result.presentation.documentGeneration) {
      try {
        if (!args.workbenchWindows.focusDocument({ windowId: result.presentation.windowId, documentGeneration: result.presentation.documentGeneration })) {
          result.partial = true; result.input.outcome = 'unconfirmed'
          result.issues.push({ step: 'input', code: 'NATIVE_WINDOW_FOCUS_UNCONFIRMED', message: 'Native focus has not been confirmed for the recorded workface window.', recovery: 'Keep using the original content; focus its recorded native window directly.' })
        }
      } catch (error) { result.partial = true; result.input.outcome = 'unconfirmed'; result.issues.push({ step: 'input', code: 'NATIVE_WINDOW_CHANGED', message: String(error), recovery: 'Inspect the original workface window before another explicit focus.' }) }
    }
    return result
  }
  const executeControl = (request: AgentMuxControlRequest, context?: AgentMuxNameContext, signal?: AbortSignal): Promise<AgentMuxControlResult> =>
    nameChangeRequests.run({ context: context ?? unknownNameContext(request.operation), operationId: request.requestId },
      () => executeControlOwner(request, signal))
  ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...values: TArgs) => nameChangeRequests.run({
      context: desktopNameContext(channel, event.sender, contents, args.window.id), operationId: mintObjectId()
    }, () => listener(...values)))
  }
  /**
   * 同上，但把 `event` 透传给 listener——需要校验发送者、或需要 `sender.id` 的那些频道用它。
   *
   * 存在的理由只有一个：注册与「登记到 `channels` 以便拆除」必须是同一次调用。此前这些频道直接写裸的
   * `ipcMain.handle`，于是每个都要手工在前面配一句 `channels.push('同一个字面量')`——同一个名字两个
   * 写入点。漏掉那一句的后果不是少个频道：handler 注册了但 `dispose` 时不会 `removeHandler`，下一个
   * 窗口跑 `registerIpc` 时 Electron 直接抛 "Attempted to register a second handler for 'X'"。
   * 而 `ipc-parity` 那道门是按 `ipcMain.handle` 的调用来数的，对「少了一句 push」完全隐身
   * （实测：删掉 `browser:selectElement` 那句 push，ipc-parity + preload-consumption 10 条全绿，
   * tsc 也 exit 0）。收成一次调用之后，这个漏点在构造上不存在。
   */
  const handleWithEvent = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...values: TArgs) => nameChangeRequests.run({
      context: desktopNameContext(channel, event.sender, contents, args.window.id), operationId: mintObjectId()
    }, () => listener(event, ...values)))
  }
  /**
   * 特权频道的发送者卫兵——不可信就抛。判据（身份比对 + 拒绝措辞）在纯的 `senderTrust` 里，处置（抛）
   * 在纯的 `assertSenderTrusted` 里，所以这个适配器体就是**一次转发表达式**：既没有可翻极性的比较符，
   * 也没有可插早退的语句位。每个会抛的特权 handler 第一句都调它。控制响应频道不走这里（它要静默返回）。
   */
  const requireTrustedSender = (channel: PrivilegedChannel, event: IpcMainInvokeEvent): void =>
    assertSenderTrusted(senderTrust(channel, event.sender, contents))
  handleWithEvent('clientIncidents:open', event => {
    requireTrustedSender('clientIncidents:open', event)
    return incidentIpc?.open(event) ?? null
  })
  handleWithEvent('clientIncidents:report', (event, token: string, report: unknown) => {
    requireTrustedSender('clientIncidents:report', event)
    return incidentIpc?.report(event, token, report) ?? { accepted: false }
  })
  registerLoadedIdentityIpc({ handleWithEvent, assertTrusted: requireTrustedSender, package: args.loadedPackage ?? null,
    renderer: () => contents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null })
  registerBrowserInputContextIpc({ handle: handleWithEvent, trust: requireTrustedSender, ...browserInputContextPorts })

  const acceptWorkbenchWindow = (event: Electron.IpcMainEvent, response: import('../shared/workbench-windows.js').WorkbenchWindowResponse) => args.workbenchWindows.accept(event, response)
  ipcMain.on(WORKBENCH_WINDOW_RESPONSE, acceptWorkbenchWindow)
  handleWithEvent('ui:workbenchWindowsReady', event => {
    requireTrustedSender('ui:workbenchWindowsReady', event)
    return args.workbenchWindows.rendererReady(event)
  })
  handleWithEvent('ui:workbenchWindowsCall', (event, method: import('@agentmux/core/control').AppWindowMethod, input: unknown) => {
    requireTrustedSender('ui:workbenchWindowsCall', event)
    return callUserRpc(method, input as never)
  })

  registerDeviceManagementIpc({ handleWithEvent, assertTrusted: requireTrustedSender })

  const resolveInputHistoryScope = (target: BrowserInputHistoryTarget): BrowserInputHistoryScope => {
    let scope: BrowserInputHistoryScope
    if (target?.kind === 'browser') scope = browsers.inputHistoryScope(target.browserId, target.profileId)
    else if (target?.kind === 'workspace') scope = {
      workspaceId: workspace(config, target.workspaceId).id, profileId: browserProfiles.defaultProfileId()
    }
    else throw new Error('Browser input history requires its original Browser or Workspace.')
    workspace(config, scope.workspaceId)
    if (scope.profileId !== null) browserProfiles.resolvePartition(scope.profileId)
    return scope
  }
  const requireInputHistoryScope = (target: BrowserInputHistoryTarget, expected: BrowserInputHistoryScope): BrowserInputHistoryScope => {
    const scope = resolveInputHistoryScope(target)
    if (expected?.workspaceId !== scope.workspaceId || expected?.profileId !== scope.profileId) {
      throw new Error('The input history scope changed. Reopen this input history before deleting.')
    }
    return scope
  }

  // The original Unix transport supplies the local user principal after the
  // original trusted Renderer check; the request cannot assert human provenance.
  const callUserRpc = async <M extends import('@agentmux/core').AgentMuxRpcMethod>(method: M, input: import('@agentmux/core').AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }) => {
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: control.path } })
    try { return await client.call(method, input, options) }
    finally { await client.dispose() }
  }
  handleWithEvent('applications:call', async (event, method: unknown, value: unknown) => {
    requireTrustedSender('applications:call', event)
    return sessionInputOperationResult(async () => {
      if (!isApplicationAccessMethod(method)) throw new AgentMuxError('Unsupported application access method.', 'INVALID_APPLICATION_ACCESS')
      return callUserRpc(method, parseApplicationAccessParams(method,value))
    })
  })
  handleWithEvent('capsules:call', async (event, method: unknown, value: unknown) => {
    requireTrustedSender('capsules:call', event)
    return sessionInputOperationResult(() => callCapsuleFromApp(args.runtime.callOriginalCore.bind(args.runtime), method, value))
  })
  handleWithEvent('capsules:reply', async (event, value: unknown) => {
    requireTrustedSender('capsules:reply', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('The original App main frame must confirm this answer.')
    return sessionInputOperationResult(() => capsuleReplies.confirm(value))
  })
  registerAgentLearningIpc({ handle: handleWithEvent, contents, runtime: args.runtime, authority: agentLearningAuthority })
  handleWithEvent('capsule:document', async (event, action: unknown, value: unknown) =>
    await sessionInputOperationResult(() => capsuleDocuments.call(event, action, value)))
  const conversationReads = registerConversationReadIpc({ handle: handleWithEvent, trust: requireTrustedSender,
    connect: () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: control.path } }) })
  handle('config:get', () => config)
  handle('config:save', async (next: AppConfig, expected: AppConfig) => await configOwner.edit(expected, next))
  const hostRuntimeReads = registerHostRuntimeObservationIpc({ handle: handleWithEvent, trust: requireTrustedSender,
    call: callUserRpc })
  handle('hosts:check', async (input: HostConfig) => await checkSettingsHost(input, args.runtime))
  const creationTrustPorts = { savedHost: (id: string) => config.hosts.find(host => host.id === id), call: callUserRpc }
  handleWithEvent('hosts:creationTrust', async (event, input: HostConfig) => {
    requireTrustedSender('hosts:creationTrust', event)
    return readHostCreationTrust(input, creationTrustPorts)
  })
  handleWithEvent('hosts:trustCreationSource', async (event, input: HostConfig, expected: import('../shared/contracts.js').HostCreationTrustSnapshot) => {
    requireTrustedSender('hosts:trustCreationSource', event)
    return approveHostCreationTrust(input, expected, creationTrustPorts)
  })
  handle('hosts:upgradeCheck', async (input: HostConfig) => await hostUpgrades.check(input))
  handle('hosts:upgrade', async (input: HostConfig, expected: RemoteCoreUpgradeExpected, operationId: string) => await hostUpgrades.upgrade(input, expected, operationId))
  handle('hosts:upgradeInspect', async (input: HostConfig, operationId: string) => await hostUpgrades.inspect(input, operationId))
  // The renderer is sandboxed and cannot open a native dialog, so choosing files to reference is a
  // main-process capability. It returns paths only — reading the file is the Agent's own job.
  handleWithEvent('ui:exportTheme', async (event, document: unknown, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('ui:exportTheme', event)
    const parent = args.workbenchWindows.windowForDocument(scope)
    return await exportThemeFile(document, {
      chooseFile: async filename => {
        const selection = await dialog.showSaveDialog(parent, { defaultPath: filename,
          filters: [{ name: 'AgentMux theme', extensions: ['json'] }] })
        return selection.canceled || !selection.filePath ? null : selection.filePath
      },
      writeFile: writeThemeFile
    })
  })
  handleWithEvent('ui:chooseFiles', async (event, input: { defaultPath?: string } | undefined, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('ui:chooseFiles', event)
    const selection = await dialog.showOpenDialog(args.workbenchWindows.windowForDocument(scope), {
      properties: ['openFile', 'multiSelections'],
      ...(input?.defaultPath ? { defaultPath: input.defaultPath } : {})
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return selection.filePaths
  })
  handleWithEvent('ui:chooseDirectory', async (event, input: { defaultPath?: string } | undefined, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('ui:chooseDirectory', event)
    const selection = await dialog.showOpenDialog(args.workbenchWindows.windowForDocument(scope), {
      properties: ['openDirectory'],
      ...(input?.defaultPath ? { defaultPath: resolveToolkitWorkspacePath(input.defaultPath, app.getPath('home')) } : {})
    })
    return selection.canceled ? null : selection.filePaths[0] ?? null
  })
  handle('workspaces:appearance', async (id: string) => {
    const item = workspace(config, id)
    return item.hostId === 'local' ? await projectAppearance(item.repoPath ?? item.path) : { kind: item.repoPath ? 'repository' : 'directory', icon: null }
  })
  handleWithEvent('workspaces:chooseLocalFolder', async (event, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('workspaces:chooseLocalFolder', event)
    const selection = await dialog.showOpenDialog(args.workbenchWindows.windowForDocument(scope), { properties: ['openDirectory'] })
    const path = selection.filePaths[0]
    if (selection.canceled || !path) return null
    return (await registerWorkspace({ hostId: 'local', path }, configOwner, id => args.runtime.executionHost(id))).workspace
  })
  // 重绑一个本地文件夹 Workspace。编排在 `workspace-rebind` 里，所以测试够得着：这个 handler
  // 只剩一个转发表达式，没有可以插早退的语句位置。文本守卫看不见这里的早退——插一句
  // `return null`，重绑对用户永久失效而 2 条断言全绿（见 rebindLocalFolder 的注释）。
  handleWithEvent('workspaces:rebindLocalFolder', async (event, workspaceId: string, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('workspaces:rebindLocalFolder', event)
    const result = await rebindLocalFolder(workspaceId, config, {
      chooseDirectory: async (defaultPath) =>
        await dialog.showOpenDialog(args.workbenchWindows.windowForDocument(scope), { properties: ['openDirectory'], defaultPath }),
      save: async (next, expected) => await configOwner.edit(expected, next)
    })
    return result.workspace
  })
  handle('workspaces:add', async (input: CreateWorkspaceInput) => {
    return (await registerWorkspace(input, configOwner, id => args.runtime.executionHost(id))).workspace
  })
  handle('workspaces:listBranches', async (workspaceId: string) => await worktrees.list(workspaceId, config))
  handle('workspaces:openBranch', async (workspaceId: string, branch: string) => {
    const selection = await worktrees.openBranch(workspaceId, branch, config)
    return selection
  })
  handle('workspaces:createWorktreeForBranch', async (input: CreateWorktreeForBranchInput) => {
    const selection = await worktrees.createForBranch(input, config)
    return selection
  })
  handle('workspaces:createZoneResource', input => createSpaceZoneResource(input as SpaceZoneResourceInput, {
    host: id => args.runtime.executionHost(id),
    config: () => config,
    topics: async () => {
      const scratch = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
      return scratch ? await args.scratchTopics.list(scratch) : []
    },
    worktrees,
    register: fields => registerWorkspace(fields, configOwner, id => args.runtime.executionHost(id))
  }))
  // 单条删除。与批量收尾（keepOneOfFanOut）共用同一个 teardown primitive，所以脏树保护在这条路上
  // 一样在场：`removeWorktree` 只在 git 确认后才撤记录。
  //
  // 关键取舍：拒绝在这里**不当异常往上抛**，而是作为 `retained` 正常返回。保护的全部意义就是让
  // 「这里还有活儿」这句话传到用户眼前，而 IPC 上的异常只剩一句被压平的字符串，调用方分不出
  //「git 挂了」和「有未提交改动，你要不要先看看」。两者要走的下一步完全不同。
  // 删之前先问一句：这条分支上有没有只存在于它自己身上的提交。
  //
  // 单独一个通道而不是塞进 removeWorktree 的返回值里——那时候已经删完了，话说晚了。这一问必须在
  // 确认框弹出**之前**答完，用户才有机会据此改主意。
  //
  // 永不抛：答不出来是一个正常答案（文案里如实说「没查出来」）。为了一句提示而挡住删除，属于
  // AGENTS.md 原则 11 的第 2 类——我们自己这段流程降级了，而用户的能力不该因此被收走。
  handle('workspaces:worktreeRemovalNotice', async (workspaceId: string): Promise<WorktreeRemovalNotice> => ({
    note: await worktrees.orphanCommitNote(workspaceId, config)
  }))
  handle('workspaces:removeWorktree', async (input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome> => {
    return await worktreeCloseout.close(input, mintObjectId())
  })
  // One fan-out. The orchestration lives in `fanout-request` so it is reachable from a test: this
  // handler is one forwarding expression with no statement position to disable. Text guards on this
  // file could not see an early return here — the whole fan-out returned `rejected` forever while
  // five assertions stayed green (see runFanOutRequest's comment for the measurement).
  handle('workspaces:runFanOut', async (input: RunFanOutInput): Promise<RunFanOutResult> =>
    await runFanOutRequest(input, {
      config: () => config,
      listBranches: async (workspaceId, current) => await worktrees.list(workspaceId, current),
      lanes: (source) => ({
        createWorktree: async (createInput, current) => {
          const selection = await worktrees.createForBranch(createInput, current)
          return { config: selection.config, workspace: selection.workspace }
        },
        launchAgent: async (launchInput, current) => {
          const launched = await args.runtime.launchAgent({
            executorId: launchInput.executorId,
            // 源仓库的 host——lane 的 worktree 就在同一台机器上。`source` 由 runFanOutRequest
            // 解析并交下来，这里不再自己查一遍：同一个概念查两次就会有两套失败文案。
            hostId: source.hostId,
            workspacePath: launchInput.workspacePath,
            prompt: launchInput.prompt,
            agentSessionId: mintAgentSessionId(),
            createOperationId: mintObjectId()
          }, current)
          return { sessionId: launched.created.agentSessionId }
        },
        removeWorktree: async (removeInput, current) => await worktrees.removeWorktree(removeInput, current)
      })
    })
  )
  // Closing a bake-off: keep the chosen lane, tear the rest down through the same teardown primitive.
  // The dirty-tree protection is not bypassed here — a lane holding uncommitted work comes back as
  // `retained` and stays on disk, because "it lost" is not a reason to discard someone's work.
  handle('workspaces:keepOneOfFanOut', async (input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome> => {
    return await worktreeCloseout.keepOne(input)
  })
  handle('git:commitDetails', async (workspaceId: string, input: import('../shared/git-contracts').GitCommitDetailsInput) =>
    await git.commitDetails(workspaceId, input, config))
  handle('git:commitDiff', async (workspaceId: string, descriptor: import('../shared/git-contracts').GitCommitDiffDescriptor) =>
    await git.commitDiff(workspaceId, descriptor, config))
  handle('git:projectIdentity', async (workspaceId: string) => await git.projectIdentity(workspaceId, config))
  handle('git:worktrees', async (input: import('../shared/git-contracts').GitWorktreesTarget) => await publicGit.call('git.worktrees', input))
  handle('git:history', async (workspaceId: string, input: import('../shared/git-contracts').GitHistoryInput) =>
    await git.history(workspaceId, input, config))
  handle('git:compareBranches', async (workspaceId: string, input: GitBranchCompareInput) =>
    await git.compareBranches(workspaceId, input, config))
  handle('git:branchDiff', async (workspaceId: string, descriptor: GitBranchDiffDescriptor) =>
    await git.branchDiff(workspaceId, descriptor, config))
  handle('git:status', async (workspaceId: string) => await git.status(workspaceId, config))
  handle('git:stage', async (workspaceId: string, path: string) => {
    await git.stage(workspaceId, path, config)
  })
  handle('git:commit', async (workspaceId: string, message: string) => {
    await git.commit(workspaceId, message, config)
  })
  // `workspacePath`, not `path`: `diff` is the one git verb whose coordinate is workspace-relative
  // (see the `git` surface doc in contracts.ts). Its neighbours here take repo-root-relative paths.
  handle(
    'git:diff',
    async (workspaceId: string, workspacePath: string) =>
      await git.diff(workspaceId, workspacePath, config)
  )
  handle('git:unstage', async (workspaceId: string, path: string) => {
    await git.unstage(workspaceId, path, config)
  })
  handle('git:discard', async (workspaceId: string, path: string, untracked: boolean) => {
    await git.discard(workspaceId, path, untracked, config)
  })
  handle('git:push', async (workspaceId: string, options?: GitPushOptions) => await git.push(workspaceId, config, options))
  handle('git:pull', async (workspaceId: string, options?: { strategy?: GitPullStrategy }) =>
    await git.pull(workspaceId, config, options)
  )
  handle('git:fetch', async (workspaceId: string, options?: GitRemoteOptions) => await git.fetch(workspaceId, config, options))
  handle('git:aheadBehind', async (workspaceId: string) => await git.aheadBehind(workspaceId, config))
  handle('gh:prReadiness', async (workspaceId: string) => await gh.prReadiness(workspaceId, config))
  handle('gh:createPullRequest', async (workspaceId: string, input: CreatePullRequestInput) =>
    await gh.createPullRequest(workspaceId, input, config))
  handle('files:readDirectory', async (workspaceId: string, path: string) =>
    await files.readDirectory(workspace(config, workspaceId), path)
  )
  handle('files:list', async (workspaceId: string, path?: string, limit?: number) =>
    await files.listFiles(workspace(config, workspaceId), path, limit)
  )
  const conversationLandmarks = new ConversationLandmarkStore()
  handleWithEvent('conversationLandmarks:list', (event, input: import('@agentmux/core/conversation').ConversationLandmarkQuery) => sessionObservationResult(async () => {
    requireTrustedSender('conversationLandmarks:list', event)
    return conversationLandmarks.list(input)
  }))
  handleWithEvent('conversationLandmarks:apply', (event, input: import('@agentmux/core/conversation').ConversationLandmarkWrite) => sessionObservationResult(async () => {
    requireTrustedSender('conversationLandmarks:apply', event)
    return conversationLandmarks.apply(input, { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') })
  }))
  const titleWorkspace = (resource: import('@agentmux/core').NoteResource) => {
    const current = config.workspaces.find(item => item.id === resource.workspaceId)
    return current?.hostId === resource.hostId && current.path === resource.workspacePath ? { ...current } : undefined
  }
  const notebookStore: AgentMuxNotebookStore = new AgentMuxNotebookStore(undefined, notesStorageOwner.storage, { title: {
    inspect: operationId => noteTitleWriter.inspect(operationId),
    write: intent => {
      const original = titleWorkspace(intent.resource)
      return original ? noteTitleWriter.write(original, intent) : Promise.resolve({ status: 'unavailable' as const, operationId: intent.operationId, reason: 'The exact original Host/Workspace is unavailable; no title write was issued.' })
    },
    current: async (noteId, resource) => {
      const original = titleWorkspace(resource)
      if (!original) return { status: 'unknown' as const, noteId, resource, reason: 'The exact original Host/Workspace mapping is unavailable.' }
      const observed = await noteTitleWriter.current(original, noteId, resource)
      return titleWorkspace(resource) ? observed : { status: 'unknown' as const, noteId, resource, reason: 'The original Host/Workspace mapping changed during this title read.' }
    }
  } })
  const noteTitleWriter: NoteTitleFileWriter = new NoteTitleFileWriter(files, notebookStore)
  const notebookObservation = createNotebookObservationServices(notebookStore, { files, workspace: id => config.workspaces.find(item => item.id === id) }, () => notesStorageReady)
  const noteFileWriter = new NoteFileWriter(files, { state: async () => { await notesStorageReady; return notebookStore.read() }, owner: notebookObservation.owner }, notebookStore)
  let noteSharedBlocks: NoteSharedBlockOwner
  const publicFiles = new FileReadOwner<WorkspaceRecord>({ share: { share: (input, context) => noteSharedBlocks.share(input, context), undoShare: (input, context) => noteSharedBlocks.undoShare(input, context), inspectShare: (input, context) => noteSharedBlocks.inspectShare(input, context) }, files: { writeBytes: (owner, input) => notesStorageOwner.write(owner, input, actual => files.writeBytes(actual, input)), writeSharedUndo: (owner, input, context, action, transferred) => notesStorageOwner.write(owner, input, actual => noteFileWriter.writeSharedUndo(actual, input, context, action, transferred)), createShared: (owner, input, context, source) => notesStorageOwner.write(owner, input, actual => noteFileWriter.createShared(actual, input, context, source)), read: noteFileWriter.read.bind(noteFileWriter), listFiles: files.listFiles.bind(files), history: noteFileWriter.history.bind(noteFileWriter), restore: (owner, input, context) => notesStorageOwner.write(owner, input, actual => noteFileWriter.restore(actual, input, context)), undo: (owner, input, context) => notesStorageOwner.write(owner, input, actual => noteFileWriter.undo(actual, input, context)), write: (owner, input, context) => notesStorageOwner.write(owner, input, actual => noteFileWriter.write(actual, input, context)) }, topicForDirectory: (workspace, directory) => args.scratchTopics.readForDirectory(workspace, directory), workspace: id => config.workspaces.find(item => item.id === id),
    retiredZone: async id => (await spatialState.read())?.graph.resources['zone:' + id],
    catalog: async () => { const state = await spatialState.read(); return state ? spatialCatalog(state.graph) : null } })
  const noteFileMutations = new NoteFileMutations(files, notebookStore.runWithWriteLease.bind(notebookStore))
  const sharedFileDeletion = new NoteSharedFileDeleteOwner(files, notebookStore)
  const sharedUndo = new NoteSharedUndoOwner({ files, workspaces: async () => ({ workspaces: config.workspaces, complete: true }), target: publicFiles.targetForNote.bind(publicFiles), read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles), history: notebookStore.readHistory.bind(notebookStore), operation: notebookStore.readHistoryOperation.bind(notebookStore), lease: notebookStore.runWithWriteLease.bind(notebookStore), delete: async (resource, input, context) => { const owner = titleWorkspace(resource); return owner ? notesStorageOwner.write(owner, input, actual => sharedFileDeletion.delete(actual, input, context)) : { status: 'unknown', code: 'NOTE_RESOURCE_CHANGED', message: 'The exact original shared deletion resource changed.' } } })
  noteSharedBlocks = new NoteSharedBlockOwner({ undo: sharedUndo, files: { read: publicFiles.read.bind(publicFiles), write: publicFiles.write.bind(publicFiles), createShared: publicFiles.createShared.bind(publicFiles), writeInverse: publicFiles.writeSharedInverse.bind(publicFiles) }, historyOperation: notebookStore.readHistoryOperation.bind(notebookStore), withWriteLease: notebookStore.runWithWriteLease.bind(notebookStore) })
  handleWithEvent('files:shareUndoPublic', async (event, input: import('@agentmux/core').FileShareUndoParams) => {
    requireTrustedSender('files:shareUndoPublic', event)
    const params = parseFileShareUndoParams(input)
    return parseFileShareUndoResult(await publicFiles.undoShare(params, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }), params)
  })
  handleWithEvent('files:sharePublic', async (event, input: import('@agentmux/core').FileShareParams) => {
    requireTrustedSender('files:sharePublic', event)
    const params = parseFileShareParams(input)
    return parseFileShareResult(await publicFiles.share(params, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }), params)
  })
  handleWithEvent('files:inspectSharePublic', async (event, input: import('@agentmux/core').FileShareInspectParams) => {
    requireTrustedSender('files:inspectSharePublic', event)
    const params = parseFileShareInspectParams(input)
    return parseFileShareInspectResult(await publicFiles.inspectShare(params, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }), params)
  })
  handleWithEvent('files:importPublic', async (event, input: import('@agentmux/core/files').FileImportParams) => { requireTrustedSender('files:importPublic', event); return publicFiles.import(input) })
  handleWithEvent('files:createPublic', async (event, input: import('@agentmux/core').FileCreateParams) => { requireTrustedSender('files:createPublic', event); return publicFiles.create(input, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }) })
  handleWithEvent('files:readPublic', async (event, input: import('@agentmux/core').FileReadParams) => {
    requireTrustedSender('files:readPublic', event)
    return await publicFiles.read(input)
  })
  handleWithEvent('files:historyPublic', async (event, input: import('@agentmux/core').FileHistoryParams) => {
    requireTrustedSender('files:historyPublic', event)
    const params = parseFileHistoryParams(input)
    return parseFileHistoryResult(await publicFiles.history(params), params)
  })
  handleWithEvent('files:restorePublic', async (event, input: import('@agentmux/core').FileRestoreParams) => {
    requireTrustedSender('files:restorePublic', event)
    const params = parseFileRestoreParams(input)
    return parseFileRestoreResult(await publicFiles.restore(params, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }), params)
  })
  handleWithEvent('files:undoPublic', async (event, input: import('@agentmux/core').FileUndoParams) => {
    requireTrustedSender('files:undoPublic', event)
    const params = parseFileUndoParams(input)
    return parseFileUndoResult(await publicFiles.undo(params, { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } }), params)
  })
  handle('files:read', async (workspaceId: string, path: string) => await noteFileWriter.read(workspace(config, workspaceId), path))
  handle('files:readPreview', async (workspaceId: string, path: string, options?: import('../shared/workspace-file-preview').WorkspaceFilePreviewReadOptions) =>
    await files.readPreview(workspace(config, workspaceId), path, options)
  )
  handleWithEvent('files:readPreviewResource', async (event, request: import('../shared/workspace-file-preview').WorkspacePreviewResourceRequest) => {
    requireTrustedSender('files:readPreviewResource', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File preview resources require the original application frame.')
    return await previewResources.read(request)
  })
  handleWithEvent('files:cancelPreviewResource', async (event, id: string) => {
    requireTrustedSender('files:cancelPreviewResource', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File preview resources require the original application frame.')
    previewResources.cancel(id)
  })
  handleWithEvent('files:openHtmlPreview', async (event, workspaceId: string, path: string, content: string) => {
    requireTrustedSender('files:openHtmlPreview', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('HTML preview requires the original application frame.')
    return await htmlPreviews.open(workspace(config, workspaceId), path, content)
  })
  handleWithEvent('files:releaseHtmlPreview', async (event, id: string) => {
    requireTrustedSender('files:releaseHtmlPreview', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('HTML preview requires the original application frame.')
    htmlPreviews.release(id)
  })
  handleWithEvent('files:renderDiagram', async (event, request: import('../shared/file-diagram').FileDiagramRequest) => {
    requireTrustedSender('files:renderDiagram', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('Diagram preview requires the original application frame.')
    return await diagramPreviews.render(request)
  })
  handleWithEvent('files:cancelDiagram', async (event, id: string) => {
    requireTrustedSender('files:cancelDiagram', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('Diagram preview requires the original application frame.')
    diagramPreviews.cancel(id)
  })
  handleWithEvent('files:build', async (event, workspaceId: string, request: import('../shared/file-build').FileBuildRequest) => {
    requireTrustedSender('files:build', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File build requires the original application frame.')
    return await builds.start(workspace(config, workspaceId), request)
  })
  handleWithEvent('files:inspectBuild', async (event, id: string) => {
    requireTrustedSender('files:inspectBuild', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File build requires the original application frame.')
    return builds.inspect(id)
  })
  handleWithEvent('files:cancelBuild', async (event, id: string) => {
    requireTrustedSender('files:cancelBuild', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File build requires the original application frame.')
    return await builds.cancel(id)
  })
  handleWithEvent('files:releaseBuild', async (event, id: string) => {
    requireTrustedSender('files:releaseBuild', event)
    if (event.senderFrame !== contents.mainFrame) throw new Error('File build requires the original application frame.')
    await builds.release(id)
  })
  handle('files:readBookmark', async (workspaceId: string, path: string) => {
    // 书签读这条走字节而不是 `files.read` 的 string：二进制 `.webloc` 过 utf8 会坏。种类由路径判，
    // 非书签返回 null。一次返回 {url, binary}：url 供 openFile 决定开 Browser 还是退回文本；binary
    // 供「查看源码」判断（二进制那一档不给，§2.7）。读失败/坏文件 url=null，binary 照字节如实报。
    const kind = bookmarkKindForPath(path)
    if (!kind) return null
    const bytes = await files.readBookmarkBytes(workspace(config, workspaceId), path)
    if (!bytes) return { url: null, binary: false }
    return await readBookmark(kind, bytes, runProcess)
  })
  handleWithEvent('files:write', async (event, workspaceId: string, input: WorkspaceFileWriteInput) =>
    notesStorageOwner.write(workspace(config, workspaceId), input, actual => noteFileWriter.write(actual, input,
      Object.is(event.sender, contents) ? { actor: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') } } : undefined))
  )
  handle('files:observe', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.observe(key, async () => (
      await files.observe(workspace(config, workspaceId), path, () => {
        if (contents.isDestroyed()) return
        contents.send(WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId, path })
      })
    ))
  })
  handle('files:unobserve', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.unobserve(key)
  })
  handle('files:create', async (workspaceId: string, input: CreateWorkspacePathInput) => {
    await noteFileMutations.create(workspace(config, workspaceId), input)
  })
  handle('files:move', async (input: MoveWorkspacePathInput) => await nameAudit.run([{
    target: { kind: 'workspace-path', id: JSON.stringify([input.source.workspaceId, input.source.path]) },
    location: { workspaceId: input.source.workspaceId, cwd: workspace(config, input.source.workspaceId).path,
      hostId: workspace(config, input.source.workspaceId).hostId, destinationWorkspaceId: input.destination.workspaceId },
    before: input.source.path, requested: input.destination.path
  }], () => noteFileMutations.move(workspace(config, input.source.workspaceId), workspace(config, input.destination.workspaceId), input),
  result => result.status === 'moved' ? { actual: input.destination.path } : {
    actual: result.finalLocation === 'source' ? input.source.path : null,
    status: result.finalLocation === 'source' ? 'failed' : 'unknown', reason: result.message
  }))
  handle('files:delete', async (workspaceId: string, path: string) => {
    await noteFileMutations.delete(workspace(config, workspaceId), path)
  })
  handle('files:openSystem', async (workspaceId: string, path: string) => {
    const error = await shell.openPath(await files.localPathForSystemOpen(workspace(config, workspaceId), path))
    if (error) throw new Error(error)
  })
  handle('files:reveal', async (workspaceId: string, path: string) => {
    shell.showItemInFolder(await files.localPathForReveal(workspace(config, workspaceId), path))
  })
  handle('scratch:readTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.read(workspace(config, workspaceId), topicId)
  )
  handle('scratch:listTopics', async (workspaceId: string) => {
    const topics = await args.scratchTopics.list(workspace(config, workspaceId))
    return { topics, issues: topics.issues ?? [] }
  })
  handle('scratch:ensureTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.ensure(workspace(config, workspaceId), topicId)
  )
  handle('scratch:ensureMote', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.ensureMote(workspace(config, workspaceId), topicId)
  )
  handle('scratch:setMoteArchived', async (workspaceId: string, topicId: string, archived: boolean, objectKey: string, expectedVersion: string) =>
    await args.scratchTopics.setMoteArchived(workspace(config, workspaceId), topicId, archived, objectKey, expectedVersion))
  handle('scratch:previewMoteAvatar', async (workspaceId: string, topicId: string, input: MoteAvatarInput, objectKey: string) =>
    await args.scratchTopics.previewAvatar(workspace(config, workspaceId), topicId, input, objectKey))
  handle('scratch:saveMoteAvatar', async (workspaceId: string, topicId: string, input: MoteAvatarInput, objectKey: string) =>
    await args.scratchTopics.saveAvatar(workspace(config, workspaceId), topicId, input, objectKey))
  handle('scratch:readMoteAvatar', async (workspaceId: string, topicId: string, ref: MoteAvatarRef, objectKey: string) =>
    await args.scratchTopics.readAvatar(workspace(config, workspaceId), topicId, ref, objectKey))
  handle('scratch:renameTitle', async (workspaceId: string, topicId: string, title: string) =>
    await args.scratchTopics.renameTitle(workspace(config, workspaceId), topicId, title)
  )
  handle('scratch:setWikiEnabled', async (workspaceId: string, topicId: string, enabled: boolean) =>
    await args.scratchTopics.setWikiEnabled(workspace(config, workspaceId), topicId, enabled)
  )
  handle('scratch:resetWiki', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.resetWiki(workspace(config, workspaceId), topicId)
  )
  const disposeGoalChanges = observeDesktopGoalChanges(args.runtime, (ids, snapshot) => { if (!contents.isDestroyed()) contents.send('demands:changed', ids, snapshot) }, message => { if (!contents.isDestroyed()) contents.send('demands:observationIssue', message) })
  const executeGoal = desktopGoalControl(args.runtime)
  const originalDiscussionAgent = async (hostId: string, agentSessionId: string) => {
    const clients = args.runtime.rpcClients().filter(item => item.hostId === hostId)
    if (clients.length !== 1) throw new AgentMuxError('The exact original discussion Host is unconfirmed. Its saved relationship is retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
    const client = clients[0]!.client, agent = await client.inspectAgentCreation(agentSessionId)
    const current = args.runtime.rpcClients().filter(item => item.hostId === hostId)
    if (current.length !== 1 || current[0]!.client !== client) throw new AgentMuxError('The original discussion Core owner changed during observation. Its binding and Session remain retained.', 'GOAL_DISCUSSION_UNCONFIRMED')
    if (agent.kind !== 'agent' || agent.agentSessionId !== agentSessionId || agent.hostId !== 'local' && agent.hostId !== hostId) throw new AgentMuxError('The original discussion Core Session is unconfirmed. No replacement was selected.', 'GOAL_DISCUSSION_UNCONFIRMED')
    return { ...agent, hostId }
  }
  handleWithEvent('goals:handoffDiscussion', async (event, input: import('@agentmux/host/goal-discussion-bindings').GoalDiscussionHandoff) => {
    requireTrustedSender('goals:handoffDiscussion', event)
    return handoffGoalDiscussion(input, { spatial: spatialState,
      goal: async goalId => (await args.runtime.callOriginalCore('local', 'goal.inspect', { goalId },
        { principal: { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'current') } })).goal,
      agent: originalDiscussionAgent })
  })
  handleWithEvent('goals:execute', async (event, request: AgentMuxControlRequest) => {
    requireTrustedSender('goals:execute', event)
    return executeGoal(parseAgentMuxControlRequest(request))
  })
  handleWithEvent('demands:delegation', async (event, method: 'goal.delegations' | 'goal.collect' | 'goal.patrol' | 'goal.patrol.continue', input: GoalDelegationParamsMap['goal.delegations' | 'goal.collect' | 'goal.patrol' | 'goal.patrol.continue']) => {
    requireTrustedSender('demands:delegation', event)
    if (!['goal.delegations', 'goal.collect', 'goal.patrol', 'goal.patrol.continue'].includes(method)) throw new AgentMuxError('This action requires its exact public Goal operation.', 'INVALID_CONTROL_REQUEST')
    return callUserRpc(method, parseGoalDelegationParams(method, input))
  })
  handle('demands:list', async () => readDesktopGoals(args.runtime))
  handleWithEvent('demands:inspectDispatch', async (event, reference: GoalDispatchReference) => {
    requireTrustedSender('demands:inspectDispatch', event); assertGoalDispatchReference(reference)
    return (await callUserRpc('goal.inspect', { goalId: reference.goalId })).goal?.dispatches?.find(item => item.operationId === reference.operationId) ?? null
  })
  handleWithEvent('demands:reconcileDispatch', async (event, reference: GoalDispatchReference) => {
    requireTrustedSender('demands:reconcileDispatch', event); assertGoalDispatchReference(reference)
    return reconcileDesktopGoalDispatch(args.runtime, reference)
  })
  const pmoGoal = async (intent: GoalPmoIntent) => {
    assertGoalPmoIntent(intent)
    const result = await executeGoal({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.show', requestId: mintObjectId(), demandId: intent.goalId })
    const goal = result.operation === 'demand.show' && result.demand ? hostGoalRecord(result.demand) : null
    if (!goal || intent.creationOperationId !== undefined && goal.creationOrigin?.operationId !== intent.creationOperationId)
      throw new AgentMuxError('The exact original PMO Goal creation is unconfirmed. Keep the Goal and original request.', 'CONTROL_REQUEST_CONFLICT')
    return goal
  }
  const confirmPmoParticipation = async (intent: GoalPmoIntent, control: AgentSessionControl, operationId: string, evidence: 'creation-input' | 'prompt-input') => {
    return confirmDesktopGoalParticipation(args.runtime, { goalId: intent.goalId,
      ...(intent.creationOperationId === undefined ? {} : { creationOperationId: intent.creationOperationId }),
      hostId: control.hostId, agentSessionId: control.agentSessionId, expectedRun: control.run, operationId, evidence })
  }
  handleWithEvent('demands:reconcilePmoCreation', async (event, intent: GoalPmoIntent, hostId: string, agentSessionId: string, createOperationId: string) => {
    assertManualPromptSenderTrusted(event.sender, contents)
    const created = await args.runtime.agentCreation(hostId, agentSessionId)
    if (created.kind === 'retired-agent' || !created.creation?.createdRun) throw new AgentMuxError('The original PMO creation Run is unconfirmed. Its Goal and source operation are retained.', 'CONTROL_UNAVAILABLE')
    return confirmPmoParticipation(intent, { kind: 'agent', hostId, agentSessionId, run: created.creation.createdRun }, createOperationId, 'creation-input')
  })
  handleWithEvent('demands:reconcilePmoInput', async (event, intent: GoalPmoIntent, session: AgentSessionControl, operationId: string) => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return confirmPmoParticipation(intent, session, operationId, 'prompt-input')
  })
  const disposeToolkitIpc = registerToolkitIpc(toolkit, (channel, handler) => handleWithEvent(channel, (event, ...values) => {
    assertToolkitSenderTrusted(event.sender, event.senderFrame, contents, contents.mainFrame)
    return handler(event, ...values)
  }))

  registerPerformanceCaptureIpc(metrics, (channel, handler) => handleWithEvent(channel, (event, input) => {
    assertToolkitSenderTrusted(event.sender, event.senderFrame, contents, contents.mainFrame)
    return handler(event, input)
  }))
  if (args.performanceHeap) registerHeapSnapshotFileIpc(args.performanceHeap, args.window, currentRendererCaptureTarget,
    (channel, handler) => handleWithEvent(channel, (event, input) => {
      assertToolkitSenderTrusted(event.sender, event.senderFrame, contents, contents.mainFrame)
      return handler(event, input)
    }))

  handleWithEvent('notesStorage:inspect', async (event, operationId?: string) => { requireTrustedSender('notesStorage:inspect', event); await notesStorageReady; return notesStorageOwner.inspect(operationId) })
  handleWithEvent('notesStorage:change', async (event, input: import('@agentmux/core/notebook-store').NotesStorageChange) => { requireTrustedSender('notesStorage:change', event); return notesStorageOwner.change(input) })
  const disposeNotebook = notebookStore.subscribe(observation => {
    if (!args.window.isDestroyed() && !contents.isDestroyed()) contents.send('notebook:changed', observation)
  })
  const notebookActor = { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') }
  handleWithEvent('notebook:resolve', async (event, input: import('../shared/notebook-observation').NotebookResolveRequest) => {
    requireTrustedSender('notebook:resolve', event)
    return notebookObservation.requests.resolve(event.sender, input)
  })
  handleWithEvent('notebook:graph', async (event, input: import('../shared/notebook-observation').NotebookGraphRequest) => {
    requireTrustedSender('notebook:graph', event)
    return notebookObservation.requests.graph(event.sender, input)
  })
  handleWithEvent('notebook:content', async (event, input: import('../shared/notebook-observation').NotebookContentRequest) => {
    requireTrustedSender('notebook:content', event)
    return notebookObservation.requests.content(event.sender, input)
  })
  handleWithEvent('notebook:cancelObservation', (event, requestId: string) => {
    requireTrustedSender('notebook:cancelObservation', event)
    notebookObservation.requests.cancel(event.sender, requestId)
  })
  handleWithEvent('notebook:actor', async event => { requireTrustedSender('notebook:actor', event); return notebookActor })
  handleWithEvent('notebook:read', async event => { requireTrustedSender('notebook:read', event); await notesStorageReady; return notebookStore.read() })
  handleWithEvent('notebook:apply', async (event, input: NotebookWrite) => {
    requireTrustedSender('notebook:apply', event)
    return notebookStore.apply(input, notebookActor)
  })
  const moteAvatarSources = new MoteAvatarSeriesOwner({ userRoot: join(homedir(), '.agentmux', 'avatars'), builtinRoot: join(app.getAppPath(), 'resources', 'avatar-series') })
  const moteAvatarWriter = createMoteAvatarWriter(configOwner,moteAvatarSources,args.scratchTopics,args.configStore)
  const moteAvatars = new MoteAvatarControl(moteAvatarSources, moteAvatarWriter, async path => {
    const error = await shell.openPath(path)
    if (error) throw Object.assign(new Error('The avatar folder could not be opened. Its created files are retained. ' + error), { code: 'AVATAR_SERIES_REVEAL_FAILED' })
  })
  handleWithEvent('moteAvatars:list', async event => {
    requireTrustedSender('moteAvatars:list', event)
    return moteAvatars.call('space.mote.avatar.list', {})
  })
  handleWithEvent('moteAvatars:preview', async (event, params: MoteAvatarSeriesParameterMap['space.mote.avatar.preview']) => {
    requireTrustedSender('moteAvatars:preview', event)
    return moteAvatars.call('space.mote.avatar.preview', params)
  })
  handleWithEvent('moteAvatars:read', async (event, params: MoteAvatarWriteParameterMap['space.mote.avatar.read']) => {
    requireTrustedSender('moteAvatars:read', event)
    return moteAvatars.call('space.mote.avatar.read', params)
  })
  handleWithEvent('moteAvatars:createSeries', async (event, params: MoteAvatarSeriesParameterMap['space.mote.avatar.series.create']) => {
    requireTrustedSender('moteAvatars:createSeries', event)
    return moteAvatars.call('space.mote.avatar.series.create', params)
  })
  handleWithEvent('moteAvatars:revealSeries', async (event, params: MoteAvatarSeriesParameterMap['space.mote.avatar.series.reveal']) => {
    requireTrustedSender('moteAvatars:revealSeries', event)
    return moteAvatars.call('space.mote.avatar.series.reveal', params)
  })
  handleWithEvent('moteAvatars:save', async (event, params: MoteAvatarWriteParameterMap['space.mote.avatar.save']) => {
    requireTrustedSender('moteAvatars:save', event)
    return moteAvatars.call('space.mote.avatar.save', params)
  })
  const topicKnowledge = new TopicKnowledgeOwner(args.scratchTopics, files, () => workspace(config, SCRATCH_WORKSPACE_ID))
  topicKnowledge.setFileReadPort(publicFiles)
  topicKnowledge.setSpatialPort(new TopicSpatialOwner({ state: spatialState,
    workspace: () => workspace(config, SCRATCH_WORKSPACE_ID), topics: () => topicKnowledge.listTopicSnapshots(),
    categories: () => topicKnowledge.listCategories(), ensureDefaultCategory: () => topicKnowledge.ensureDefaultCategoryContent() }))
  const spaceObjectImages = new SpaceObjectImages(async target => {
    if (target.kind === 'category') return topicKnowledge.categoryAppearanceDirectory(target.categoryId, target.objectKey)
    return { hostId: workspace(config, target.workspaceId).hostId,
      directoryPath: await topicKnowledge.topicAppearanceDirectory(target.workspaceId, target.topicId, target.objectKey) }
  })
  handleWithEvent('spaceObjects:appearance', async (event, target: SpaceObjectImageTarget) => {
    requireTrustedSender('spaceObjects:appearance', event); return spaceObjectImages.appearance(target)
  })
  handleWithEvent('spaceObjects:previewAvatar', async (event, target: SpaceObjectImageTarget, input: ObjectAvatarInput) => {
    requireTrustedSender('spaceObjects:previewAvatar', event); return spaceObjectImages.preview(target, input)
  })
  handleWithEvent('spaceObjects:saveAvatar', async (event, target: SpaceObjectImageTarget, input: ObjectAvatarInput) => {
    requireTrustedSender('spaceObjects:saveAvatar', event); return spaceObjectImages.save(target, input)
  })
  handleWithEvent('spaceObjects:readAvatar', async (event, target: SpaceObjectImageTarget, ref: ObjectAvatarRef) => {
    requireTrustedSender('spaceObjects:readAvatar', event); return spaceObjectImages.read(target, ref)
  })
  handleWithEvent('topics:call', async (event, method: import('@agentmux/core').TopicMethod, params: import('@agentmux/core').TopicParams<import('@agentmux/core').TopicMethod>) => {
    requireTrustedSender('topics:call', event)
    return args.runtime.callOriginalCore('local', method, params as never, { transport: 'unix' })
  })
  const disposeSpatial = spatialState.subscribe(state => {
    if(!args.window.isDestroyed() && !contents.isDestroyed()) contents.send('spatial:changed',state)
  })
  handleWithEvent('spatial:read',async event=>{requireTrustedSender('spatial:read',event);return spatialState.readForLayout()})
  handleWithEvent('spatial:openAgent', async (event, input: import('@agentmux/core').AgentMuxRpcParams<'agent.open'>) => {
    requireTrustedSender('spatial:openAgent', event)
    return await callUserRpc('agent.open', input)
  })
  handleWithEvent('spatial:commit',async (event,input:import('@agentmux/core/spatial-graph').AgentMuxSpatialCommit)=>{requireTrustedSender('spatial:commit',event);return spatialState.commit(input)})
  handleWithEvent('spatial:renameLabel', async (event, input: import('@agentmux/core/spatial-graph').AgentMuxDisplayLabelMutation) => {
    requireTrustedSender('spatial:renameLabel', event)
    if (!input || Object.keys(input).some(key => !['operationId', 'target', 'value', 'source', 'expectedNameRevision'].includes(key)) ||
        !input.target || !['agent-session', 'tab', 'zone'].includes(input.target.kind)) throw new Error('An exact supported label mutation is required.')
    const current = await spatialState.readForLayout()
    const regions = current?.graph.regions.filter(region => input.target.kind === 'agent-session' && region.agentSessionId === input.target.id) ?? []
    const tab = current?.graph.tabs.find(tab => input.target.kind === 'tab' && tab.tabId === input.target.id)
    const zone = current?.graph.zones.find(zone => input.target.kind === 'zone' && zone.zoneId === input.target.id)
    const sessions = input.target.kind !== 'agent-session' ? [] : args.runtime.rpcClients().flatMap(({ hostId, client }) => {
      try { return [{ hostId, session: client.agentSession(input.target.id) }] } catch { return [] }
    })
    const known = current && (tab || zone || regions.length > 0 || sessions.length > 0 ||
      (input.target.kind === 'agent-session' && displayLabel(current.graph, input.target)))
    if (!known) throw new Error('The original name target is unobserved. Keep the name and restore its original workface before retrying.')
    const context = desktopNameContext('spatial:renameLabel', event.sender, contents, args.window.id)
    const onlyRegion = regions.length === 1 ? regions[0] : undefined
    const regionTab = onlyRegion && current!.graph.tabs.find(tab => tab.tabId === onlyRegion.tabId)
    const onlySession = sessions.length === 1 ? sessions[0] : undefined
    return spatialState.mutateDisplayLabel(input, { ...context, source: input.source === 'manual' ? context.source : input.source,
      location: { ...context.location, targetKind: input.target.kind, targetId: input.target.id,
        workspaceId: tab?.workspaceId ?? zone?.workspaceId ?? regionTab?.workspaceId ?? null,
        tabId: tab?.tabId ?? onlyRegion?.tabId ?? null, regionId: onlyRegion?.regionId ?? null,
        agentSessionId: input.target.kind === 'agent-session' ? input.target.id : null,
        runId: onlySession?.session.run.runId ?? onlyRegion?.runId ?? null,
        hostId: onlySession?.hostId ?? zone?.hostId ?? onlyRegion?.execution?.hostId ?? null,
        cwd: onlySession?.session.workspacePath ?? zone?.directoryPath ?? onlyRegion?.execution?.cwd ?? null } })
  })
  handleWithEvent('spatial:retainLabels', async (event, values: { target: import('@agentmux/core/spatial-graph').AgentMuxNameTarget; value: string }[]) => {
    requireTrustedSender('spatial:retainLabels', event)
    if (!Array.isArray(values) || values.some(value => !value?.target || !['agent-session', 'tab', 'zone'].includes(value.target.kind))) throw new Error('Only observed original display names may be retained.')
    return spatialState.retainDisplayLabels(values)
  })
  handleWithEvent('spatial:nameHistory', async (event, input: { target?: import('@agentmux/core/spatial-graph').AgentMuxNameTarget; afterId?: string; limit?: number } = {}) => {
    requireTrustedSender('spatial:nameHistory', event); return spatialState.queryNameChanges(input)
  })
  handleWithEvent('spatial:confirmNameCommit', async (event, operationId: string) => {
    requireTrustedSender('spatial:confirmNameCommit', event)
    if (typeof operationId !== 'string' || !operationId) throw new Error('An exact original name operation is required.')
    return spatialState.confirmNameCommit(operationId)
  })
  handleWithEvent('ui:requestStorageFlush', async (event) => {
    requireTrustedSender('ui:requestStorageFlush', event)
    requireWorkbenchStorageAuthority(await observeWorkbenchStorageAuthority(contents.session, {
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData')
    }))
    // Electron returns void: this requests flush without claiming a disk acknowledgement.
    contents.session.flushStorageData()
  })
  handleWithEvent('ui:recordStartupFailure', (event, input: unknown) => {
    requireTrustedSender('ui:recordStartupFailure', event)
    if (event.senderFrame !== contents.mainFrame) return false
    return args.onRendererStartupFailure?.(input) ?? false
  })
  handleWithEvent('ui:rendererUpdateReady', (event, token: string) => {
    requireTrustedSender('ui:rendererUpdateReady', event)
    args.onRendererUpdateReady?.(token)
  })
  handleWithEvent('ui:openObjectLink', (event, rawUrl: string) => {
    requireTrustedSender('ui:openObjectLink', event)
    if (!args.spatialLinks) throw new Error('Object link navigation is unavailable in this window. The original workface and Agents are kept; retry the exact link in the main Desktop window.')
    args.spatialLinks.receive(rawUrl)
  })
  handleWithEvent('ui:inspectDefaultBrowser', event => { requireTrustedSender('ui:inspectDefaultBrowser', event); return inspectDefaultBrowser() })
  handleWithEvent('ui:openDefaultBrowserSettings', event => { requireTrustedSender('ui:openDefaultBrowserSettings', event); return openDefaultBrowserSettings() })
  handleWithEvent('ui:spatialLinksReady', event => {
    requireTrustedSender('ui:spatialLinksReady', event)
    args.spatialLinks?.ready((request, signal) => executeControl(request, undefined, signal), message => contents.send('ui:spatialLinkIssue', message),
      async (capsuleId, operationId, signal) => await args.runtime.callOriginalCore('local', 'capsule.open', { capsuleId, operationId },
        { transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }, signal }))
    args.webLinks?.ready((request, signal) => controlBridge.execute(request, signal), message => contents.send('ui:spatialLinkIssue', message))
  })
  const screenshotEditor = new SystemScreenshotEditor(() => config.appearance)
  const reportScreenshotIssue = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('Screen capture:', error)
    try { if (!contents.isDestroyed()) contents.send('ui:screenshotIssue', message) }
    catch (deliveryError) { console.warn('Screenshot issue delivery is unconfirmed:', deliveryError) }
    if (!BrowserWindow.getFocusedWindow() && Notification.isSupported())
      new Notification({ title: 'Screen capture needs attention', body: message }).show()
  }
  const screenCapture = new ScreenCapture({ home: app.getPath('home'), native: getDesktopNativeUiOwner,
    edit: (image, attachToDraft, complete, initialIssue) => screenshotEditor.edit(image, attachToDraft, complete, initialIssue), reportIssue: reportScreenshotIssue })
  const globalScreenshot = new GlobalScreenshot({ contents, focusedWindow: () => BrowserWindow.getFocusedWindow(),
    windowForDocument: document => args.workbenchWindows.windowForDocument(document),
    capture: attachToDraft => screenCapture.capture(attachToDraft), reportIssue: reportScreenshotIssue })
  registerNativeDesktopIpc({ capture: () => screenCapture.capture(true), native: getDesktopNativeUiOwner,
    handle: handleWithEvent, trust: requireTrustedSender })
  handleWithEvent('ui:openExternal', async (event, rawUrl: string) => {
    await openExternalFromRenderer(event, contents, rawUrl)
  })
  handleWithEvent('ui:nativeBrowserVisibility', (event, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('ui:nativeBrowserVisibility', event)
    return nativeChrome.visibility(scope)
  })
  handleWithEvent('ui:publishNativeOverlays', async (event, regions: NativeOverlayRegion[], scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('ui:publishNativeOverlays', event)
    return await nativeChrome.update(regions, scope)
  })
  handleWithEvent('ui:listAgentSkills', async (event, sessionId: string) => {
    requireTrustedSender('ui:listAgentSkills', event)
    const session = await args.runtime.resolveSession(sessionId, config)
    if (!session || session.kind !== 'agent') throw new Error('Agent session is unavailable')
    if (session.hostId !== 'local') throw new Error('Skill discovery is available for local Agents.')
    const catalog = (await args.runtime.providerCatalog()).find((item) => item.id === session.providerId)
    if (!catalog) throw new Error('Agent Provider is unavailable')
    return await discoverAgentSkills({ catalog, workspacePath: session.workspacePath, home: app.getPath('home') })
  })
  handleWithEvent('ui:listWorkspaceSkills', async (event, workspaceId: string, providerId: string) => {
    requireTrustedSender('ui:listWorkspaceSkills', event)
    const workspace = config.workspaces.find((item) => item.id === workspaceId)
    if (!workspace || workspace.hostId !== 'local') throw new Error('Workspace skill discovery is available for local workspaces.')
    const catalog = (await args.runtime.providerCatalog()).find((item) => item.id === providerId)
    if (!catalog) throw new Error('Agent Provider is unavailable')
    return await discoverAgentSkills({ catalog, workspacePath: workspace.path, home: app.getPath('home') })
  })
  handleWithEvent('ui:retainInputImage', async (event, input: { session: AgentSessionControl; bytes: Uint8Array; mimeType: string }) => {
    requireTrustedSender('ui:retainInputImage', event)
    const bytes = Buffer.from(input.bytes)
    const identity = parseFileUploadIdentity({ hostId: input.session.hostId, agentSessionId: input.session.agentSessionId, expectedRun: { runId: input.session.run.runId },
      operationId: mintObjectId(), name: 'image', mimeType: input.mimeType, byteLength: bytes.length, revision: fileUploadRevision(bytes) })
    try {
      const result = parseFileUploadResult(await callUserRpc('file.upload', { ...identity, dataBase64: bytes.toString('base64') }), identity)
      return { upload: identity, observation: result.status === 'uploaded' ? 'confirmed' : 'unavailable' }
    } catch { return { upload: identity, observation: 'unavailable' } }
  })
  handleWithEvent('ui:savePastedImage', async (event, input: { bytes: Uint8Array; extension: string }) => {
    requireTrustedSender('ui:savePastedImage', event)
    // A CLI Agent reads images from disk, so a paste becomes a file it can open. The renderer supplies
    // bytes only — never a destination — so it cannot aim this write anywhere.
    return (await savePastedImage(app.getPath('home'), input)).path
  })
  handle('ui:readPastedImage', (path: string) => readPastedImage(app.getPath('home'), path))
  handleWithEvent('ui:revealCrashLog', async (event) => {
    requireTrustedSender('ui:revealCrashLog', event)
    return await requestCrashLogReveal()
  })
  handleWithEvent('ui:notifyAgentAttention', async (event, input: AgentAttentionNotifyInput) => {
    requireTrustedSender('ui:notifyAgentAttention', event)
    // The renderer decided this deserves attention, which dwell mode to use, and whether the user asked
    // for a sound; main only delivers, and says so honestly when it cannot present in that mode.
    return notifier.notify(input)
  })
  handleWithEvent('ui:setAgentAttentionCount', (event, count: number) => {
    requireTrustedSender('ui:setAgentAttentionCount', event)
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Agent attention count must be a nonnegative safe integer.')
    if (process.platform !== 'darwin' || !app.dock) return false
    app.dock.setBadge(count === 0 ? '' : String(count))
    return true
  })
  handle('providers:list', async (options?: { observation: true }) => {
    if (options === undefined) return await args.runtime.providerCatalog()
    if (!options || options.observation !== true || Object.keys(options).some(key => key !== 'observation')) {
      throw new TypeError('Provider catalog requires an exact observation mode or a catalogue read.')
    }
    return await args.runtime.providerCatalog(options)
  })
  handle('executors:detect', async (executorId: AgentExecutorId, hostId: string) => await refreshSettingsExecutor(executorId, hostId, configOwner, runtimeIncidents ?? args.runtime))
  handle('executors:discover', async (hostId: string) => {
    if (typeof hostId !== 'string' || !hostId.length) throw new TypeError('An exact execution Host ID is required.')
    return await args.runtime.discoverExecutors(hostId)
  })
  handle('executors:register', async (hostId: string, input: import('@agentmux/core').AgentMuxHostExecutorConfigureInput) => {
    if (typeof hostId !== 'string' || !hostId.length) throw new TypeError('An exact execution Host ID is required.')
    return await args.runtime.configureExecutor(hostId, input)
  })
  handle('sessions:endpointWarnings', () => args.runtime.endpointWarningSnapshot())
  handle('sessions:snapshot', async () => {
    const snapshot = await args.runtime.snapshot(config)
    const preparation = { runtimeBindings: args.runtime.runtimeBindings() }
    try {
      await configOwner.update(current => configWithRuntimeBindings(current, preparation))
    } catch (error) { args.runtime.reportBindingSaveFailure(preparation, error) }
    const runtimeEndpointWarnings = [...new Map([
      ...args.runtime.endpointWarningSnapshot().map(warning => [JSON.stringify([warning.hostId, warning.step]), warning] as const),
      // A connection that completed during this read does not make an omitted endpoint a full
      // snapshot. Preserve that cut's unverified membership until the ordinary restored resync.
      ...(snapshot.runtimeEndpointWarnings ?? []).filter(warning => warning.scope !== 'observation' && warning.availability !== 'connected')
        .map(warning => [JSON.stringify([warning.hostId, warning.step]), warning] as const)
    ]).values()]
    return sessionSnapshotPayload({ ...snapshot, runtimeEndpointWarnings },
      args.environmentWarning?.(), app.getPath('home'))
  })
  handle('sessions:nativeSessions', async (input: import('../shared/contracts.js').NativeAgentSessionsInput) => args.runtime.nativeAgentSessions(input, config))
  handle('sessions:nativeHistoryPage', async (input: import('../shared/contracts.js').NativeAgentHistoryInput) => args.runtime.nativeAgentHistory(input, config))
  handle('sessions:nativeHistoryResource', async (input: import('../shared/contracts.js').NativeAgentHistoryResourceInput) => args.runtime.nativeAgentHistoryResource(input, config))
  handleWithEvent('sessions:launchAgent', async (event, input: AgentLaunchInput, goalPmo?: GoalPmoIntent) => sessionAgentLaunchResult(input, async () => {
    let capturedLauncher: Awaited<ReturnType<typeof captureGoalDiscussionLauncherLaunch>> = null
    try {
      if (input.agentMuxNote !== undefined || input.launcher !== undefined || input.toolWorkspace !== undefined) assertManualPromptSenderTrusted(event.sender, contents)
      capturedLauncher = await captureGoalDiscussionLauncherLaunch(input, { spatial: spatialState, workspaces: config.workspaces })
      if (goalPmo) {
        assertManualPromptSenderTrusted(event.sender, contents)
        await pmoGoal(goalPmo)
        if (goalPmo.creationOperationId !== undefined && input.createOperationId !== await goalPmoOperation(goalPmo, 'create')) throw new AgentMuxError('The original PMO creation operation changed.', 'CONTROL_REQUEST_CONFLICT')
      }
    } catch (error) {
      // This local sender check runs before entering Runtime or any launch dispatch.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)),
        { controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
    }
    const spatialIntent = launcherCreationSpatialIntent(input, config.workspaces)
    const result = spatialIntent ? await args.runtime.launchAgent(input, config, spatialIntent, executionBindings) : await args.runtime.launchAgent(input, config, undefined, executionBindings)
    try {
      const issue = await confirmGoalDiscussionLauncherLaunch(capturedLauncher, result, { spatial: spatialState, agent: originalDiscussionAgent })
      if (issue) result.placementIssue = issue
    }
    catch (error) { result.placementIssue = 'The original discussion binding is unconfirmed: ' + (error instanceof Error ? error.message : String(error)) }
    if (!result.placementIssue) delete result.placementIssue
    const creation = result.creation
    if (goalPmo && creation && result.created.agentSessionId === input.agentSessionId && creation.createOperationId === input.createOperationId && creation.initialPrompt === 'confirmed') {
      try {
        if (!creation.createdRun) throw new AgentMuxError('The original PMO creation Run is unconfirmed. Its Goal and source operation are retained.', 'CONTROL_UNAVAILABLE')
        await confirmPmoParticipation(goalPmo, { ...result.created, run: creation.createdRun }, creation.createOperationId, 'creation-input')
      }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { agentSessionId: result.created.agentSessionId, createOperationId: creation.createOperationId, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } }) }
    }
    if (!event.sender.isDestroyed()) return result
    // The observer disappearing does not authorize stopping an already-created Agent.
    // Its durable Session and operation remain queryable when the caller reconnects.
    throw Object.assign(new Error('The Agent was created, but its Desktop View disappeared before receiving the receipt. Inspect the original operation without relaunching.'),
      { code: 'CONTROL_OWNER_LOST', agentSessionId: result.created.agentSessionId, createOperationId: result.creation?.createOperationId,
        controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
  }))
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => sessionLaunchResult(() => args.runtime.launchTerminal(input, config)))
  handle('sessions:timeline', async (session: import('../shared/contracts.js').SessionHistoryReference) => await args.runtime.sessionTimeline(session))
  handle('sessions:dispatches', (session: import('../shared/contracts.js').SessionHistoryReference, options?: import('../shared/contracts.js').SessionDispatchPageOptions) => args.runtime.sessionDispatches(session, options))
  handle('sessions:dispatch', (session: import('../shared/contracts.js').SessionHistoryReference, sourceMessageId: string) => args.runtime.sessionDispatch(session, sourceMessageId))
  handleWithEvent('sessions:messages', async (event, session: import('../shared/contracts.js').SessionHistoryReference, options: import('../shared/contracts.js').SessionMessagePageOptions) => {
    requireTrustedSender('sessions:messages', event)
    return await args.runtime.sessionMessages(session, options)
  })
  handleWithEvent('sessions:message', async (event, session: import('../shared/contracts.js').SessionHistoryReference, messageId: string, notificationId?: string) => {
    requireTrustedSender('sessions:message', event)
    return await args.runtime.sessionMessage(session, messageId, notificationId)
  })
  handleWithEvent('sessions:notifyMessage', async (event, session: import('../shared/contracts.js').SessionHistoryReference, messageId: string, operationId: string) => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.notifySessionMessage(session, messageId, operationId)
  })
  handleWithEvent('sessions:inspectMessageNotification', async (event, session: import('../shared/contracts.js').SessionHistoryReference, messageId: string, operationId: string) => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.inspectSessionMessageNotification(session, messageId, operationId)
  })
  handleWithEvent('sessions:messageEvents', async (event, session: import('../shared/contracts.js').SessionHistoryReference, options?: import('../shared/contracts.js').SessionMessageEventsOptions) => {
    requireTrustedSender('sessions:messageEvents', event)
    return await args.runtime.sessionMessageEvents(session, options)
  })
  handleWithEvent('sessions:spawns', async (event, session: import('../shared/contracts.js').SessionHistoryReference, options: import('../shared/contracts.js').SessionSpawnPageOptions) => {
    requireTrustedSender('sessions:spawns', event)
    return await args.runtime.sessionSpawns(session, options)
  })
  handle('sessions:creation', async (hostId: string, agentSessionId: string) => await args.runtime.agentCreation(hostId, agentSessionId))
  handle('sessions:resolveCreationSessionId', async (hostId: string, createOperationId: string) => args.runtime.resolveCreationSessionId(hostId, createOperationId))
  handle('sessions:historySource', async (reference: import('../shared/contracts.js').SessionHistorySourceReference) => args.runtime.sessionHistorySource(reference))
  handle('sessions:historySources', async (options?: { observation: true }) => {
    if (options === undefined) return await args.runtime.sessionHistorySources()
    if (!options || options.observation !== true || Object.keys(options).some(key => key !== 'observation')) {
      throw new TypeError('History sources require an exact observation mode or a complete catalogue read.')
    }
    return await args.runtime.sessionHistorySources(options)
  })
  handle('sessions:historyPage', async (session: import('../shared/contracts.js').SessionHistoryReference, options?: SessionHistoryPageOptions) => (
    args.runtime.sessionHistoryPage(session, options, config)
  ))
  const searchReads = registerSearchIpc({ handle: handleWithEvent, trust: requireTrustedSender,
    query: (input, signal) => callUserRpc('app.search', input, { signal }) })
  const historyReads = new SessionHistoryReadOwners()
  handleWithEvent('sessions:readHistory', (event, token: string, reference: import('../shared/contracts.js').SessionHistoryReference,
    options: Omit<import('@agentmux/core').AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'>) => {
    requireTrustedSender('sessions:readHistory', event)
    return sessionInputOperationResult(() => historyReads.read(event.sender, token, signal => args.runtime.readSessionHistory(reference, options, signal)))
  })
  handleWithEvent('sessions:cancelHistoryRead', (event, token: string) => {
    requireTrustedSender('sessions:cancelHistoryRead', event)
    historyReads.cancel(event.sender.id, token)
  })
  handle('sessions:historyResource', async (session: import('../shared/contracts.js').SessionHistoryReference, input: import('@agentmux/core').AgentSessionHistoryResourceRequest) =>
    args.runtime.sessionHistoryResource(session, input, config))
  const historyObservations = new SessionHistoryObservationOwners((reference, listener, signal) =>
    args.runtime.observeSessionHistory(reference, listener, config, signal))
  handleWithEvent('sessions:observeHistory', async (event, token: string, session: import('../shared/contracts.js').SessionHistoryReference) => {
    requireTrustedSender('sessions:observeHistory', event)
    return await historyObservations.acquire(event.sender, token, session, observation => {
      if (!event.sender.isDestroyed()) event.sender.send(SESSION_HISTORY_OBSERVATION_CHANNEL, { token, observation })
    })
  })
  handleWithEvent('sessions:releaseHistoryObservation', (event, token: string) => {
    requireTrustedSender('sessions:releaseHistoryObservation', event)
    historyObservations.release(event.sender.id, token)
  })
  handleWithEvent('sessions:attach', async (event, session: SessionControl, afterSequence: number = 0) => sessionObservationResult(async () => {
    const result = await args.runtime.attachSession(event.sender.id, session, afterSequence, config)
    if (!event.sender.isDestroyed()) return result
    await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its Session Attachment was delivered.')
  }))
  handleWithEvent('sessions:replay', async (event, attachmentId: string, afterByte: number) => sessionObservationResult(async () => (
    args.runtime.readSessionReplay(event.sender.id, attachmentId, afterByte)
  )))
  handleWithEvent('sessions:refreshAttachment', async (event, session: SessionControl, attachmentId: string | null, afterByte: number) => sessionObservationResult(async () => {
    const result = await args.runtime.refreshSessionAttachment(event.sender.id, session, attachmentId, afterByte, config)
    if (!event.sender.isDestroyed()) return result
    if (attachmentId === null) await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its observation refresh was delivered.')
  }))
  handleWithEvent('sessions:detach', async (event, attachmentId: string) => {
    await args.runtime.detachSession(event.sender.id, attachmentId)
  })
  const progressTargetMatches = (loop: ContinuousProgressTarget, target: ContinuousProgressTarget): boolean =>
    loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId && loop.providerId === target.providerId && loop.workspacePath === target.workspacePath
  handleWithEvent('schedule:list', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.list']) => {
    requireTrustedSender('schedule:list', event)
    return callUserRpc('schedule.list', input)
  })
  handleWithEvent('schedule:inspect', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.inspect']) => {
    requireTrustedSender('schedule:inspect', event)
    return callUserRpc('schedule.inspect', input)
  })
  handleWithEvent('schedule:create', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.create']) => {
    requireTrustedSender('schedule:create', event)
    return callUserRpc('schedule.create', input)
  })
  handleWithEvent('schedule:pause', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.pause']) => {
    requireTrustedSender('schedule:pause', event)
    return callUserRpc('schedule.pause', input)
  })
  handleWithEvent('schedule:resume', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.resume']) => {
    requireTrustedSender('schedule:resume', event)
    return callUserRpc('schedule.resume', input)
  })
  handleWithEvent('schedule:cancel', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.cancel']) => {
    requireTrustedSender('schedule:cancel', event)
    return callUserRpc('schedule.cancel', input)
  })
  handleWithEvent('continuousProgress:list', async (event, target: ContinuousProgressTarget) => {
    requireTrustedSender('continuousProgress:list', event)
    return (await callUserRpc('agent.progress.list', { target })).loops
  })
  handleWithEvent('continuousProgress:goals', async (event, goalId: string) => {
    requireTrustedSender('continuousProgress:goals', event)
    return (await callUserRpc('goal.inspect', { goalId })).goalContinuations
  })
  handleWithEvent('continuousProgress:goalAction', async (event, goalId: string, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', expectedRevision: number, operationId: string) => {
    requireTrustedSender('continuousProgress:goalAction', event)
    return (await callUserRpc('goal.continuation-action', { goalId, loopId, action, expectedRevision, operationId })).continuation
  })
  handleWithEvent('continuousProgress:create', async (event, target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource) => {
    requireTrustedSender('continuousProgress:create', event)
    if (taskSource?.kind === 'goal') throw new AgentMuxError('Goal continuation requires its original explicit Goal Start.', 'INVALID_CONTROL_REQUEST')
    return (await callUserRpc('agent.progress.create', { target, intervalMs, prompt, ...(taskSource ? { taskSource } : {}), operationId: mintObjectId() })).loop
  })
  handleWithEvent('continuousProgress:action', async (event, target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check', expectedLoop: import('@agentmux/core').ContinuousProgressLoop, operationId: string) => {
    requireTrustedSender('continuousProgress:action', event)
    return (await callUserRpc('agent.progress.action', { target, loopId, action, expectedLoop, operationId })).loop
  })
  handleWithEvent('continuousProgress:update', async (event, input: import('../shared/continuous-progress').ProgressUpdateRequest): Promise<import('../shared/continuous-progress').ProgressUpdateResult> => {
    requireTrustedSender('continuousProgress:update', event)
    try { return { ok: true, loop: (await callUserRpc('agent.progress.update', input)).loop } }
    catch (error) {
      return { ok: false, error: { ...(error instanceof AgentMuxError ? { code: error.code } : {}), message: error instanceof Error ? error.message : String(error) } }
    }
  })
  const pauseAutomaticInput = async (control: AgentSessionControl) => {
    const context = { principal: { kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') } }
    const owner = (await args.runtime.callOriginalCore(control.hostId, 'runtime.owner.identity', {}, context)).owner
    const target = { agentSessionId: control.agentSessionId, expectedRun: control.run, ownerInstanceId: owner.ownerInstanceId, operationId: mintObjectId() }
    const outcome = await args.runtime.callOriginalCore(control.hostId, 'agent.automation.pause', target, context)
    if (outcome.receipt?.status !== 'confirmed') throw new AgentMuxError('The original automatic pause is unconfirmed. Keep operation ' + target.operationId + ' on owner ' + target.ownerInstanceId + '; manual input remains available.', 'CONTROL_UNAVAILABLE')
  }
  const pauseUserProgress = (session: SessionControl, _reason: string): void => {
    if (session.kind === 'agent') void pauseAutomaticInput(session).catch(error => console.warn('Original automatic pause is unconfirmed; manual input remains available:', error))
  }
  handleWithEvent('continuousProgress:pauseForInput', async (event, control: AgentSessionControl) => {
    requireTrustedSender('continuousProgress:pauseForInput', event)
    await pauseAutomaticInput(control)
  })
  handleWithEvent('sessions:inputOccupation', async (event, control: AgentSessionControl) => {
    requireTrustedSender('sessions:inputOccupation', event)
    await pauseAutomaticInput(control)
  })
  handleWithEvent('sessions:write', async (event, session: SessionControl, data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source'], observation?: import('@agentmux/core/control').InputObservationReference): Promise<SessionInputWriteResult> => {
    if (source === 'user' && data.length > 0) pauseUserProgress(session, 'Paused for your terminal input.')
    return await sessionInputWriteResult(() => args.runtime.write(session, data, source, readInputObservation(observation) ?? undefined,
      inputSender(event)))
  })
  handleWithEvent('sessions:paste', async (event, session: SessionControl, text: string, terminalData: string, observation?: import('@agentmux/core/control').InputObservationReference): Promise<SessionInputWriteResult> => {
    if (text.length > 0) pauseUserProgress(session, 'Paused for your paste.')
    return await sessionInputWriteResult(() => args.runtime.paste(session, text, terminalData, readInputObservation(observation) ?? undefined,
      inputSender(event)))
  })
  handleWithEvent('sessions:recordDeliveryFailure', async (event, input: DeliveryAttempt) => {
    requireTrustedSender('sessions:recordDeliveryFailure', event)
    const record = parseDeliveryAttempt(input)
    if (record.source !== 'client' || record.observation !== undefined || record.reporter !== undefined) {
      throw new AgentMuxError('Client reports cannot author Core Input or authenticated identity.', 'CONTROL_PERMISSION_DENIED')
    }
    return await deliveryAttempts.store.record({ ...record,
      reporter: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}`, receivedAt: Date.now(), routeHostId: deliveryAttempts.hostId } })
  })
  handleWithEvent('sessions:submitPrompt', async (
    event,
    session: AgentSessionControl,
    prompt: string,
    operationId: string,
    condition: import('@agentmux/core').AgentPromptInputBinding,
    choice?: Parameters<RuntimeController['submitPrompt']>[5],
    authorHuman?: boolean,
    agentMuxNote?: string,
    sourceChannel?: Parameters<RuntimeController['submitPrompt']>[8],
    goalContinuation?: { goalId: string; loopId: string },
    goalPmo?: GoalPmoIntent,
    goalDispatch?: GoalDispatchReference,
    inputContextCapture?: import('@agentmux/core/agent-input-context-capture').AgentInputContextCaptureReference,
    inputImages?: readonly import('@agentmux/core').AgentInputImageReference[]
  ): Promise<SessionInputWriteResult> => sessionInputWriteResult(async () => {
    let effectiveAuthorHuman = false
    if (inputContextCapture !== undefined || inputImages !== undefined) assertManualPromptSenderTrusted(event.sender, contents)
    if ('admissionIntent' in condition) {
      assertManualPromptSenderTrusted(event.sender, contents)
      if (goalContinuation || goalPmo || goalDispatch) throw new AgentMuxError('The original Goal input cannot become a new manual message.', 'CONTROL_REQUEST_CONFLICT')
      pauseUserProgress(session, 'Paused for your message.')
      return await args.runtime.submitPrompt(session, prompt, operationId, condition, undefined, choice, authorHuman, agentMuxNote, sourceChannel, inputContextCapture, inputImages, authorHuman === true ? preparePublicUserProfile(config.profile) : undefined)
    }
    if (goalPmo) {
      assertManualPromptSenderTrusted(event.sender, contents)
      await pmoGoal(goalPmo)
      if (goalPmo.creationOperationId !== undefined && operationId !== await goalPmoOperation(goalPmo, 'discussion')) throw new AgentMuxError('The original PMO discussion operation changed.', 'CONTROL_REQUEST_CONFLICT')
    }
    if (agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, contents)
    if (authorHuman === true) {
      assertManualPromptSenderTrusted(event.sender, contents)
      effectiveAuthorHuman = true
    }
    if (sourceChannel !== undefined) assertManualPromptSenderTrusted(event.sender, contents)
    if (goalPmo || goalDispatch || goalContinuation) {
      const goalId = goalPmo?.goalId ?? goalDispatch?.goalId ?? goalContinuation!.goalId
      const original = await args.runtime.inspectGoalAttention({ hostId: session.hostId, supervisorAgentSessionId: session.agentSessionId,
        supervisorRunId: session.run.runId, operationId })
      agentMuxNote = goalRoleInputNote(agentMuxNote, { role: goalPmo ? 'manager' : 'executor', goalId,
        agentSessionId: session.agentSessionId, runId: session.run.runId, source: { kind: goalPmo ? 'goal-discussion' : goalContinuation ? 'goal-native-continuation' : 'goal-start', operationId } }, original)
    }
    if (goalDispatch || goalContinuation) {
      assertManualPromptSenderTrusted(event.sender, contents)
      const goalId = goalDispatch?.goalId ?? goalContinuation!.goalId
      if (goalPmo || goalDispatch && goalDispatch.operationId !== operationId) throw new AgentMuxError('The original Goal Start operation changed.', 'CONTROL_REQUEST_CONFLICT')
      const goal = await callUserRpc('goal.inspect', { goalId })
      const loop = goalContinuation ? goal.goalContinuations.find(loop => loop.loopId === goalContinuation.loopId) : undefined
      if (goalContinuation && (!loop || loop.creationOperationId !== operationId || loop.initialDelivery?.prompt !== prompt || loop.hostId !== session.hostId || loop.agentSessionId !== session.agentSessionId || loop.initialDelivery.condition.expectedRun.runId !== session.run.runId)) throw new AgentMuxError('The original Goal input or target is unconfirmed. Inspect its retained Host request.', 'CONTROL_REQUEST_CONFLICT')
      await executeGoal({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, operation: 'demand.start', requestId: operationId, demandId: goalId, sessionId: session.agentSessionId,
        ...(loop?.taskSource?.kind === 'goal' ? { continuation: { intervalMs: loop.intervalMs, alignmentRevision: loop.taskSource.alignmentRevision } } : {}) })
    } else {
      pauseUserProgress(session, 'Paused for your message.')
      await args.runtime.submitPrompt(session, prompt, operationId, condition, undefined, choice, effectiveAuthorHuman, agentMuxNote, sourceChannel, inputContextCapture, inputImages, effectiveAuthorHuman ? preparePublicUserProfile(config.profile) : undefined)
    }
    if (goalPmo) {
      const original = await args.runtime.agentCreation(session.hostId, session.agentSessionId)
      if (original.agentSessionId !== session.agentSessionId) throw new AgentMuxError('The confirmed PMO recipient changed.', 'CONTROL_REQUEST_CONFLICT')
      await confirmPmoParticipation(goalPmo, session, operationId, 'prompt-input')
    }
  }))
  handleWithEvent('sessions:replyQuestion', async (event, session: AgentSessionControl,
    input: import('../shared/contracts.js').SessionQuestionReplyInput) => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.replyQuestion(session, input, config)
  })
  handleWithEvent('sessions:inputMailbox', async (event, session: import('../shared/contracts.js').SessionHistoryReference,
    options?: Omit<import('@agentmux/core/agent-input-mailbox').AgentInputMailboxRead, 'agentSessionId'>) => {
    requireTrustedSender('sessions:inputMailbox', event)
    return await args.runtime.inputMailbox(session, options)
  })
  handleWithEvent('sessions:inspectInput', async (event, session: AgentSessionControl, key: import('@agentmux/core').AgentPromptInputKey) => sessionInputOperationResult(async () => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.inspectInput(session, key)
  }))
  handleWithEvent('sessions:stopInputWaiting', async (event, session: AgentSessionControl, ref: import('@agentmux/core').AgentInputWaitRef, cancelOperationId: string) => sessionInputOperationResult(async () => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.stopInputWaiting(session, ref, cancelOperationId)
  }))
  handleWithEvent('sessions:rejoinInputWaiting', async (event, session: AgentSessionControl, ref: import('@agentmux/core').AgentInputWaitRef) => sessionInputOperationResult(async () => {
    assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.rejoinInputWaiting(session, ref)
  }))
  handle('sessions:respondInteraction', async (
    session: AgentSessionControl,
    response: AgentMuxInteractionResponse,
    intent: import('@agentmux/core').AgentMuxInteractionOperationIntent
  ) => await args.runtime.respondInteraction(session, response, intent))
  handle('sessions:inspectInteraction', async (session: AgentSessionControl, operationId: string) => await args.runtime.inspectInteraction(session, operationId))
  handle('sessions:setPosture', async (session: AgentSessionControl, modeId: string) => {
    await args.runtime.setPosture(session, modeId)
  })
  handle('sessions:confirmNativeSession', async (session: AgentSessionControl, input: import('@agentmux/core').AgentMuxNativeSessionConfirmationInput) => (
    args.runtime.confirmNativeSession(session, input)
  ))
  handle('sessions:reconcile-reopen', async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
    sessionReopenResult(() => args.runtime.reconcileRetiredSession(reference, expectedRetiredAt, operationId, config)))
  handle('sessions:reopen', async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
    sessionReopenResult(() => args.runtime.reopenRetiredSession(reference, expectedRetiredAt, operationId, config)))
  handleWithEvent('sessions:resume', async (event, session: AgentSessionControl, prompt: string, operationId: string, agentMuxNote?: string) => {
    if (agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, contents)
    return await args.runtime.resumeSession(session, prompt, operationId, config, agentMuxNote)
  })
  handle('sessions:interrupt', async (session: SessionControl) => { pauseUserProgress(session, 'Paused because you interrupted the Agent.'); await args.runtime.interrupt(session) })
  handleWithEvent('sessions:resize', async (event, attachmentId: string, cols: number, rows: number) => (
    await args.runtime.resizeSessionAttachment(event.sender.id, attachmentId, cols, rows)
  ))
  handle('sessions:observeStorage', async (session: SessionControl) => await args.runtime.observeStorage(session))
  handle('sessions:controlContinuity', async (hostId: string, input: import('@agentmux/core/agent-session-recovery').AgentMuxContinuityControlInput) => await sessionObservationResult(() => args.runtime.controlContinuity(hostId, input)))
  handle('sessions:refresh', async (session: SessionControl) => await args.runtime.refresh(session, config))
  handle('sessions:recover', async (session: SessionControl, workspacePath?: string, operationId?: string, request?: Pick<import('@agentmux/core/agent-session-recovery').AgentMuxAgentContinuityInput, 'trigger' | 'timingOverride' | 'input'>) => await sessionRecoveryOperationResult(() => args.runtime.recoverSession(session, config, workspacePath, operationId, request)))
  handleWithEvent('sessions:restart', async (event, session: AgentSessionControl, operationId: string, observeOnly?: boolean) => {
    requireTrustedSender('sessions:restart', event)
    if (!observeOnly) pauseUserProgress(session, 'Paused because you restarted this Agent. Resume explicitly when ready.')
    return await sessionObservationResult(() => args.runtime.restartSession(session, config, operationId, observeOnly))
  })
  handle('sessions:stop', async (session: SessionControl) => { pauseUserProgress(session, 'Paused because you stopped the Agent.'); await args.runtime.stopSession(session) })
  handle('browser:forgetAppLinkScheme', async (scheme: string, expected: AppLinkSchemeChoice) => {
    if (!APP_LINK_SCHEME_CHOICES.includes(expected)) {
      throw Object.assign(new Error('The displayed app-link choice is required.'), { code: 'INVALID_SETTING_VALUE' })
    }
    await forgetBrowserAppLink(configOwner, scheme, expected)
  })
  handleWithEvent('browser:listRetainedUploads', async event => {
    requireTrustedSender('browser:listRetainedUploads', event)
    return await browserUploads.retained()
  })
  handleWithEvent('browser:discardRetainedUpload', async (event, selectionId: string, scope?: import('../shared/workbench-windows.js').WorkbenchWindowDocument) => {
    requireTrustedSender('browser:discardRetainedUpload', event)
    const parent = args.workbenchWindows.windowForDocument(scope)
    return await browserUploads.confirmDiscardSelection(selectionId, async selection => {
      if (parent.isDestroyed()) return false
      const answer = await dialog.showMessageBox(parent, { type: 'warning', title: 'Discard selected files?',
        message: '原页面后续上传将不可读，先完成或取消上传',
        detail: `${selection.files.join(', ') || 'Unknown document selection'}\n${selection.byteLength} bytes will be removed. Other pages and selections are kept.`,
        buttons: ['Keep files', 'Discard files'], defaultId: 0, cancelId: 0, noLink: true })
      return !parent.isDestroyed() && answer.response === 1
    })
  })
  handleWithEvent('browser:listTargets', async (event, workspaceId?: string) => {
    requireTrustedSender('browser:listTargets', event)
    if (workspaceId !== undefined) workspace(config, workspaceId)
    let identities: Map<number, number> | null = null
    try { identities = new Map(app.getAppMetrics().map(process => [process.pid, process.creationTime])) } catch { /* Process ownership remains unknown; catalog membership is separate. */ }
    const live = [...browsers.resourceTargets(identities), ...externalBridge.list()]
    const warnings: string[] = []
    if (externalBridge.membershipCoverage === 'partial') warnings.push('Shared Browser membership is unconfirmed. Previously observed entries remain; retry discovery.')
    let coverage: import('@agentmux/core').AgentMuxBrowserTargetsResult['coverage'] = 'partial'
    let cold: import('@agentmux/core').AgentMuxBrowserTarget[] = []
    let graph: import('@agentmux/core/spatial-graph').AgentMuxSpatialGraph | null = null
    try {
      const saved = await spatialState.read()
      if (saved) {
        graph = saved.graph
        cold = coldBrowserTargets(graph, live).map(target => ({ ...target, resource: { state: 'cold', locations: [], processes: [] } }))
        coverage = externalBridge.membershipCoverage
      } else warnings.push('Saved Browser ownership is unconfirmed. Existing live targets remain usable; retry discovery.')
    }
    catch { warnings.push('Saved Browser discovery is unconfirmed. Existing live targets remain usable; retry discovery.') }
    const targets = browserResourceLocations([...live, ...cold], graph).filter(row => workspaceId === undefined || row.workspaceId === workspaceId)
    return { targets, coverage, ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
  })
  handleWithEvent('browser:createExternalPairing', async (event, workspaceId: string) => {
    requireTrustedSender('browser:createExternalPairing', event)
    workspace(config, workspaceId)
    return await externalBridge.createPairing(workspaceId)
  })
  handleWithEvent('browser:revealExternalExtension', async event => {
    requireTrustedSender('browser:revealExternalExtension', event)
    const directory = join(app.getAppPath(), 'browser-extension')
    const error = await shell.openPath(directory)
    if (error) throw new Error(`The Browser extension folder could not be opened: ${error}`)
  })
  handleWithEvent('browser:stopSharingExternal', (event, id: string) => {
    requireTrustedSender('browser:stopSharingExternal', event)
    externalBridge.stopSharing(id)
  })
  handle('browser:create', async (id: string, url: string, workspaceId: unknown, rememberedProfileId?: string, mode?: import('@agentmux/core').AgentMuxBrowserMode, viewport?: BrowserViewport, capsuleId?: string, capsuleOpenOperationId?: string) => {
    const verifiedWorkspaceId = verifiedBrowserWorkspace(config.workspaces, workspaceId)
    if (capsuleId !== undefined) {
      return await createCapsuleBrowserDocument({ inspect: capsuleId => capsuleClient.call('capsule.inspect', { capsuleId }), browsers },
        { id, url, workspaceId: verifiedWorkspaceId, rememberedProfileId, mode, viewport, capsuleId, operationId: capsuleOpenOperationId })
    }
    if (capsuleOpenOperationId !== undefined) throw new Error('A Capsule open operation requires its original page identity.')
    if (mode !== 'private') await browserProfiles.initialize()
    return await browsers.create(id, url, verifiedWorkspaceId, rememberedProfileId, mode, viewport)
  })
  handle('browser:navigate', async (id: string, url: string) => { await ensureBrowser(id); return await browsers.navigate(id, url) })
  handle('browser:back', async (id: string) => { await ensureBrowser(id); return await browsers.back(id) })
  handle('browser:forward', async (id: string) => { await ensureBrowser(id); return await browsers.forward(id) })
  handle('browser:reload', async (id: string) => {
    await ensureBrowser(id)
    const capsuleId = browsers.capsuleId(id)
    return capsuleId ? await browsers.reloadCapsule(id, await capsuleClient.call('capsule.inspect', { capsuleId }))
      : await browsers.reload(id)
  })
  handleWithEvent('browser:getRecoveryPreview', async (event, id: string): Promise<BrowserRecoveryPreviewReadResult> => {
    requireTrustedSender('browser:getRecoveryPreview', event)
    try {
      const scope = await resolveRecoveryPreviewScope(id)
      if (!scope) return {
        status: 'unavailable', warning: 'The original Browser Profile for this preview is unconfirmed. The page and Retry remain available.'
      }
      return await browserRecoveryPreviews.read(scope)
    } catch {
      return { status: 'unavailable', warning: 'The original Browser preview could not be read. The page and Retry remain available.' }
    }
  })
  handleWithEvent('browser:switchProfile', async (event, id: string, profileId: string) => {
    requireTrustedSender('browser:switchProfile', event)
    await ensureBrowser(id)
    return await browsers.switchProfile(id, profileId)
  })
  handleWithEvent('browser:listProfiles', async (event) => {
    requireTrustedSender('browser:listProfiles', event)
    await browserProfiles.initialize()
    return browserProfiles.listProfiles()
  })
  handleWithEvent('browser:createProfile', async (event, label: string) => {
    requireTrustedSender('browser:createProfile', event)
    return await browserProfiles.createProfile(label)
  })
  handleWithEvent('browser:deleteProfile', async (event, profileId: string, approval: BrowserProfileDeleteApproval) => {
    requireTrustedSender('browser:deleteProfile', event)
    if (browsers.usesProfile(profileId)) {
      throw new Error('Browser Profile is still used by an open Browser')
    }
    await browserProfiles.deleteProfile(profileId, approval)
    const cleared = await browserRecoveryPreviews.clearProfile(profileId)
    if (cleared.status === 'unavailable') console.warn('Browser Profile was deleted; its historical preview cleanup is unconfirmed:', cleared.warning)
  })
  handleWithEvent('browser:detectProfileImportSources', async (event) => {
    requireTrustedSender('browser:detectProfileImportSources', event)
    return await browserProfiles.detectImportSources()
  })
  handleWithEvent('browser:importProfile', async (event, sourceToken: string, label: string) => {
    requireTrustedSender('browser:importProfile', event)
    return await browserProfiles.importProfile(sourceToken, label)
  })
  handleWithEvent('browser:listInputHistory', async (event, target: BrowserInputHistoryTarget) => {
    requireTrustedSender('browser:listInputHistory', event)
    const scope = resolveInputHistoryScope(target)
    return scope.profileId === null ? { scope, entries: [] } : await browserInputHistory.list(scope)
  })
  handleWithEvent('browser:recordInputHistory', async (event, target: BrowserInputHistoryTarget, text: string) => {
    requireTrustedSender('browser:recordInputHistory', event)
    const scope = resolveInputHistoryScope(target)
    return scope.profileId === null ? { scope, entries: [], outcome: 'private' } : await browserInputHistory.record(scope, text)
  })
  handleWithEvent('browser:removeInputHistory', async (event, target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope, text: string) => {
    requireTrustedSender('browser:removeInputHistory', event)
    const actual = requireInputHistoryScope(target, scope)
    return actual.profileId === null ? { scope: actual, entries: [] } : await browserInputHistory.remove(actual, text)
  })
  handleWithEvent('browser:clearInputHistory', async (event, target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope) => {
    requireTrustedSender('browser:clearInputHistory', event)
    const actual = requireInputHistoryScope(target, scope)
    return actual.profileId === null ? { scope: actual, entries: [] } : await browserInputHistory.clear(actual)
  })
  handle('browser:openDevTools', async (id: string) => { await ensureBrowser(id); return browsers.openDevTools(id) })
  handle('browser:setViewport', async (id: string, viewport: BrowserViewport) => { await ensureBrowser(id); return browsers.setViewport(id, viewport) })
  handle('browser:captureScreenshot', async (id: string) => { await ensureBrowser(id); return await browsers.captureScreenshot(id) })
  /**
   * 跑一段 Agent 写的程序。**授权闸在这里，不在调用方。**
   *
   * 放这一层是因为这是所有调用方的必经之路（今天是 Control 的 browser.run，明天可能是别的）。
   * 放在 Control 那一侧的话，每多一个入口就要记得再写一遍同样的检查——而漏写是静默的：
   * 那条新入口会在开关关着的时候照样跑。
   *
   * 拒绝要说清去哪开（AGENTS.md:32-52：不许静默、也不许给一句无法行动的拒绝）。
   */
  handleWithEvent('browser:runScript', async (
    event,
    id: string,
    code: string,
    operator?: import('../shared/browser-operation.js').BrowserOperator,
    operationId?: string,
    caller?: Pick<import('@agentmux/core').AgentMuxControlCaller, 'agentSessionId'>
  ) => {
    requireTrustedSender('browser:runScript', event)
    return browserRunResult(async () => {
      if (config.browser.agentAutomation !== true) {
        // 码必须挂在 error 上，不能只留一句话。`control-host.ts:580` 是从 `error.code` 取的，
        // 取不到就折成 `CONTROL_FAILED`——于是 `BROWSER_AUTOMATION_DISABLED` 进了码表、进了收据解析
        // 的测试，却在生产路径上一次都发不出来（零调用者）。差别对 Agent 是实的：`CONTROL_FAILED`
        // 读作"这次失败了，重试吧"，而这件事重试一万次也不通，要人去改设置。
        throw Object.assign(
          new Error('Agent browser automation is off. Turn it on in Settings › Browser.'),
          { code: 'BROWSER_AUTOMATION_DISABLED' satisfies AgentMuxControlErrorCode }
        )
      }
      // 第四个位置是 `replayOf`，这条路上永远没有（回放走 `browser:runReplay`）。这个 undefined 洞
      // 必须显式留着：少写一个位置就是把 operationId 喂进 replayOf，于是这次操作被记成"某个操作的
      // 回放"，而调用方拿着的 id 谁也不认识——两边各自看起来都正常。
      // Read the original receipt before acquiring a cold page. Journal.start remains the
      // final atomic arbiter when another request accepts this identity after the read.
      if (operationId !== undefined && await browsers.getOperation(operationId)) throw browserOperationAlreadyExistsError()
      if (externalBrowsers.has(id)) {
        workspace(config, externalBridge.require(id).workspaceId)
        return await externalBrowsers.runScript(id, code, operator, operationId)
      }
      await ensureBrowser(id)
      return await browsers.runScript(id, code, operator, undefined, operationId, undefined, false, undefined, caller)
    })
  })
  handleWithEvent('browser:setOperatorAvatar', async (event, input: Parameters<import('../shared/contracts.js').AgentMuxDesktopApi['browser']['setOperatorAvatar']>[0]) => {
    requireTrustedSender('browser:setOperatorAvatar', event)
    return await browsers.setOperatorAvatar(input)
  })
  handleWithEvent('browser:checkOutcomeFields', async (event, id: string, input: import('../shared/browser-outcome-criteria.js').BrowserOutcomeFieldRunInput) => {
    requireTrustedSender('browser:checkOutcomeFields', event)
    if (config.browser.agentAutomation !== true) throw new Error('Browser automation is off. Turn it on in Settings › Browser.')
    await ensureBrowser(id)
    return await browsers.checkOutcomeFields(id, input, 'human')
  })
  handleWithEvent('browser:verifyOutcome', async (event, id: string, operationId: string) => {
    requireTrustedSender('browser:verifyOutcome', event)
    await ensureBrowser(id)
    return await browsers.verifyOutcome(id, operationId)
  })
  handleWithEvent('browser:listOperationHistory', async (event) => {
    requireTrustedSender('browser:listOperationHistory', event)
    return await browsers.listOperationHistory()
  })
  handleWithEvent('browser:getOperation', async (event, operationId: string) => {
    requireTrustedSender('browser:getOperation', event)
    return await browsers.getOperation(operationId)
  })
  handleWithEvent('browser:getStepEvidence', async (event, operationId: string, sequence: number) => {
    requireTrustedSender('browser:getStepEvidence', event)
    return await browsers.getStepEvidence(operationId, sequence)
  })
  handleWithEvent('browser:readStepResult', async (event, operationId: string, sequence: number, options?: BrowserResultReadOptions) => {
    requireTrustedSender('browser:readStepResult', event)
    const operation = await browserOperationJournal.get(operationId)
    if (operation && externalBrowsers.has(operation.browserId)) return await externalBrowsers.readStepResult(operationId, sequence, options)
    return await browsers.readStepResult(operationId, sequence, options)
  })
  // 取消不过 `agentAutomation` 闸，而 runScript 过。这不是漏了：那个闸挡的是「让 Agent 去驱动页面」，
  // 而这条是**停下**驱动。开关关掉之后仍然能停掉一个正在跑的操作，否则用户一旦关掉总开关就再也
  // 停不了手上这一个——把一道拒绝新动作的闸变成了一次能力损失。
  handleWithEvent('browser:stopOperationById', async (event, operationId: string) => {
    requireTrustedSender('browser:stopOperationById', event)
    return await externalBrowsers.stopOperationById(operationId) ?? await browsers.stopOperationById(operationId)
  })
  handleWithEvent('browser:replayPlan', async (event, operationId: string) => {
    requireTrustedSender('browser:replayPlan', event)
    return await browsers.replayPlan(operationId)
  })
  handleWithEvent('browser:takeControl', async (event, id: string) => {
    requireTrustedSender('browser:takeControl', event)
    return browsers.takeControl(id)
  })
  handleWithEvent('browser:returnControl', async (event, id: string, input?: import('../shared/contracts.js').BrowserControlHandoff) => {
    requireTrustedSender('browser:returnControl', event)
    return input === undefined ? browsers.returnControl(id) : await browsers.returnControl(id, input)
  })
  handleWithEvent('browser:runReplay', async (event, id: string, plan: import('../shared/browser-operation.js').BrowserReplayPlan, operator?: import('../shared/browser-operation.js').BrowserOperator, caller?: Pick<import('@agentmux/core').AgentMuxControlCaller, 'agentSessionId'>) => {
    requireTrustedSender('browser:runReplay', event)
    if (config.browser.agentAutomation !== true) {
      throw Object.assign(new Error('Agent browser automation is off. Turn it on in Settings › Browser.'), { code: 'BROWSER_AUTOMATION_DISABLED' satisfies AgentMuxControlErrorCode })
    }
    await ensureBrowser(id)
    return await browsers.runReplay(id, plan, operator, caller)
  })
  handleWithEvent('browser:selectElement', async (event, id: string) => {
    requireTrustedSender('browser:selectElement', event)
    await ensureBrowser(id)
    return await browsers.selectElement(id)
  })
  handleWithEvent('browser:startDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:startDemonstration', event)
    await ensureBrowser(id)
    return await browsers.startDemonstration(id)
  })
  handleWithEvent('browser:stopDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:stopDemonstration', event)
    return await browsers.stopDemonstration(id)
  })
  handleWithEvent('browser:getDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:getDemonstration', event)
    await ensureBrowser(id)
    return await browsers.getDemonstration(id)
  })
  handleWithEvent('browser:getTaskAssets', async (event, id: string) => {
    requireTrustedSender('browser:getTaskAssets', event)
    await ensureBrowser(id)
    return await browsers.getTaskAssets(id)
  })
  handleWithEvent('browser:controlTask', async (event, request: unknown) => {
    requireTrustedSender('browser:controlTask', event)
    return await executeBrowserTaskControl(request, {
      getTaskAssets: async id => { await ensureBrowser(id); return await browsers.getTaskAssets(id) },
      getOperation: id => browsers.getOperation(id),
      runControlledTaskBatch: async input => { await ensureBrowser(input.browserId); return await browsers.runControlledTaskBatch(input) },
      runControlledTaskAsset: async input => { await ensureBrowser(input.browserId); return await browsers.runControlledTaskAsset(input) },
      stopTaskBatch: (id, batchId) => browsers.stopTaskBatch(id, batchId),
      stopTaskAsset: (id, runId) => browsers.stopTaskAsset(id, runId)
    }, config.browser.agentAutomation === true)
  })
  handleWithEvent('browser:importTaskAsset', async (event, id: string, name?: string) => {
    requireTrustedSender('browser:importTaskAsset', event)
    await ensureBrowser(id)
    return await browsers.importTaskAsset(id, name)
  })
  handleWithEvent('browser:saveTaskAssetDraft', async (event, id: string, assetId: string, revision: number, content: BrowserTaskContent) => {
    requireTrustedSender('browser:saveTaskAssetDraft', event)
    await ensureBrowser(id)
    return await browsers.saveTaskAssetDraft(id, assetId, revision, content)
  })
  handleWithEvent('browser:saveTaskAssetVersion', async (event, id: string, assetId: string, revision: number, content: BrowserTaskContent) => {
    requireTrustedSender('browser:saveTaskAssetVersion', event)
    await ensureBrowser(id)
    return await browsers.saveTaskAssetVersion(id, assetId, revision, content)
  })
  handleWithEvent('browser:locateTaskAssetStep', async (event, id: string, assetId: string, revision: number, stepId: string) => {
    requireTrustedSender('browser:locateTaskAssetStep', event)
    await ensureBrowser(id)
    return await browsers.locateTaskAssetStep(id, assetId, revision, stepId)
  })
  handleWithEvent('browser:runTaskBatch', async (event, input: BrowserTaskBatchInput) => {
    requireTrustedSender('browser:runTaskBatch', event)
    if (!config.browser.agentAutomation) throw new Error('Browser automation is disabled in settings.')
    await ensureBrowser(input.browserId)
    return await browsers.runTaskBatch(input)
  })
  handleWithEvent('browser:stopTaskBatch', async (event, id: string, batchId: string) => {
    requireTrustedSender('browser:stopTaskBatch', event)
    return await browsers.stopTaskBatch(id, batchId)
  })
  handleWithEvent('browser:runTaskAsset', async (event, input: BrowserTaskAssetRunInput) => {
    requireTrustedSender('browser:runTaskAsset', event)
    if (!config.browser.agentAutomation) throw new Error('Browser automation is disabled in settings.')
    await ensureBrowser(input.browserId)
    return await browsers.runTaskAsset(input)
  })
  handleWithEvent('browser:stopTaskAsset', async (event, id: string, runId: string) => {
    requireTrustedSender('browser:stopTaskAsset', event)
    return await browsers.stopTaskAsset(id, runId)
  })
  handleWithEvent('browser:answerAppLink', async (event, id: string, allow: boolean, remember: boolean) => {
    requireTrustedSender('browser:answerAppLink', event)
    return await browsers.answerAppLink(id, allow, remember)
  })
  handleWithEvent('browser:answerCertificate', (event, id: string, input: Parameters<BrowserViewManager['answerCertificate']>[1]) => {
    requireTrustedSender('browser:answerCertificate', event)
    return browsers.answerCertificate(id, input)
  })
  handleWithEvent('browser:cancelElementSelection', async (event, id: string) => {
    requireTrustedSender('browser:cancelElementSelection', event)
    await browsers.cancelElementSelection(id)
  })
  handleWithEvent('browser:setAnnotationMarkers', async (
    event,
    id: string,
    navigationId: string,
    markers: BrowserAnnotationMarker[]
  ) => {
    requireTrustedSender('browser:setAnnotationMarkers', event)
    await browsers.setAnnotationMarkers(id, navigationId, markers)
  })
  handleWithEvent('browser:registerPresentation', async (event, input: {
    browserId: string; occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry; window?: import('../shared/workbench-windows.js').WorkbenchWindowDocument
  }) => {
    requireTrustedSender('browser:registerPresentation', event)
    const sender = event.sender, frame = event.senderFrame
    const originalDocument = frame ? { processId: frame.processId, frameToken: frame.frameToken } : null
    await browsers.prepareForConsumption(input.browserId)
    return browsers.registerPresentation(sender, frame, input, originalDocument)
  })
  handleWithEvent('browser:updatePresentation', (event, leaseId: string, geometry: BrowserPresentationGeometry) => {
    requireTrustedSender('browser:updatePresentation', event)
    browsers.updatePresentation(event.sender, event.senderFrame, leaseId, geometry)
  })
  handleWithEvent('browser:removePresentation', (event, leaseId: string) => {
    requireTrustedSender('browser:removePresentation', event)
    browsers.removePresentation(event.sender, event.senderFrame, leaseId)
  })
  handleWithEvent('browser:armPresentationCapture', (event, leaseId: string) => {
    requireTrustedSender('browser:armPresentationCapture', event)
    return browsers.armPresentationCapture(event.sender, event.senderFrame, leaseId)
  })
  handleWithEvent('browser:ackPresentationCapture', (event, captureId: string, ack: BrowserPresentationCaptureAck) => {
    requireTrustedSender('browser:ackPresentationCapture', event)
    return browsers.ackPresentationCapture(event.sender, event.senderFrame, captureId, ack)
  })
  handleWithEvent('browser:activatePresentation', async (event, leaseId: string, activation: BrowserPresentationActivation) => {
    requireTrustedSender('browser:activatePresentation', event)
    const receipt = await browsers.activatePresentation(event.sender, event.senderFrame, leaseId, activation)
    if (receipt.outcome === 'selected' || receipt.outcome === 'input-dispatched') {
      try { await nativeChrome.refresh(browsers.presentationWindowForLease(event.sender, event.senderFrame, leaseId)) }
      catch {
        // Activation has already acted. An observation failure must not turn
        // that original receipt into a rejection or authorize replaying input.
        try { contents.send(NATIVE_OVERLAY_WARNING_CHANNEL, { message: 'The original Browser activation receipt is retained. Floating control refresh is unconfirmed; keep using the original Browser and reopen its floating control.' }) }
        catch { console.warn('Native floating control refresh observation ended after the original Browser activation.') }
      }
    }
    return receipt
  })
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => {
    browsers.setBounds(id, bounds)
  })
  registerBrowserResourceIpc({ handle,
    browsers: { release: browsers.release.bind(browsers), restore: ensureBrowser },
    workspace: value => verifiedBrowserWorkspace(config.workspaces, value)
  })
  handleWithEvent('browser:restoreResource', async (event, id: string, controlRequestId?: string) => {
    requireTrustedSender('browser:restoreResource', event)
    const admitted = controlRequestId === undefined ? nameChangeRequests.getStore()! : controlBridge.nameRequest(controlRequestId,
      request => request.operation === 'browser.restore' && request.browserId === id)
    return await nameChangeRequests.run(admitted, async () => {
      await ensureBrowser(id)
      const target = browsers.target(id)
      if (!target || target.id !== id || target.source !== 'embedded' || target.status !== 'ready') {
        throw new AgentMuxError('The original Browser restoration observation is unconfirmed. Keep its identity and original request; do not automatically repeat the operation.', 'CONTROL_UNAVAILABLE')
      }
      return target
    })
  })
  handle('browser:close', async (id: string) => {
    // Existing native owners retire synchronously along their original Close path.
    if (browsers.recoveryPreviewScope(id)) return await browsers.close(id)
    let scope: BrowserRecoveryPreviewScope | null = null
    try {
      scope = await resolveRecoveryPreviewScope(id)
      if (!scope) console.warn('The cold Browser preview Profile is unconfirmed. The original Close still proceeds.')
    }
    catch { console.warn('The cold Browser preview scope is unconfirmed. The original Close still proceeds.') }
    try {
      // This must run after the await too: a native owner may have appeared during the cold read.
      await browsers.close(id)
    } finally {
      if (scope) {
        // Enqueue retirement now; optional cache IO must not delay the original Close ACK.
        void browserRecoveryPreviews.remove(scope).then(removed => {
          if (removed.warning) console.warn(removed.warning)
        }).catch(error => console.warn('Browser closed; its historical preview cleanup is unconfirmed:', error))
      }
    }
  })
  const detach = args.runtime.attach(contents)
  const rpcHttp = agentMuxRpcHttpOptions()
  channelMetadata = registerConnectorIpc({ handleWithEvent, assertTrusted: requireTrustedSender, runtime: args.runtime,
    metadata: { publish: (watchId, change) => { if (!args.window.isDestroyed() && !contents.isDestroyed()) contents.send(CONNECTION_METADATA_CHANGED_CHANNEL, { watchId, change }) },
      observation: (watchId, state) => { if (!args.window.isDestroyed() && !contents.isDestroyed()) contents.send(CONNECTION_METADATA_OBSERVATION_CHANNEL, { watchId, state }) } } })
  registerMoteChatIpc({ handleWithEvent, assertTrusted: requireTrustedSender, runtime: args.runtime })
  registerMoteConnectionIpc({ handleWithEvent, assertTrusted: requireTrustedSender, runtime: args.runtime })
  registerMotePreferencesIpc({ handleWithEvent, assertTrusted: requireTrustedSender, socketPath: desktopBusinessSocketPath(), runtime: args.runtime })
  const executionBindingReaders = new ExecutionBindingReaders(bindingId => executionBindings.inspect(bindingId))
  const executionBindings = new AgentExecutionBindingService(join(app.getPath('userData'), 'execution-bindings'), {
    onObservation: inspection => executionBindingReaders.publish(inspection),
    resolveHost: async hostId => {
      const scopes = args.runtime.rpcClients().filter(scope => scope.hostId === hostId)
      if (scopes.length !== 1) throw new AgentMuxError('Execution requires one exact configured Host route.', 'UNKNOWN_HOST')
      const client = scopes[0]!.client
      await client.connect()
      const identity = await client.agentCreationAuthority()
      return { runtimeId: identity.runtimeId, client }
    }
  })
  registerExecutionBindingIpc({ handle: handleWithEvent, assertTrusted: requireTrustedSender, bindings: executionBindings, readers: executionBindingReaders })
  // Rejoin only retained tool readers. Startup never creates or restores an Agent.
  void executionBindings.restoreReaders().catch(error => console.warn('Original tool execution observation is unavailable:', error))
  const control = new AgentMuxControlServer({
    executionBindings,
    forwardingPeer: { authoritySocketPath: defaultAgentMuxControlSocketPath() },
    capsules: capsulePresentation({ inspect: id => capsuleClient.call('capsule.inspect', { capsuleId: id }),
      graph: async () => (await spatialState.read())?.graph ?? null,
      current: id => browsers.target(id), ensure: id => ensureBrowser(id),
      recordOpen: (id, capsuleId, operationId) => browsers.recordCapsuleOpen(id, capsuleId, operationId),
      execute: (request, signal) => executeControl(request, undefined, signal),
      observe: async signal => {
        const result = await controlBridge.execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
          requestId: mintObjectId(), operation: 'inspect.client' }, signal)
        if (result.operation !== 'inspect.client') throw new Error('The original Workbench observation is unconfirmed.')
        return result.observation
      }, original: (hostId, method, params, context) => args.runtime.callOriginalCore(hostId, method, params, context) }),
    capsuleInput: capsuleReplies,
    agentLearning: agentLearningAuthority,
    inputContextCaptures,
    nativeDesktop: createNativeDesktopPublicOwner(getNativeDesktopOwner(), { hostId: 'local' }),
    windows: args.workbenchWindows,
    deliveryAttempts,
    ...(args.clientIncidents ? { clientIncidents: () => args.clientIncidents! } : {}),
    clientNotifications: clientNotificationsPort(deliveryAttempts.hostId, (request, signal) => executeControl(request, undefined, signal)),
    moteContext: moteContextEvidencePort(deliveryAttempts.hostId, request => executeControl(request)),
    execute: (request, nameContext, originalContext) => executeControl(request, nameContext, originalContext?.signal),
    nameHistory: query => args.runtime.callOriginalCore('local', 'name.history', query, { principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` } }),
    spatialState,
    files: publicFiles,
    git: publicGit,
    fileUploads: new FileUploadOwner(),
    topics: { call: (method, params, context) => args.runtime.callOriginalCore('local', method, params as never, context ?? { transport: 'unix' }) as Promise<import('@agentmux/core').TopicResult<typeof method>> },
    moteAvatars,


    conversationLandmarks,
    notebookStore,
    notebookObservation: notebookObservation.owner,
    goalChanges: desktopGoalChanges(args.runtime),
    goalControl: (request, _name, originalContext) => executeGoal(request, originalContext),
    applicationAccess: args.applicationAccess,
    hostConfiguration: hostId => structuredClone(configOwner.current.hosts.find(host => host.id === hostId) ?? null),
    coreClients: () => args.runtime.rpcClients(),
    callOriginalCore: (hostId, method, params, context) => args.runtime.callOriginalCore(hostId, method, params, context),
    snapshot: params => observeClientRpcSnapshot(config, args.scratchTopics, params),
    nativeAgentSessions: params => args.runtime.nativeAgentSessions({ hostId: params.hostId, executorId: params.executorId,
      ...(params.workspacePath === undefined ? {} : { workspacePath: params.workspacePath }) }, config),
    nativeAgentHistory: (params, context) => args.runtime.nativeAgentHistory(params, config, context?.signal),
    nativeAgentHistoryResource: (params, context) => args.runtime.nativeAgentHistoryResource(params, config, context?.signal),
    ...(rpcHttp ? { http: rpcHttp } : {}),
    metrics,
    appearance: themeObservation(configOwner),
    toolkit: { subscribe: (toolId, onSnapshot, onEnd, signal, options) => toolkit.subscribe(toolId, onSnapshot, onEnd, signal, options),
      execute: (request, signal, context) => nameChangeRequests.run({
      context: context ?? unknownNameContext(request.operation), operationId: request.requestId
    }, () => toolkit.execute(request, signal)) },
    /**
     * 进度订阅直接接到 journal 上，**不经过 Renderer**。
     *
     * 与 `execute` 那条路不同是刻意的：`execute` 走 controlBridge 到 Renderer，因为那些操作要动
     * 工作面（开 Tab、摘 Region、焦点），事实 owner 在那边。进度不是——它的事实 owner 就是这里的
     * journal。绕一趟 Renderer 只会多一个会断的环节，而且断掉的时候订阅会连着没了。
     *
     * 也因此它不受 `requireActive()`（Tab 还在吗）约束：订阅存在的全部理由就是在别的连接、
     * 别的时刻问同一条操作的进展。
     */
    subscribeBrowserOperation: async (request, onEvent) => {
      const subscription = await browserOperationJournal.subscribe(
        request.operationId,
        request.afterSequence,
        (sequenced) => onEvent({ sequence: sequenced.sequence, event: projectBrowserControlEvent(sequenced.event) })
      )
      // backlog 在开场帧之后立刻投递，不混进开场帧本身：开场帧说的是"这条操作现在什么样、有没有
      // 缺口"，backlog 是事件。合进去会让客户端要写两套解析（第一帧带一批、后续一条一条）。
      // `queueMicrotask` 而不是同步 for：同步发的话，这些事件会在 `subscribeBrowserOperation`
      // 返回之前就流出去——也就是在开场帧之前，而缺口必须先到。
      queueMicrotask(() => { for (const event of subscription.backlog) onEvent({ sequence: event.sequence, event: projectBrowserControlEvent(event.event) }) })
      return {
        // Main 的 producer 登记留在本地；公开 completion 只来自已验收的事实，既有 warning 保留。
        runOperation: projectBrowserControlOperation(subscription.operation),
        gap: subscription.gap,
        dispose: () => subscription.dispose()
      }
    }
  }, desktopBusinessSocketPath())
  await control.start()
  const disposeThemeBootstrap = registerThemeBootstrap(ipcMain, args.window, () => config.appearance, () => nativeTheme.shouldUseDarkColors)
  const disposeTerminalBrightness = observeTerminalBrightness(nativeTheme, updateTerminalBrightness)
  const screenshotShortcut = registerScreenshotShortcut({ platform: process.platform, shortcuts: globalShortcut,
    request: () => { void globalScreenshot.run().catch(reportScreenshotIssue) } })
  handleWithEvent('ui:screenshotShortcutStatus', event => {
    requireTrustedSender('ui:screenshotShortcutStatus', event)
    return screenshotShortcut.status
  })
  return async () => {
    acceptingControl = false
    await runOwnerDisposals([
      { owner: 'screenshot-shortcut', dispose: () => screenshotShortcut.dispose() },
      { owner: 'screenshot-editor', dispose: () => screenshotEditor.dispose() },
      { owner: 'client-incident-runtime', dispose: () => runtimeIncidents?.dispose() },
      { owner: 'terminal-brightness', dispose: disposeTerminalBrightness },
      { owner: 'spatial', dispose: () => disposeSpatial() },
      { owner: 'goal-change-reader', dispose: disposeGoalChanges },
      { owner: 'notebook', dispose: () => { notebookObservation.requests.dispose(); disposeNotebook() } },
      { owner: 'toolkit-ipc', dispose: () => disposeToolkitIpc() },
      { owner: 'toolkit', dispose: () => toolkit.dispose() },
      { owner: 'spatial-links', dispose: () => args.spatialLinks?.unavailable() },
      { owner: 'web-links', dispose: () => args.webLinks?.unavailable() },
      { owner: 'metrics-listener', dispose: () => { contents.off('destroyed', closeMetrics) } },
      { owner: 'metrics', dispose: () => metrics.dispose() },
      { owner: 'theme-bootstrap', dispose: disposeThemeBootstrap },
      { owner: 'workbench-window-listener', dispose: () => { ipcMain.removeListener(WORKBENCH_WINDOW_RESPONSE, acceptWorkbenchWindow) } },
      { owner: 'control-listener', dispose: () => { ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl) } },
      { owner: 'control-bridge', dispose: () => controlBridge.dispose() },
      { owner: 'control-server', dispose: () => control.stop() },
      { owner: 'execution-binding-reader', dispose: () => { executionBindingReaders.dispose(); return executionBindings.dispose() } },
      { owner: 'channel-metadata', dispose: () => channelMetadata?.dispose() },
      { owner: 'runtime-attachment', dispose: () => detach() },
      { owner: 'history-observations', dispose: () => historyObservations.dispose() },
      { owner: 'host-runtime-reads', dispose: () => hostRuntimeReads.dispose() },
      { owner: 'search-reads', dispose: () => searchReads.dispose() },
      { owner: 'history-reads', dispose: () => historyReads.dispose() },
      { owner: 'conversation-reads', dispose: () => conversationReads.dispose() },
      { owner: 'resource-observation', dispose: () => releaseResourceObservation() },
      { owner: 'notifier', dispose: () => notifier.dispose() },
      { owner: 'browser-native-input', dispose: () => { browsers.onNativeInput = undefined } },
      { owner: 'native-chrome', dispose: () => nativeChrome.dispose() },
      { owner: 'external-browsers', dispose: () => externalBrowsers.dispose() },
      { owner: 'workbench-native-window-port', dispose: releaseNativeWindowOwner },
      { owner: 'browsers', dispose: () => browsers.dispose() },
      { owner: 'browser-feedback-preferences', dispose: disposeBrowserFeedbackPreferences },
      { owner: 'capsule-appearance', dispose: () => { disposeCapsuleAppearance(); nativeTheme.removeListener('updated', updateCapsuleThemes); browsers.capsuleDocumentReady = undefined } },
      { owner: 'browser-input-history', dispose: () => browserInputHistory.flush() },
      { owner: 'browser-profiles', dispose: () => browserProfiles.dispose() },
      { owner: 'file-observations', dispose: () => fileObservations.dispose() },
      { owner: 'html-previews', dispose: () => htmlPreviews.dispose() },
      { owner: 'file-builds', dispose: () => builds.dispose() },
      { owner: 'diagram-previews', dispose: () => diagramPreviews.dispose() },
      { owner: 'html-preview-listeners', dispose: () => {
        contents.off('render-process-gone', releaseRendererResources)
        contents.off('did-start-navigation', releaseNavigatedHtmlPreviews)
      } },
      { owner: 'preview-resources', dispose: () => previewResources.dispose() },
      { owner: 'workspace-files', dispose: () => files.dispose() },
      ...channels.map(channel => ({ owner: `ipc-handler:${channel}`, dispose: () => ipcMain.removeHandler(channel) }))
    ], 'Failed to dispose Desktop IPC owners.')
  }
}
