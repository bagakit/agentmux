import { TopicKnowledgeOwner } from './topic-knowledge.js'
import { TopicSpatialOwner } from './topic-spatial-owner.js'
import { AgentMuxNotebookStore, type NotebookWrite } from '@agentmux/core/notebook-store'
import {AgentMuxSpatialStateStore,spatialCatalog} from '@agentmux/core/spatial-state'
import { displayLabel } from '@agentmux/core/spatial-graph'
import { NameChangeAudit, nameChangeRequests, desktopNameContext, unknownNameContext } from './name-change-audit.js'
import { desktopNameHistory } from './name-history.js'
import type { AgentMuxNameContext } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import { sessionReopenResult } from '../shared/session-reopen-result.js'
import { sessionLaunchResult } from '../shared/session-launch-result.js'
import { sessionInputWriteResult } from '../shared/session-input-result.js'
import { CONTINUOUS_PROGRESS_CHANGED, SCHEDULE_CHANGED, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../shared/contracts.js'
import type { ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import type { ContinuousProgressLoopManager } from './continuous-progress-loop-manager.js'
import { inspectDesktopClient } from './client-observation.js'
import { observeClientRpcSnapshot } from './rpc-client-observations.js'
import { SessionHistoryObservationOwners } from './session-history-observation.js'
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
import { captureComposerScreenshot } from './composer-screenshot.js'
import { readBookmark } from './bookmark-file.js'
import { bookmarkKindForPath } from '../shared/bookmark-file.js'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The paste write and the pasted-image read share ONE extension whitelist and ONE byte cap
 *  (`PASTED_IMAGE_*` in contracts). A `Set` is derived here for the `.has()` membership test; the
 *  tuple itself stays the SSOT so the read side cannot drift from what the write accepted. */
const PASTED_IMAGE_EXTENSION_SET = new Set<string>(PASTED_IMAGE_EXTENSIONS)

import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  AgentMuxControlServer,
  connectAgentMuxRpc,
  agentMuxRpcHttpOptions,
  AgentMuxError,
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
  BrowserPng,
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
import { BROWSER_PNG_MAX_BASE64_CHARS, AGENT_ATTENTION_ACTIVATE_CHANNEL, CONTROL_CANCEL_CHANNEL, CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, SESSION_HISTORY_OBSERVATION_CHANNEL, WORKSPACE_FILE_INVALIDATED_CHANNEL } from '../shared/contracts.js'
import { PASTED_IMAGE_EXTENSIONS, PASTED_IMAGE_MAX_BYTES } from '@agentmux/client-ui/pasted-images'
import { terminalPalette } from '../shared/terminal-palettes.js'
import { createAgentNotifier } from './agent-notifier.js'
import { ExternalBrowserBridge } from './browser-external-bridge.js'
import { ExternalBrowserOwner } from './browser-external-owner.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { NativeOverlaySurfaces } from './native-overlay-surfaces.js'
import type { NativeOverlayRegion } from '../shared/native-overlay.js'
import { BrowserOperationFileStore, BrowserOperationJournal, BROWSER_OPERATION_JOURNAL_FILE } from './browser-operation-journal.js'
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
import { browserPngFromBytes, nativeImageFromBrowserPng } from './browser-image.js'
import { pastedDirectory } from './pasted-directory.js'
import { readPastedImage } from './pasted-image-read.js'
import { ConfigStore } from './config-store.js'
import { ConfigOwner } from './config-owner.js'
import { executeSettingsControl } from './settings-control.js'
import { checkSettingsHost, executeSettingsHostsControl } from './settings-hosts-control.js'
import { executeSettingsExecutorRefreshControl, refreshSettingsExecutor } from './settings-executor-refresh-control.js'
import { executeSettingsResourcesControl } from './settings-resources-control.js'
import { executeSettingsBrowserControl, forgetBrowserAppLink } from './settings-browser-control.js'
import { APP_LINK_SCHEME_CHOICES, CONFIG_CHANGED_CHANNEL, type AppLinkSchemeChoice } from '../shared/contracts.js'
import { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import { normalizeExternalUrl } from './external-url.js'
import { assertManualPromptSenderTrusted, assertSenderTrusted, senderTrust, type PrivilegedChannel } from './ipc-sender-trust.js'
import { executeCrashLogControl, requestCrashLogReveal } from './crash-log-access.js'
import { FileObservationRegistry } from './file-observation-registry.js'
import { runOwnerDisposals } from './owner-disposal.js'
import { RuntimeController } from './runtime-controller.js'
import { desktopBusinessSocketPath } from './desktop-host.js'
import { ScratchTopics } from './scratch-topics.js'
import type { MoteAvatarInput, MoteAvatarRef } from '../shared/mote-avatars.js'
import { configWithRuntimeBindings, saveRuntimeConfig } from './runtime-config-transaction.js'
import { WorkspaceFiles, workspaceFileObserverCount } from './workspace-files.js'
import { FileReadOwner } from './file-read-owner.js'
import { classifyRetention, WorktreeService } from './worktree-service.js'
import { runFanOutRequest } from './fanout-request.js'
import { createSpaceZoneResource } from './space-zone-resources.js'
import type { SpaceZoneResourceInput } from '../shared/space-addresses.js'
import { sessionSnapshotPayload } from './session-snapshot-payload.js'
import { rebindLocalFolder } from './workspace-rebind.js'
import { executeSettingsWorkspaceAddControl, registerWorkspace } from './settings-workspace-add-control.js'
import { GitService } from './git-service.js'
import { GhService } from './gh-service.js'
import { openDemandStore } from '@agentmux/demand'

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
  configStore: ConfigStore
  runtime: RuntimeController
  progressLoops: ContinuousProgressLoopManager
  workspaceFiles?: WorkspaceFiles
  scratchTopics: ScratchTopics
  environmentWarning?: string
  onRendererUpdateReady?: (token: string) => void
  loadedPackage?: DesktopPackageIdentity | null
  loadedRenderer?: () => DesktopLoadedRenderer | null
}): Promise<() => Promise<void>> {
  const spatialState = new AgentMuxSpatialStateStore()
  const nameAudit = new NameChangeAudit(spatialState)
  args.scratchTopics.setNameAudit(nameAudit)
  let config = await args.configStore.get()
  const initialPalette = terminalPalette(config.appearance.terminalTheme)
  args.runtime.setTerminalViewColors({
    foreground: initialPalette.foreground,
    background: initialPalette.background
  })
  const initialRuntime = await args.runtime.prepare(config)
  let initialBindingError: unknown
  try {
    const bound = configWithRuntimeBindings(config, initialRuntime)
    if (bound !== config) config = await args.configStore.save(bound)
  } catch (error) { initialBindingError = error }
  args.runtime.commit(initialRuntime)
  // Directory metadata maintenance is advisory and never holds up the original Runtime/input.
  const scratchForIdentity = config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  if (scratchForIdentity) void Promise.resolve().then(() => args.scratchTopics.normalizeDirectoryIdentities(scratchForIdentity))
    .catch(error => process.stderr.write(`Directory identity startup maintenance: ${String(error)}\n`))
  if (initialBindingError) args.runtime.reportBindingSaveFailure(initialRuntime, initialBindingError)
  let releaseExecutorConfigEdit: (() => void) | undefined
  let toolkit: ToolkitOwner
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
      const paletteChanged = saved.appearance.terminalTheme !== config.appearance.terminalTheme
      config = saved
      toolkit.configurationChanged()
      releaseExecutorConfigEdit?.()
      releaseExecutorConfigEdit = undefined
      if (paletteChanged) {
        const palette = terminalPalette(saved.appearance.terminalTheme)
        args.runtime.setTerminalViewColors({ foreground: palette.foreground, background: palette.background })
      }
      if (!args.window.isDestroyed() && !args.window.webContents.isDestroyed()) args.window.webContents.send(CONFIG_CHANGED_CHANNEL, saved)
    }
  })
  toolkit = new ToolkitOwner({ openRunPort: () => args.runtime.toolkitRunPort(), launch: performanceLaunch,
    config: configOwner, receiptPath: join(app.getPath('userData'), 'toolkit-receipts.json'),
    enabled: () => resolvePerformancePreferences(configOwner.current).enabled })
  const files = args.workspaceFiles ?? new WorkspaceFiles((id) => args.runtime.executionHost(id), {
    primaryMoteWorkspace: async () => config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  })
  const demands = openDemandStore({ root: join(app.getPath('userData'), 'demands') })
  const worktrees = new WorktreeService((id) => args.runtime.executionHost(id), { save: (next, expected) => configOwner.edit(expected, next) })
  const git = new GitService((id) => args.runtime.executionHost(id))
  // `git` is handed in rather than let GhService build its own: the PR readiness read asks git and gh
  // about the same repository in one breath, and two separately-constructed services could resolve a
  // workspace's host differently.
  const gh = new GhService((id) => args.runtime.executionHost(id), git)
  const browserProfiles = new BrowserProfileManager()
  await browserProfiles.initialize()
  const browserInputHistory = new BrowserInputHistoryStore(join(app.getPath('userData'), 'browser-input-history'))
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
    if (!args.window.webContents.isDestroyed()) args.window.webContents.send('browser:targetsChanged')
  }, (browserId, navigationId) => {
    void browserUploads.releaseDocument(browserId, navigationId).catch(error => console.warn('Selected-file snapshots could not be released after the original document ended:', error))
  })
  await externalBridge.ready()
  const externalBrowsers = new ExternalBrowserOwner(externalBridge, { journal: browserOperationJournal,
    refs: browserRefs, evidence: browserEvidence, results: browserResults, uploads: browserUploads,
    decodeScreenshot: data => {
      if (typeof data !== 'string' || data.length > BROWSER_PNG_MAX_BASE64_CHARS) throw new Error('Shared-tab screenshot exceeds its image budget.')
      const png = browserPngFromBytes(Buffer.from(data, 'base64'))
      nativeImageFromBrowserPng(png, bytes => nativeImage.createFromBuffer(bytes))
      return png
    } })
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
    // 箭头包一层而不是 `shell.openExternal`：摘下来的方法会丢掉原生 receiver（本仓吃过这个亏）。
    openExternal: (target) => shell.openExternal(target)
  }, browserOperationJournal, browserEvidence, browserResults, browserDemonstrations,
  new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(app.getPath('userData'), BROWSER_TASK_ASSETS_FILE)), { nameAudit }),
  new BrowserDownloads(join(app.getPath('userData'), 'browser-downloads'), files, id => workspace(config, id)),
  browserUploads)
  const warnNativeChrome = (warning: string): void => {
    if (!args.window.webContents.isDestroyed()) args.window.webContents.send(NATIVE_OVERLAY_WARNING_CHANNEL, warning)
  }
  const nativeChrome = new NativeOverlaySurfaces(args.window, browsers, warnNativeChrome,
    input => { if (!args.window.webContents.isDestroyed()) args.window.webContents.send(NATIVE_BROWSER_INPUT_CHANNEL, input) })
  browsers.onNativeInput = (owner, input) => nativeChrome.forwardBrowserInput(owner, input)
  const currentMetricsWindow = (): import('@agentmux/core/control').MetricsWindow | null => {
    if (args.window.isDestroyed() || args.window.webContents.isDestroyed() || args.window.webContents.isLoadingMainFrame()) return null
    const generation = args.runtime.rendererGeneration(args.window.webContents)
    return generation === null ? null : { windowId: args.window.id, webContentsId: args.window.webContents.id, generation }
  }
  const releaseResourceObservation = args.runtime.resourceSampler.setObservationSources({
    observeRuntime: () => args.runtime.resourceUsageObservation(),
    observeRenderer: signal => observeRendererResources(controlBridge, currentMetricsWindow, signal),
    processOwners: () => ({
      rendererPids: [...args.window.webContents.mainFrame.framesInSubtree
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
      args.window.webContents.send(AGENT_ATTENTION_ACTIVATE_CHANNEL, sessionId)
    }
  })

  const fileObservations = new FileObservationRegistry()
  const channels: string[] = []
  let acceptingControl = true
  const controlBridge = new DesktopControlIpcBridge({
    isAvailable: () => acceptingControl && !args.window.isDestroyed() && !args.window.webContents.isDestroyed(),
    sendRequest: (request) => args.window.webContents.send(CONTROL_REQUEST_CHANNEL, request),
    sendCancellation: (cancellation) => args.window.webContents.send(CONTROL_CANCEL_CHANNEL, cancellation)
  })
  const metrics = createResourceMetricsPort({ sampler: args.runtime.resourceSampler, currentWindow: currentMetricsWindow })
  const closeMetrics = () => metrics.dispose()
  args.window.webContents.once('destroyed', closeMetrics)
  const disposeProgressInput = args.runtime.setContinuousProgressInputObserver(async (control, signal) => {
    const result = await controlBridge.execute({ operation: 'continuous-progress.observeInput', requestId: randomUUID(), control }, signal)
    if (result.operation !== 'continuous-progress.observeInput' || result.control.kind !== 'agent' ||
        result.control.hostId !== control.hostId || result.control.agentSessionId !== control.agentSessionId ||
        result.control.run.runId !== control.run.runId || typeof result.occupied !== 'boolean') {
      throw new Error('User input observation did not match this Session and Run. Automatic progress is paused.')
    }
    return result.occupied
  })
  const disposeProgressChanges = args.progressLoops.subscribe((loop) => {
    if (!args.window.isDestroyed() && !args.window.webContents.isDestroyed()) {
      args.window.webContents.send(loop.calendar ? SCHEDULE_CHANGED : CONTINUOUS_PROGRESS_CHANGED, loop)
    }
  })
  const acceptControl = (event: IpcMainEvent, response: DesktopControlResponse): void => {
    // 发送者判据走 senderTrust（被行为测试直接质询）；这个频道的处置是**静默返回**而非抛，所以那半件
    // 留在这里。requestId 的形状检查不是发送者关切，也留在 shell——不塞进纯判据里。
    if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) return
    if (!response || typeof response.requestId !== 'string') return
    controlBridge.accept(response)
  }
  const executeControlOwner = async (
    request: AgentMuxControlRequest
  ): Promise<AgentMuxControlResult> => {
    if(request.operation==='space.ls' || request.operation==='space.inspect') {
      if(!('requestId' in request.target)) {
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

    if (request.operation === 'inspect.client') return await inspectDesktopClient(request, {
      pid: process.pid, package: args.loadedPackage ?? null,
      renderer: () => args.window.webContents.isLoadingMainFrame() ? null : args.loadedRenderer?.() ?? null,
      generation: () => args.runtime.rendererGeneration(args.window.webContents),
      storage: () => observeWorkbenchStorageAuthority(args.window.webContents.session, {
        userData: app.getPath('userData'), sessionData: app.getPath('sessionData')
      }),
      runtimes: () => args.runtime.connectedRuntimeIdentities(), execute: (input) => controlBridge.execute(input)
    })
    if (request.operation === 'diagnostics.crash-log.get' || request.operation === 'diagnostics.crash-log.reveal') return await executeCrashLogControl(request)
    if (request.operation === 'settings.get' || request.operation === 'settings.set') return await executeSettingsControl(request, configOwner)
    if (request.operation === 'settings.workspaces.add') return await executeSettingsWorkspaceAddControl(request, configOwner, id => args.runtime.executionHost(id))
    if (request.operation === 'settings.hosts.list' || request.operation === 'settings.hosts.test') return await executeSettingsHostsControl(request, configOwner, args.runtime)
    if (request.operation === 'settings.executors.refresh') return await executeSettingsExecutorRefreshControl(request, configOwner, args.runtime)
    if (request.operation === 'settings.browser.links.list' || request.operation === 'settings.browser.links.forget') {
      return await executeSettingsBrowserControl(request, configOwner)
    }
    if (request.operation === 'settings.resource.list' || request.operation === 'settings.resource.get' ||
        request.operation === 'settings.resource.add' || request.operation === 'settings.resource.update' ||
        request.operation === 'settings.resource.remove') return await executeSettingsResourcesControl(request, configOwner)
    return projectBrowserControlResult(await controlBridge.execute(request))
  }
  const executeControl = (request: AgentMuxControlRequest, context?: AgentMuxNameContext): Promise<AgentMuxControlResult> =>
    nameChangeRequests.run({ context: context ?? unknownNameContext(request.operation), operationId: request.requestId },
      () => executeControlOwner(request))
  ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (event, ...values: TArgs) => nameChangeRequests.run({
      context: desktopNameContext(channel, event.sender, args.window.webContents, args.window.id), operationId: randomUUID()
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
      context: desktopNameContext(channel, event.sender, args.window.webContents, args.window.id), operationId: randomUUID()
    }, () => listener(event, ...values)))
  }
  /**
   * 特权频道的发送者卫兵——不可信就抛。判据（身份比对 + 拒绝措辞）在纯的 `senderTrust` 里，处置（抛）
   * 在纯的 `assertSenderTrusted` 里，所以这个适配器体就是**一次转发表达式**：既没有可翻极性的比较符，
   * 也没有可插早退的语句位。每个会抛的特权 handler 第一句都调它。控制响应频道不走这里（它要静默返回）。
   */
  const requireTrustedSender = (channel: PrivilegedChannel, event: IpcMainInvokeEvent): void =>
    assertSenderTrusted(senderTrust(channel, event.sender, args.window.webContents))

  registerDeviceManagementIpc({ handleWithEvent, assertTrusted: requireTrustedSender })

  const resolveInputHistoryScope = (target: BrowserInputHistoryTarget): BrowserInputHistoryScope => {
    let scope: BrowserInputHistoryScope
    if (target?.kind === 'browser') scope = browsers.inputHistoryScope(target.browserId, target.profileId)
    else if (target?.kind === 'workspace') scope = {
      workspaceId: workspace(config, target.workspaceId).id, profileId: browserProfiles.defaultProfileId()
    }
    else throw new Error('Browser input history requires its original Browser or Workspace.')
    workspace(config, scope.workspaceId)
    browserProfiles.resolvePartition(scope.profileId)
    return scope
  }
  const requireInputHistoryScope = (target: BrowserInputHistoryTarget, expected: BrowserInputHistoryScope): BrowserInputHistoryScope => {
    const scope = resolveInputHistoryScope(target)
    if (expected?.workspaceId !== scope.workspaceId || expected?.profileId !== scope.profileId) {
      throw new Error('The input history scope changed. Reopen this input history before deleting.')
    }
    return scope
  }

  handle('config:get', () => config)
  handle('config:save', async (next: AppConfig, expected: AppConfig) => await configOwner.edit(expected, next))
  handle('hosts:check', async (input: HostConfig) => await checkSettingsHost(input, args.runtime))
  // The renderer is sandboxed and cannot open a native dialog, so choosing files to reference is a
  // main-process capability. It returns paths only — reading the file is the Agent's own job.
  //
  // 注意这里**没有** event 形参：上面那个 `handle` 包装已经把它剥掉了。此前这里写成
  // `(_event, input)`，于是 input 恒为 undefined——`defaultPath` 永远送不到，选择器每次都开在
  // 上一次的位置而不是这个 workspace。tsc 沉默是因为 TArgs 是**从 listener 反推**的：多写一个
  // 形参只会让它推出「这个频道传两个值」，而不是报错。判据在 ipc-parity.test.ts 里。
  handle('ui:chooseFiles', async (input: { defaultPath?: string } | undefined) => {
    const selection = await dialog.showOpenDialog(args.window, {
      properties: ['openFile', 'multiSelections'],
      ...(input?.defaultPath ? { defaultPath: input.defaultPath } : {})
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return selection.filePaths
  })
  handle('workspaces:appearance', async (id: string) => {
    const item = workspace(config, id)
    return item.hostId === 'local' ? await projectAppearance(item.repoPath ?? item.path) : { kind: item.repoPath ? 'repository' : 'directory', icon: null }
  })
  handle('workspaces:chooseLocalFolder' , async () => {
    const selection = await dialog.showOpenDialog(args.window, { properties: ['openDirectory'] })
    const path = selection.filePaths[0]
    if (selection.canceled || !path) return null
    return (await registerWorkspace({ hostId: 'local', path }, configOwner, id => args.runtime.executionHost(id))).workspace
  })
  // 重绑一个本地文件夹 Workspace。编排在 `workspace-rebind` 里，所以测试够得着：这个 handler
  // 只剩一个转发表达式，没有可以插早退的语句位置。文本守卫看不见这里的早退——插一句
  // `return null`，重绑对用户永久失效而 2 条断言全绿（见 rebindLocalFolder 的注释）。
  handle('workspaces:rebindLocalFolder', async (workspaceId: string) => {
    const result = await rebindLocalFolder(workspaceId, config, {
      chooseDirectory: async (defaultPath) =>
        await dialog.showOpenDialog(args.window, { properties: ['openDirectory'], defaultPath }),
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
    try {
      const removal = await worktrees.removeWorktree(input, config)
      return { status: 'removed', removedPath: removal.removedPath, config: removal.config }
    } catch (error) {
      // `classifyRetention` rather than a local re-derivation: the renderer decides what to offer from
      // `retention` (discard is only a real next step for `uncommitted-changes`), and computing that
      // classification twice is how the two removal paths came to disagree about the same failure.
      return { status: 'retained', ...classifyRetention(error) }
    }
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
            createOperationId: randomUUID()
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
    const result = await worktrees.keepOneOfFanOut(input, config)
    return { keptWorkspaceId: result.keptWorkspaceId, outcomes: result.outcomes }
  })
  handle('git:projectIdentity', async (workspaceId: string) => await git.projectIdentity(workspaceId, config))
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
  const publicFiles = new FileReadOwner({ files, topicForDirectory: (workspace, directory) => args.scratchTopics.readForDirectory(workspace, directory), workspace: id => config.workspaces.find(item => item.id === id),
    catalog: async () => { const state = await spatialState.read(); return state ? spatialCatalog(state.graph) : null } })
  handleWithEvent('files:readPublic', async (event, input: import('@agentmux/core').FileReadParams) => {
    requireTrustedSender('files:readPublic', event)
    return await publicFiles.read(input)
  })
  handle('files:read', async (workspaceId: string, path: string) => await files.read(workspace(config, workspaceId), path))
  handle('files:readPreview', async (workspaceId: string, path: string, options?: import('../shared/workspace-file-preview').WorkspaceFilePreviewReadOptions) =>
    await files.readPreview(workspace(config, workspaceId), path, options)
  )
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
  handle('files:write', async (workspaceId: string, input: WorkspaceFileWriteInput) =>
    await files.write(workspace(config, workspaceId), input)
  )
  handle('files:observe', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.observe(key, async () => (
      await files.observe(workspace(config, workspaceId), path, () => {
        if (args.window.webContents.isDestroyed()) return
        args.window.webContents.send(WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId, path })
      })
    ))
  })
  handle('files:unobserve', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.unobserve(key)
  })
  handle('files:create', async (workspaceId: string, input: CreateWorkspacePathInput) => {
    await files.create(workspace(config, workspaceId), input)
  })
  handle('files:move', async (input: MoveWorkspacePathInput) => await nameAudit.run([{
    target: { kind: 'workspace-path', id: JSON.stringify([input.source.workspaceId, input.source.path]) },
    location: { workspaceId: input.source.workspaceId, cwd: workspace(config, input.source.workspaceId).path,
      hostId: workspace(config, input.source.workspaceId).hostId, destinationWorkspaceId: input.destination.workspaceId },
    before: input.source.path, requested: input.destination.path
  }], () => files.move(workspace(config, input.source.workspaceId), workspace(config, input.destination.workspaceId), input),
  result => result.status === 'moved' ? { actual: input.destination.path } : {
    actual: result.finalLocation === 'source' ? input.source.path : null,
    status: result.finalLocation === 'source' ? 'failed' : 'unknown', reason: result.message
  }))
  handle('files:delete', async (workspaceId: string, path: string) => {
    await files.delete(workspace(config, workspaceId), path)
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
  handle('demands:list', async () => await demands.list())
  handle('demands:create', async (input: import('@agentmux/demand').CreateDemandInput) => await demands.create(input))
  handle('demands:update', async (id: string, patch: import('@agentmux/demand').UpdateDemandInput, controlRequestId?: string) => {
    const request = controlRequestId === undefined ? nameChangeRequests.getStore()! : controlBridge.nameRequest(controlRequestId,
      request => request.operation === 'demand.update' && request.demandId === id && request.patch.title === patch.title)
    return await demands.update(id, patch, { context: request.context, operationId: request.operationId })
  })
  handle('demands:confirmAlignment', async (id: string, expectedRevision: number) => await demands.confirmAlignment(id, expectedRevision))
  handle('demands:acceptGrounding', async (id: string, expectedAlignmentRevision: number, expectedSubmissionId: string, acceptGaps?: boolean) => await demands.acceptGrounding(id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps))
  handle('demands:delete', async (id: string) => await demands.delete(id))
  handle('demands:linkSession', async (id: string, sessionId: string) => await demands.linkSession(id, sessionId))
  handle('demands:unlinkSession', async (id: string, sessionId: string) => await demands.unlinkSession(id, sessionId))
  handle('demands:activity', async (id: string, input: Omit<import('@agentmux/demand').DemandActivity, 'id' | 'createdAt'>) => await demands.addActivity(id, input))
  handle('demands:decision', async (id: string, input: Omit<import('@agentmux/demand').DemandDecision, 'id' | 'createdAt'>) => await demands.addDecision(id, input))
  const disposeToolkitIpc = registerToolkitIpc(toolkit, handleWithEvent)

  const notebookStore = new AgentMuxNotebookStore()
  const disposeNotebook = notebookStore.subscribe(observation => {
    if (!args.window.isDestroyed() && !args.window.webContents.isDestroyed()) args.window.webContents.send('notebook:changed', observation)
  })
  handleWithEvent('notebook:read', async event => { requireTrustedSender('notebook:read', event); return notebookStore.read() })
  handleWithEvent('notebook:apply', async (event, input: NotebookWrite) => {
    requireTrustedSender('notebook:apply', event)
    return notebookStore.apply(input, { kind: 'user', id: 'local-user:' + (process.getuid?.() ?? 'local') })
  })
  const topicKnowledge = new TopicKnowledgeOwner(args.scratchTopics, files, () => workspace(config, SCRATCH_WORKSPACE_ID))
  topicKnowledge.setSpatialPort(new TopicSpatialOwner({ state: spatialState,
    workspace: () => workspace(config, SCRATCH_WORKSPACE_ID), topics: () => topicKnowledge.listTopicSnapshots(),
    categories: () => topicKnowledge.listCategories(), ensureDefaultCategory: () => topicKnowledge.ensureDefaultCategoryContent() }))
  handleWithEvent('topics:call', async (event, method: import('@agentmux/core').TopicMethod, params: import('@agentmux/core').TopicParams<import('@agentmux/core').TopicMethod>) => {
    requireTrustedSender('topics:call', event)
    return topicKnowledge.call(method, params)
  })
  const disposeSpatial = spatialState.subscribe(state => {
    if(!args.window.isDestroyed() && !args.window.webContents.isDestroyed()) args.window.webContents.send('spatial:changed',state)
  })
  handleWithEvent('spatial:read',async event=>{requireTrustedSender('spatial:read',event);return spatialState.readForLayout()})
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
    const context = desktopNameContext('spatial:renameLabel', event.sender, args.window.webContents, args.window.id)
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
    requireWorkbenchStorageAuthority(await observeWorkbenchStorageAuthority(args.window.webContents.session, {
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData')
    }))
    // Electron returns void: this requests flush without claiming a disk acknowledgement.
    args.window.webContents.session.flushStorageData()
  })
  handleWithEvent('ui:rendererUpdateReady', (event, token: string) => {
    requireTrustedSender('ui:rendererUpdateReady', event)
    args.onRendererUpdateReady?.(token)
  })
  handle('ui:readClipboardText' , () => clipboard.readText())
  handle('ui:writeClipboardText', (text: string) => {
    clipboard.writeText(text)
  })
  handleWithEvent('ui:writeClipboardImage', (event, image: BrowserPng) => {
    requireTrustedSender('ui:writeClipboardImage', event)
    clipboard.writeImage(nativeImageFromBrowserPng(image, (png) => nativeImage.createFromBuffer(png)))
  })
  handleWithEvent('ui:openExternal', async (event, rawUrl: string) => {
    await openExternalFromRenderer(event, args.window.webContents, rawUrl)
  })
  handleWithEvent('ui:captureScreenshot', async (event) => {
    requireTrustedSender('ui:captureScreenshot', event)
    return await captureComposerScreenshot(app.getPath('home'))
  })
  handleWithEvent('ui:publishNativeOverlays', async (event, regions: NativeOverlayRegion[]) => {
    requireTrustedSender('ui:publishNativeOverlays', event)
    return await nativeChrome.update(regions)
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
  handleWithEvent('ui:savePastedImage', async (event, input: { bytes: Uint8Array; extension: string }) => {
    requireTrustedSender('ui:savePastedImage', event)
    // A CLI Agent reads images from disk, so a paste becomes a file it can open. The renderer supplies
    // bytes only — never a destination — so it cannot aim this write anywhere.
    const bytes = Buffer.from(input.bytes)
    if (bytes.byteLength === 0) throw new Error('Pasted image is empty.')
    if (bytes.byteLength > PASTED_IMAGE_MAX_BYTES) throw new Error('Pasted image exceeds the size limit.')
    const extension = PASTED_IMAGE_EXTENSION_SET.has(input.extension) ? input.extension : 'png'
    const directory = pastedDirectory(app.getPath('home'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`)
    await writeFile(path, bytes, { mode: 0o600 })
    return path
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
  handle('providers:list', () => args.runtime.providerCatalog())
  handle('executors:detect', async (executorId: AgentExecutorId, hostId: string) => await refreshSettingsExecutor(executorId, hostId, configOwner, args.runtime))
  handle('sessions:snapshot', async () => {
    const snapshot = await args.runtime.snapshot(config)
    const preparation = { runtimeBindings: args.runtime.runtimeBindings() }
    try {
      await configOwner.update(current => configWithRuntimeBindings(current, preparation))
    } catch (error) { args.runtime.reportBindingSaveFailure(preparation, error) }
    const runtimeEndpointWarnings = [...new Map([
      ...args.runtime.endpointWarningSnapshot().map(warning => [warning.hostId, warning] as const),
      // A connection that completed during this read does not make an omitted endpoint a full
      // snapshot. Preserve that cut's unverified membership until the ordinary restored resync.
      ...(snapshot.runtimeEndpointWarnings ?? []).filter(warning => warning.availability !== 'connected')
        .map(warning => [warning.hostId, warning] as const)
    ]).values()]
    return sessionSnapshotPayload({ ...snapshot, runtimeEndpointWarnings },
      args.environmentWarning, app.getPath('home'))
  })
  handleWithEvent('sessions:launchAgent', async (event, input: AgentLaunchInput) => {
    if (input.agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, args.window.webContents)
    const result = await args.runtime.launchAgent(input, config)
    if (!event.sender.isDestroyed()) return result
    const primary = Object.assign(
      new Error('The Desktop View disappeared before its Agent launch was delivered.'),
      { code: 'CONTROL_OWNER_LOST' }
    )
    try {
      await args.runtime.stopSession({ kind: 'agent', hostId: result.created.hostId, agentSessionId: result.created.agentSessionId, run: result.created.run })
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`${primary.message} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
        { code: primary.code, cause: new AggregateError([primary, cleanupError]) }
      )
    }
    throw primary
  })
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => sessionLaunchResult(() => args.runtime.launchTerminal(input, config)))
  handle('sessions:timeline', async (session: import('../shared/contracts.js').SessionHistoryReference) => await args.runtime.sessionTimeline(session))
  handle('sessions:creation', async (hostId: string, agentSessionId: string) => await args.runtime.agentCreation(hostId, agentSessionId))
  handle('sessions:historySources', async () => args.runtime.sessionHistorySources())
  handle('sessions:historyPage', async (session: import('../shared/contracts.js').SessionHistoryReference, options?: SessionHistoryPageOptions) => (
    args.runtime.sessionHistoryPage(session, options, config)
  ))
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
  handleWithEvent('sessions:attach', async (event, session: SessionControl, afterSequence: number = 0) => {
    const result = await args.runtime.attachSession(event.sender.id, session, afterSequence, config)
    if (!event.sender.isDestroyed()) return result
    await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its Session Attachment was delivered.')
  })
  handleWithEvent('sessions:replay', async (event, attachmentId: string, afterByte: number) => (
    args.runtime.readSessionReplay(event.sender.id, attachmentId, afterByte)
  ))
  handleWithEvent('sessions:refreshAttachment', async (event, session: SessionControl, attachmentId: string | null, afterByte: number) => {
    const result = await args.runtime.refreshSessionAttachment(event.sender.id, session, attachmentId, afterByte, config)
    if (!event.sender.isDestroyed()) return result
    if (attachmentId === null) await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its observation refresh was delivered.')
  })
  handleWithEvent('sessions:detach', async (event, attachmentId: string) => {
    await args.runtime.detachSession(event.sender.id, attachmentId)
  })
  const progressTargetMatches = (loop: ContinuousProgressTarget, target: ContinuousProgressTarget): boolean =>
    loop.hostId === target.hostId && loop.agentSessionId === target.agentSessionId && loop.providerId === target.providerId && loop.workspacePath === target.workspacePath
  // The original Unix transport supplies the local user principal after the
  // original trusted Renderer check; the request cannot assert human provenance.
  const callSchedule = async <M extends import('@agentmux/core').ScheduleMethod>(method: M, input: import('@agentmux/core').AgentMuxRpcParams<M>) => {
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: control.path } })
    try { return await client.call(method, input) }
    finally { await client.dispose() }
  }
  handleWithEvent('schedule:list', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.list']) => {
    requireTrustedSender('schedule:list', event)
    return callSchedule('schedule.list', input)
  })
  handleWithEvent('schedule:inspect', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.inspect']) => {
    requireTrustedSender('schedule:inspect', event)
    return callSchedule('schedule.inspect', input)
  })
  handleWithEvent('schedule:create', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.create']) => {
    requireTrustedSender('schedule:create', event)
    return callSchedule('schedule.create', input)
  })
  handleWithEvent('schedule:pause', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.pause']) => {
    requireTrustedSender('schedule:pause', event)
    return callSchedule('schedule.pause', input)
  })
  handleWithEvent('schedule:resume', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.resume']) => {
    requireTrustedSender('schedule:resume', event)
    return callSchedule('schedule.resume', input)
  })
  handleWithEvent('schedule:cancel', async (event, input: import('@agentmux/core').ScheduleParamsMap['schedule.cancel']) => {
    requireTrustedSender('schedule:cancel', event)
    return callSchedule('schedule.cancel', input)
  })
  handleWithEvent('continuousProgress:list', async (event, target: ContinuousProgressTarget) => {
    requireTrustedSender('continuousProgress:list', event)
    await args.progressLoops.start()
    return args.progressLoops.list().filter(loop => !loop.calendar && progressTargetMatches(loop, target))
  })
  handleWithEvent('continuousProgress:create', async (event, target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource) => {
    requireTrustedSender('continuousProgress:create', event)
    const observed = await args.runtime.observeContinuousProgress(target, randomUUID(), Date.now())
    if (observed.inputOccupied) throw new Error('Keep your draft and queued messages. Clear them before enabling automatic progress.')
    return await args.progressLoops.create({ ...target, intervalMs, prompt, ...(taskSource !== undefined ? { taskSource } : {}) })
  })
  handleWithEvent('continuousProgress:action', async (event, target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check') => {
    requireTrustedSender('continuousProgress:action', event)
    await args.progressLoops.start()
    const loop = args.progressLoops.list().find(loop => !loop.calendar && loop.loopId === loopId && progressTargetMatches(loop, target))
    if (!loop) throw new Error('This loop does not belong to the requested target.')
    if (action === 'pause') return await args.progressLoops.pause(loopId)
    if (action === 'stop') return await args.progressLoops.stopLoop(loopId)
    if (action !== 'resume' && action !== 'check') throw new Error('Unknown continuous progress action.')
    const observed = await args.runtime.observeContinuousProgress(target, randomUUID(), Date.now())
    if (observed.inputOccupied) throw new Error('Keep your draft and queued messages. Automatic progress remains paused.')
    return action === 'resume' ? await args.progressLoops.resume(loopId) : await args.progressLoops.checkNow(loopId)
  })
  const pauseUserProgress = (session: SessionControl, reason: string): void => {
    if (session.kind === 'agent') void args.progressLoops.pauseTarget(session, reason).catch(error => console.error('Continuous progress pause could not be saved:', error))
  }
  handleWithEvent('continuousProgress:pauseForInput', async (event, control: AgentSessionControl) => {
    requireTrustedSender('continuousProgress:pauseForInput', event)
    await args.progressLoops.pauseTarget(control, 'Paused for your draft or queued message. Resume explicitly after sending or clearing it.')
  })
  handle('sessions:write', async (session: SessionControl, data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source']): Promise<SessionInputWriteResult> => {
    if (source === 'user' && data.length > 0) pauseUserProgress(session, 'Paused for your terminal input.')
    return await sessionInputWriteResult(() => args.runtime.write(session, data, source))
  })
  handle('sessions:paste', async (session: SessionControl, text: string, terminalData: string): Promise<SessionInputWriteResult> => {
    if (text.length > 0) pauseUserProgress(session, 'Paused for your paste.')
    return await sessionInputWriteResult(() => args.runtime.paste(session, text, terminalData))
  })
  handleWithEvent('sessions:submitPrompt', async (
    event,
    session: AgentSessionControl,
    prompt: string,
    operationId: string,
    condition: AgentPromptCondition,
    choice?: Parameters<RuntimeController['submitPrompt']>[5],
    authorHuman?: boolean,
    agentMuxNote?: string,
    sourceChannel?: Parameters<RuntimeController['submitPrompt']>[8]
  ): Promise<SessionInputWriteResult> => sessionInputWriteResult(async () => {
    let effectiveAuthorHuman = false
    if (agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, args.window.webContents)
    if (authorHuman === true) {
      assertManualPromptSenderTrusted(event.sender, args.window.webContents)
      effectiveAuthorHuman = true
    }
    if (sourceChannel !== undefined) assertManualPromptSenderTrusted(event.sender, args.window.webContents)
    pauseUserProgress(session, 'Paused for your message.')
    await args.runtime.submitPrompt(session, prompt, operationId, condition, undefined, choice, effectiveAuthorHuman, agentMuxNote, sourceChannel)
  }))
  handleWithEvent('sessions:replyQuestion', async (event, session: AgentSessionControl,
    input: import('../shared/contracts.js').SessionQuestionReplyInput) => {
    assertManualPromptSenderTrusted(event.sender, args.window.webContents)
    pauseUserProgress(session, 'Paused for your question reply.')
    return await args.runtime.replyQuestion(session, input, config)
  })
  handle('sessions:submitMessage', async (session: AgentSessionControl, message: Parameters<RuntimeController['submitMessage']>[1]) => {
    await args.runtime.submitMessage(session, message)
    pauseUserProgress(session, 'Paused for your message.')
  })
  handle('sessions:respondInteraction', async (
    session: AgentSessionControl,
    response: AgentMuxInteractionResponse
  ) => {
    await args.runtime.respondInteraction(session, response)
  })
  handle('sessions:setPosture', async (session: AgentSessionControl, modeId: string) => {
    await args.runtime.setPosture(session, modeId)
  })
  handle('sessions:reconcile-reopen', async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
    sessionReopenResult(() => args.runtime.reconcileRetiredSession(reference, expectedRetiredAt, operationId, config)))
  handle('sessions:reopen', async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
    sessionReopenResult(() => args.runtime.reopenRetiredSession(reference, expectedRetiredAt, operationId, config)))
  handleWithEvent('sessions:resume', async (event, session: AgentSessionControl, prompt: string, operationId: string, agentMuxNote?: string) => {
    if (agentMuxNote !== undefined) assertManualPromptSenderTrusted(event.sender, args.window.webContents)
    return await args.runtime.resumeSession(session, prompt, operationId, config, agentMuxNote)
  })
  handle('sessions:interrupt', async (session: SessionControl) => { pauseUserProgress(session, 'Paused because you interrupted the Agent.'); await args.runtime.interrupt(session) })
  handleWithEvent('sessions:resize', async (event, attachmentId: string, cols: number, rows: number) => (
    await args.runtime.resizeSessionAttachment(event.sender.id, attachmentId, cols, rows)
  ))
  handle('sessions:observeStorage', async (session: SessionControl) => await args.runtime.observeStorage(session))
  handle('sessions:refresh', async (session: SessionControl) => await args.runtime.refresh(session, config))
  handle('sessions:recover', async (session: SessionControl, workspacePath?: string, operationId?: string) => await args.runtime.recoverSession(session, config, workspacePath, operationId))
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
  handleWithEvent('browser:discardRetainedUpload', async (event, selectionId: string) => {
    requireTrustedSender('browser:discardRetainedUpload', event)
    return await browserUploads.confirmDiscardSelection(selectionId, async selection => {
      if (args.window.isDestroyed()) return false
      const answer = await dialog.showMessageBox(args.window, { type: 'warning', title: 'Discard selected files?',
        message: '原页面后续上传将不可读，先完成或取消上传',
        detail: `${selection.files.join(', ') || 'Unknown document selection'}\n${selection.byteLength} bytes will be removed. Other pages and selections are kept.`,
        buttons: ['Keep files', 'Discard files'], defaultId: 0, cancelId: 0, noLink: true })
      return !args.window.isDestroyed() && answer.response === 1
    })
  })
  handleWithEvent('browser:listTargets', async (event, workspaceId?: string) => {
    requireTrustedSender('browser:listTargets', event)
    if (workspaceId !== undefined) workspace(config, workspaceId)
    const targets = [...browsers.targets(), ...externalBridge.list()].filter(row => workspaceId === undefined || row.workspaceId === workspaceId)
    return { targets: targets.slice(0, 256), ...(targets.length > 256 ? { warning: 'More Browser targets exist than this bounded discovery response can show.' } : {}) }
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
  handle('browser:create', async (id: string, url: string, workspaceId: unknown, rememberedProfileId?: string) =>
    await browsers.create(id, url, verifiedBrowserWorkspace(config.workspaces, workspaceId), rememberedProfileId))
  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))
  handle('browser:back', async (id: string) => await browsers.back(id))
  handle('browser:forward', async (id: string) => await browsers.forward(id))
  handle('browser:reload', async (id: string) => await browsers.reload(id))
  handleWithEvent('browser:switchProfile', async (event, id: string, profileId: string) => {
    requireTrustedSender('browser:switchProfile', event)
    return await browsers.switchProfile(id, profileId)
  })
  handleWithEvent('browser:listProfiles', (event) => {
    requireTrustedSender('browser:listProfiles', event)
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
    return await browserInputHistory.list(resolveInputHistoryScope(target))
  })
  handleWithEvent('browser:recordInputHistory', async (event, target: BrowserInputHistoryTarget, text: string) => {
    requireTrustedSender('browser:recordInputHistory', event)
    return await browserInputHistory.record(resolveInputHistoryScope(target), text)
  })
  handleWithEvent('browser:removeInputHistory', async (event, target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope, text: string) => {
    requireTrustedSender('browser:removeInputHistory', event)
    return await browserInputHistory.remove(requireInputHistoryScope(target, scope), text)
  })
  handleWithEvent('browser:clearInputHistory', async (event, target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope) => {
    requireTrustedSender('browser:clearInputHistory', event)
    return await browserInputHistory.clear(requireInputHistoryScope(target, scope))
  })
  handle('browser:openDevTools', (id: string) => browsers.openDevTools(id))
  handle('browser:setViewport', (id: string, viewport: BrowserViewport) => browsers.setViewport(id, viewport))
  handle('browser:captureScreenshot', async (id: string) => await browsers.captureScreenshot(id))
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
    operationId?: string
  ) => {
    requireTrustedSender('browser:runScript', event)
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
    if (externalBrowsers.has(id)) {
      workspace(config, externalBridge.require(id).workspaceId)
      return await externalBrowsers.runScript(id, code, operator, operationId)
    }
    return await browsers.runScript(id, code, operator, undefined, operationId)
  })
  handleWithEvent('browser:checkOutcomeFields', async (event, id: string, input: import('../shared/browser-outcome-criteria.js').BrowserOutcomeFieldRunInput) => {
    requireTrustedSender('browser:checkOutcomeFields', event)
    if (config.browser.agentAutomation !== true) throw new Error('Browser automation is off. Turn it on in Settings › Browser.')
    return await browsers.checkOutcomeFields(id, input)
  })
  handleWithEvent('browser:verifyOutcome', async (event, id: string, operationId: string) => {
    requireTrustedSender('browser:verifyOutcome', event)
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
  handleWithEvent('browser:returnControl', async (event, id: string) => {
    requireTrustedSender('browser:returnControl', event)
    return browsers.returnControl(id)
  })
  handleWithEvent('browser:runReplay', async (event, id: string, plan: import('../shared/browser-operation.js').BrowserReplayPlan, operator?: import('../shared/browser-operation.js').BrowserOperator) => {
    requireTrustedSender('browser:runReplay', event)
    if (config.browser.agentAutomation !== true) {
      throw Object.assign(new Error('Agent browser automation is off. Turn it on in Settings › Browser.'), { code: 'BROWSER_AUTOMATION_DISABLED' satisfies AgentMuxControlErrorCode })
    }
    return await browsers.runReplay(id, plan, operator)
  })
  handleWithEvent('browser:selectElement', async (event, id: string) => {
    requireTrustedSender('browser:selectElement', event)
    return await browsers.selectElement(id)
  })
  handleWithEvent('browser:startDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:startDemonstration', event)
    return await browsers.startDemonstration(id)
  })
  handleWithEvent('browser:stopDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:stopDemonstration', event)
    return await browsers.stopDemonstration(id)
  })
  handleWithEvent('browser:getDemonstration', async (event, id: string) => {
    requireTrustedSender('browser:getDemonstration', event)
    return await browsers.getDemonstration(id)
  })
  handleWithEvent('browser:getTaskAssets', async (event, id: string) => {
    requireTrustedSender('browser:getTaskAssets', event)
    return await browsers.getTaskAssets(id)
  })
  handleWithEvent('browser:controlTask', async (event, request: unknown) => {
    requireTrustedSender('browser:controlTask', event)
    return await executeBrowserTaskControl(request, browsers, config.browser.agentAutomation === true)
  })
  handleWithEvent('browser:importTaskAsset', async (event, id: string, name?: string) => {
    requireTrustedSender('browser:importTaskAsset', event)
    return await browsers.importTaskAsset(id, name)
  })
  handleWithEvent('browser:saveTaskAssetDraft', async (event, id: string, assetId: string, revision: number, content: BrowserTaskContent) => {
    requireTrustedSender('browser:saveTaskAssetDraft', event)
    return await browsers.saveTaskAssetDraft(id, assetId, revision, content)
  })
  handleWithEvent('browser:saveTaskAssetVersion', async (event, id: string, assetId: string, revision: number, content: BrowserTaskContent) => {
    requireTrustedSender('browser:saveTaskAssetVersion', event)
    return await browsers.saveTaskAssetVersion(id, assetId, revision, content)
  })
  handleWithEvent('browser:locateTaskAssetStep', async (event, id: string, assetId: string, revision: number, stepId: string) => {
    requireTrustedSender('browser:locateTaskAssetStep', event)
    return await browsers.locateTaskAssetStep(id, assetId, revision, stepId)
  })
  handleWithEvent('browser:runTaskBatch', async (event, input: BrowserTaskBatchInput) => {
    requireTrustedSender('browser:runTaskBatch', event)
    if (!config.browser.agentAutomation) throw new Error('Browser automation is disabled in settings.')
    return await browsers.runTaskBatch(input)
  })
  handleWithEvent('browser:stopTaskBatch', async (event, id: string, batchId: string) => {
    requireTrustedSender('browser:stopTaskBatch', event)
    return await browsers.stopTaskBatch(id, batchId)
  })
  handleWithEvent('browser:runTaskAsset', async (event, input: BrowserTaskAssetRunInput) => {
    requireTrustedSender('browser:runTaskAsset', event)
    if (!config.browser.agentAutomation) throw new Error('Browser automation is disabled in settings.')
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
  handleWithEvent('browser:registerPresentation', (event, input: {
    browserId: string; occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry
  }) => {
    requireTrustedSender('browser:registerPresentation', event)
    return browsers.registerPresentation(event.sender, event.senderFrame, input)
  })
  handleWithEvent('browser:updatePresentation', (event, leaseId: string, geometry: BrowserPresentationGeometry) => {
    requireTrustedSender('browser:updatePresentation', event)
    browsers.updatePresentation(event.sender, event.senderFrame, leaseId, geometry)
    void nativeChrome.refresh().catch(() => warnNativeChrome('Native floating content could not follow the Browser frame. The Browser remains available; close and reopen the floating panel.'))
  })
  handleWithEvent('browser:removePresentation', (event, leaseId: string) => {
    requireTrustedSender('browser:removePresentation', event)
    browsers.removePresentation(event.sender, event.senderFrame, leaseId)
    void nativeChrome.refresh().catch(() => warnNativeChrome('Native floating content could not follow the Browser frame. The Browser remains available; close and reopen the floating panel.'))
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
      void nativeChrome.refresh().catch(() => warnNativeChrome('Native floating content could not follow the Browser frame. The Browser remains available; close and reopen the floating panel.'))
    }
    return receipt
  })
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => {
    browsers.setBounds(id, bounds)
    void nativeChrome.refresh().catch(() => warnNativeChrome('Native floating content could not follow the Browser frame. The Browser remains available; close and reopen the floating panel.'))
  })
  handle('browser:release', async (id: string) => await browsers.release(id))
  handle('browser:restore', async (
    id: string,
    input: { workspaceId: unknown; profileId: string; viewport: BrowserViewport }
  ) => await browsers.restore(id, { ...input, workspaceId: verifiedBrowserWorkspace(config.workspaces, input.workspaceId) }))
  handle('browser:close', (id: string) => browsers.close(id))
  const detach = args.runtime.attach(args.window.webContents)
  const rpcHttp = agentMuxRpcHttpOptions()
  const control = new AgentMuxControlServer({
    execute: executeControl,
    nameHistory: query => desktopNameHistory(spatialState, demands, query),
    spatialState,
    topics: topicKnowledge,
    files: publicFiles,
    schedules: args.progressLoops,
    notebookStore,
    coreClients: () => args.runtime.rpcClients(),
    snapshot: params => observeClientRpcSnapshot(config, args.scratchTopics, params),
    ...(rpcHttp ? { http: rpcHttp } : {}),
    metrics,
    toolkit: { subscribe: (toolId, onSnapshot, onEnd, signal) => toolkit.subscribe(toolId, onSnapshot, onEnd, signal),
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
  return async () => {
    await runOwnerDisposals([
      async () => { acceptingControl = false; disposeSpatial(); disposeNotebook()
    disposeToolkitIpc(); await toolkit.dispose() },
      () => {
        acceptingControl = false
        args.window.webContents.off('destroyed', closeMetrics)
        metrics.dispose()
        ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)
        disposeProgressInput()
        disposeProgressChanges()
        controlBridge.dispose()
      },
      async () => await control.stop(),
      () => detach(),
      () => {
        historyObservations.dispose()
        releaseResourceObservation()
      },
      () => notifier.dispose(),
      () => { browsers.onNativeInput = undefined; nativeChrome.dispose() },
      async () => await externalBrowsers.dispose(),
      () => browsers.dispose(),
      async () => await browserInputHistory.flush(),
      async () => await browserProfiles.dispose(),
      async () => await fileObservations.dispose(),
      async () => await files.dispose(),
      () => {
        for (const channel of channels) ipcMain.removeHandler(channel)
      }
    ], 'Failed to dispose Desktop IPC owners.')
  }
}
