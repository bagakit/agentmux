import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** A pasted screenshot is large but bounded; anything past this is a mistake, not a screenshot. */
const MAX_PASTED_IMAGE_BYTES = 16 * 1024 * 1024
const PASTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

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
  type AgentExecutorId,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxRunInputData
} from '@agentmux/core'
import type {
  AgentLaunchInput,
  AgentSessionControl,
  AppConfig,
  BrowserAnnotationMarker,
  BrowserBounds,
  BrowserPng,
  BrowserViewport,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreatePullRequestInput,
  CreateWorkspaceInput,
  DesktopControlResponse,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions,
  HostConfig,
  KeepOneOfFanOutInput,
  KeepOneOfFanOutOutcome,
  MoveWorkspacePathInput,
  NotificationModeId,
  RemoveWorktreeInput,
  RemoveWorktreeOutcome,
  RunFanOutInput,
  RunFanOutResult,
  SessionControl,
  TerminalLaunchInput,
  WorkspaceFileWriteInput,
  WorkspaceRecord
} from '../shared/contracts.js'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import {
  AGENT_ATTENTION_ACTIVATE_CHANNEL,
  CONTROL_CANCEL_CHANNEL,
  CONTROL_REQUEST_CHANNEL,
  CONTROL_RESPONSE_CHANNEL
} from '../shared/contracts.js'
import { terminalPalette } from '../shared/terminal-palettes.js'
import { createAgentNotifier } from './agent-notifier.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { BrowserProfileManager } from './browser-profile-manager.js'
import { nativeImageFromBrowserPng } from './browser-image.js'
import { ConfigStore } from './config-store.js'
import { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import { normalizeExternalUrl } from './external-url.js'
import { FileObservationRegistry } from './file-observation-registry.js'
import { runOwnerDisposals } from './owner-disposal.js'
import { RuntimeController } from './runtime-controller.js'
import { ScratchTopics } from './scratch-topics.js'
import { saveRuntimeConfig } from './runtime-config-transaction.js'
import { WorkspaceFiles } from './workspace-files.js'
import { classifyRetention, WorktreeService } from './worktree-service.js'
import { runFanOutRequest } from './fanout-request.js'
import { rebindLocalFolder } from './workspace-rebind.js'
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
  configStore: ConfigStore
  runtime: RuntimeController
  workspaceFiles?: WorkspaceFiles
  scratchTopics: ScratchTopics
}): Promise<() => Promise<void>> {
  let config = await args.configStore.get()
  const initialPalette = terminalPalette(config.appearance.terminalTheme)
  args.runtime.setTerminalViewColors({
    foreground: initialPalette.foreground,
    background: initialPalette.background
  })
  args.runtime.commit(await args.runtime.prepare(config))
  const files = args.workspaceFiles ?? new WorkspaceFiles((id) => args.runtime.executionHost(id))
  const worktrees = new WorktreeService((id) => args.runtime.executionHost(id), args.configStore)
  const git = new GitService((id) => args.runtime.executionHost(id))
  // `git` is handed in rather than let GhService build its own: the PR readiness read asks git and gh
  // about the same repository in one breath, and two separately-constructed services could resolve a
  // workspace's host differently.
  const gh = new GhService((id) => args.runtime.executionHost(id), git)
  const browserProfiles = new BrowserProfileManager()
  await browserProfiles.initialize()
  const browsers = new BrowserViewManager(args.window, browserProfiles)
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
    isAvailable: () => acceptingControl && !args.window.webContents.isDestroyed(),
    sendRequest: (request) => args.window.webContents.send(CONTROL_REQUEST_CHANNEL, request),
    sendCancellation: (cancellation) => args.window.webContents.send(CONTROL_CANCEL_CHANNEL, cancellation)
  })
  const acceptControl = (event: IpcMainEvent, response: DesktopControlResponse): void => {
    if (event.sender !== args.window.webContents || !response || typeof response.requestId !== 'string') return
    controlBridge.accept(response)
  }
  const executeControl = async (
    request: AgentMuxControlRequest
  ): Promise<AgentMuxControlResult> => await controlBridge.execute(request)
  ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (_event, ...values: TArgs) => listener(...values))
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
    ipcMain.handle(channel, (event, ...values: TArgs) => listener(event, ...values))
  }

  handle('config:get', () => config)
  handle('config:save', async (next: AppConfig) => {
    const saved = await saveRuntimeConfig({ runtime: args.runtime, configWriter: args.configStore, next })
    config = saved
    const palette = terminalPalette(saved.appearance.terminalTheme)
    args.runtime.setTerminalViewColors({
      foreground: palette.foreground,
      background: palette.background
    })
    return saved
  })
  handle('hosts:check', async (input: HostConfig) => {
    try {
      return await args.runtime.checkHost(input)
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  })
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
  handle('workspaces:chooseLocalFolder', async () => {
    const selection = await dialog.showOpenDialog(args.window, { properties: ['openDirectory'] })
    const path = selection.filePaths[0]
    if (selection.canceled || !path) return null
    const item: WorkspaceRecord = {
      id: randomUUID(),
      name: basename(path),
      hostId: 'local',
      path,
      kind: 'folder'
    }
    config = await args.configStore.save({ ...config, workspaces: [...config.workspaces, item] })
    return item
  })
  // 重绑一个本地文件夹 Workspace。编排在 `workspace-rebind` 里，所以测试够得着：这个 handler
  // 只剩一个转发表达式，没有可以插早退的语句位置。文本守卫看不见这里的早退——插一句
  // `return null`，重绑对用户永久失效而 2 条断言全绿（见 rebindLocalFolder 的注释）。
  handle('workspaces:rebindLocalFolder', async (workspaceId: string) => {
    const result = await rebindLocalFolder(workspaceId, config, {
      chooseDirectory: async (defaultPath) =>
        await dialog.showOpenDialog(args.window, { properties: ['openDirectory'], defaultPath }),
      save: async (next) =>
        await saveRuntimeConfig({ runtime: args.runtime, configWriter: args.configStore, next })
    })
    config = result.config
    return result.workspace
  })
  handle('workspaces:add', async (input: CreateWorkspaceInput) => {
    args.runtime.executionHost(input.hostId)
    const item: WorkspaceRecord = {
      id: randomUUID(),
      name: input.name?.trim() || input.path.split(/[\\/]/).filter(Boolean).pop() || input.path,
      hostId: input.hostId,
      path: input.path,
      kind: 'folder'
    }
    config = await args.configStore.save({ ...config, workspaces: [...config.workspaces, item] })
    return item
  })
  handle('workspaces:listBranches', async (workspaceId: string) => await worktrees.list(workspaceId, config))
  handle('workspaces:openBranch', async (workspaceId: string, branch: string) => {
    const selection = await worktrees.openBranch(workspaceId, branch, config)
    config = selection.config
    return selection
  })
  handle('workspaces:createWorktreeForBranch', async (input: CreateWorktreeForBranchInput) => {
    const selection = await worktrees.createForBranch(input, config)
    config = selection.config
    return selection
  })
  // 单条删除。与批量收尾（keepOneOfFanOut）共用同一个 teardown primitive，所以脏树保护在这条路上
  // 一样在场：`removeWorktree` 只在 git 确认后才撤记录。
  //
  // 关键取舍：拒绝在这里**不当异常往上抛**，而是作为 `retained` 正常返回。保护的全部意义就是让
  // 「这里还有活儿」这句话传到用户眼前，而 IPC 上的异常只剩一句被压平的字符串，调用方分不出
  //「git 挂了」和「有未提交改动，你要不要先看看」。两者要走的下一步完全不同。
  handle('workspaces:removeWorktree', async (input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome> => {
    try {
      const removal = await worktrees.removeWorktree(input, config)
      config = removal.config
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
      commitConfig: (next) => {
        config = next
      },
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
            agentSessionId: randomUUID(),
            createOperationId: randomUUID()
          }, current)
          return { sessionId: launched.session.id }
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
    config = result.config
    return { keptWorkspaceId: result.keptWorkspaceId, outcomes: result.outcomes }
  })
  handle('git:status', async (workspaceId: string) => await git.status(workspaceId, config))
  handle('git:stage', async (workspaceId: string, path: string) => {
    await git.stage(workspaceId, path, config)
  })
  handle('git:commit', async (workspaceId: string, message: string) => {
    await git.commit(workspaceId, message, config)
  })
  handle('git:diff', async (workspaceId: string, path: string) => await git.diff(workspaceId, path, config))
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
  handle('files:read', async (workspaceId: string, path: string) => await files.read(workspace(config, workspaceId), path))
  handle('files:write', async (workspaceId: string, input: WorkspaceFileWriteInput) =>
    await files.write(workspace(config, workspaceId), input)
  )
  handle('files:observe', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.observe(key, async () => (
      await files.observe(workspace(config, workspaceId), path, () => {
        if (args.window.webContents.isDestroyed()) return
        args.window.webContents.send('agentmux:workspace-file-invalidated', { workspaceId, path })
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
  handle('files:move', async (input: MoveWorkspacePathInput) => await files.move(
    workspace(config, input.source.workspaceId),
    workspace(config, input.destination.workspaceId),
    input
  ))
  handle('files:delete', async (workspaceId: string, path: string) => {
    await files.delete(workspace(config, workspaceId), path)
  })
  handle('files:reveal', async (workspaceId: string, path: string) => {
    shell.showItemInFolder(await files.localPathForReveal(workspace(config, workspaceId), path))
  })
  handle('scratch:readTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.read(workspace(config, workspaceId), topicId)
  )
  handle('scratch:listTopics', async (workspaceId: string) =>
    await args.scratchTopics.list(workspace(config, workspaceId))
  )
  handle('scratch:ensureTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.ensure(workspace(config, workspaceId), topicId)
  )
  handle('scratch:renameTitle', async (workspaceId: string, topicId: string, title: string) =>
    await args.scratchTopics.renameTitle(workspace(config, workspaceId), topicId, title)
  )
  /**
   * 资源采样的订阅与退订。
   *
   * 采样只在有订阅者时进行，因此这两个 handler 就是"折叠态零开销"这条约束的兑现处。
   * 退订必须可靠：Renderer 崩溃或刷新时若没人退订，采样会永远跑下去——所以除了显式
   * 退订，还监听 sender 的销毁与导航。
   */
  const usageSubscriptions = new Map<number, () => void>()
  const stopUsageSubscription = (webContentsId: number): void => {
    usageSubscriptions.get(webContentsId)?.()
    usageSubscriptions.delete(webContentsId)
  }
  handleWithEvent('resourceUsage:subscribe', (event) => {
    const sender = event.sender
    stopUsageSubscription(sender.id)
    const unsubscribe = args.runtime.resourceSampler.subscribe((snapshot) => {
      if (sender.isDestroyed()) return
      sender.send('agentmux:resource-usage', snapshot)
    })
    usageSubscriptions.set(sender.id, unsubscribe)
    const cleanup = (): void => stopUsageSubscription(sender.id)
    sender.once('destroyed', cleanup)
    sender.once('did-start-navigation', cleanup)
  })
  handleWithEvent('resourceUsage:unsubscribe', (event) => {
    stopUsageSubscription(event.sender.id)
  })
  handle('ui:readClipboardText', () => clipboard.readText())
  handle('ui:writeClipboardText', (text: string) => {
    clipboard.writeText(text)
  })
  handleWithEvent('ui:writeClipboardImage', (event, image: BrowserPng) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted clipboard image sender')
    clipboard.writeImage(nativeImageFromBrowserPng(image, (png) => nativeImage.createFromBuffer(png)))
  })
  handleWithEvent('ui:openExternal', async (event, rawUrl: string) => {
    await openExternalFromRenderer(event, args.window.webContents, rawUrl)
  })
  handleWithEvent('ui:savePastedImage', async (event, input: { bytes: Uint8Array; extension: string }) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted pasted image sender')
    // A CLI Agent reads images from disk, so a paste becomes a file it can open. The renderer supplies
    // bytes only — never a destination — so it cannot aim this write anywhere.
    const bytes = Buffer.from(input.bytes)
    if (bytes.byteLength === 0) throw new Error('Pasted image is empty.')
    if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) throw new Error('Pasted image exceeds the size limit.')
    const extension = PASTED_IMAGE_EXTENSIONS.has(input.extension) ? input.extension : 'png'
    const directory = join(app.getPath('home'), '.agentmux', 'pasted')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`)
    await writeFile(path, bytes, { mode: 0o600 })
    return path
  })
  handleWithEvent('ui:notifyAgentAttention', async (event, input: {
    sessionId: string
    title: string
    body: string
    mode: NotificationModeId
  }) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted notification sender')
    // The renderer decided this deserves attention and which dwell mode to use; main only delivers, and
    // says so honestly when it cannot present in that mode.
    return notifier.notify(input)
  })
  handle('providers:list', () => args.runtime.providerCatalog())
  handle('executors:detect', async (executorId: AgentExecutorId, hostId: string) => await args.runtime.detect(executorId, hostId, config))
  handle('sessions:snapshot', async () => await args.runtime.snapshot(config))
  handleWithEvent('sessions:launchAgent', async (event, input: AgentLaunchInput) => {
    const result = await args.runtime.launchAgent(input, config)
    if (!event.sender.isDestroyed()) return result
    const primary = Object.assign(
      new Error('The Desktop View disappeared before its Agent launch was delivered.'),
      { code: 'CONTROL_OWNER_LOST' }
    )
    try {
      await args.runtime.stopSession(result.session.control)
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`${primary.message} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
        { code: primary.code, cause: new AggregateError([primary, cleanupError]) }
      )
    }
    throw primary
  })
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => await args.runtime.launchTerminal(input, config))
  handle('sessions:timeline', async (session: AgentSessionControl) => await args.runtime.sessionTimeline(session))
  handleWithEvent('sessions:attach', async (event, session: SessionControl, afterSequence: number = 0) => {
    const result = await args.runtime.attachSession(event.sender.id, session, afterSequence, config)
    if (!event.sender.isDestroyed()) return result
    await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its Session Attachment was delivered.')
  })
  handleWithEvent('sessions:detach', async (event, attachmentId: string) => {
    await args.runtime.detachSession(event.sender.id, attachmentId)
  })
  handle('sessions:write', async (session: SessionControl, data: AgentMuxRunInputData) => {
    await args.runtime.write(session, data)
  })
  handle('sessions:submitPrompt', async (session: AgentSessionControl, prompt: string) => {
    await args.runtime.submitPrompt(session, prompt)
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
  handle('sessions:resume', async (session: AgentSessionControl, prompt: string, operationId: string) => (
    await args.runtime.resumeSession(session, prompt, operationId, config)
  ))
  handle('sessions:acknowledge', async (session: SessionControl, sequence: number) => {
    await args.runtime.acknowledge(session, sequence)
  })
  handle('sessions:interrupt', async (session: SessionControl) => await args.runtime.interrupt(session))
  handleWithEvent('sessions:resize', async (event, attachmentId: string, cols: number, rows: number) => {
    await args.runtime.resizeSessionAttachment(event.sender.id, attachmentId, cols, rows)
  })
  handle('sessions:refresh', async (session: SessionControl) => await args.runtime.refresh(session, config))
  handle('sessions:recover', async (session: SessionControl, workspacePath?: string) => await args.runtime.recoverSession(session, config, workspacePath))
  handle('sessions:stop', async (session: SessionControl) => await args.runtime.stopSession(session))
  handle('browser:create', async (id: string, url: string) => await browsers.create(id, url))
  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))
  handle('browser:back', async (id: string) => await browsers.back(id))
  handle('browser:forward', async (id: string) => await browsers.forward(id))
  handle('browser:reload', async (id: string) => await browsers.reload(id))
  handleWithEvent('browser:switchProfile', async (event, id: string, profileId: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browsers.switchProfile(id, profileId)
  })
  handleWithEvent('browser:listProfiles', (event) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return browserProfiles.listProfiles()
  })
  handleWithEvent('browser:createProfile', async (event, label: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.createProfile(label)
  })
  handleWithEvent('browser:deleteProfile', async (event, profileId: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    if (browsers.usesProfile(profileId)) {
      throw new Error('Browser Profile is still used by an open Browser')
    }
    await browserProfiles.deleteProfile(profileId)
  })
  handleWithEvent('browser:detectProfileImportSources', async (event) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.detectImportSources()
  })
  handleWithEvent('browser:importProfile', async (event, sourceToken: string, label: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.importProfile(sourceToken, label)
  })
  handle('browser:openDevTools', (id: string) => browsers.openDevTools(id))
  handle('browser:setViewport', (id: string, viewport: BrowserViewport) => browsers.setViewport(id, viewport))
  handle('browser:captureScreenshot', async (id: string) => await browsers.captureScreenshot(id))
  handleWithEvent('browser:selectElement', async (event, id: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser selection sender')
    return await browsers.selectElement(id)
  })
  handleWithEvent('browser:cancelElementSelection', async (event, id: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser selection sender')
    await browsers.cancelElementSelection(id)
  })
  handleWithEvent('browser:setAnnotationMarkers', async (
    event,
    id: string,
    navigationId: string,
    markers: BrowserAnnotationMarker[]
  ) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser annotation sender')
    await browsers.setAnnotationMarkers(id, navigationId, markers)
  })
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => browsers.setBounds(id, bounds))
  handle('browser:release', async (id: string) => await browsers.release(id))
  handle('browser:restore', async (
    id: string,
    input: { profileId: string; viewport: BrowserViewport }
  ) => await browsers.restore(id, input))
  handle('browser:close', (id: string) => browsers.close(id))
  const detach = args.runtime.attach(args.window.webContents)
  const control = new AgentMuxControlServer({ execute: executeControl })
  await control.start()
  return async () => {
    await runOwnerDisposals([
      () => {
        acceptingControl = false
        ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)
        controlBridge.dispose()
      },
      async () => await control.stop(),
      () => detach(),
      () => notifier.dispose(),
      () => browsers.dispose(),
      async () => await browserProfiles.dispose(),
      async () => await fileObservations.dispose(),
      async () => await files.dispose(),
      () => {
        for (const channel of channels) ipcMain.removeHandler(channel)
      }
    ], 'Failed to dispose Desktop IPC owners.')
  }
}
