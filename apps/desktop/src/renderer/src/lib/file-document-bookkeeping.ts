import { api } from './api'
import { isScratchWorkspaceId, type AppConfig } from '../../../shared/contracts'
import { scratchTopicIdFromDirectoryName } from '../../../shared/scratch-topics'
import { isPathWithinSubtree } from './workspace-paths'
import {
  documentKey,
  titleWorkbenchSurface,
  workbenchSurfaces,
  type FileWorkbenchSurface,
  type WorkbenchTab
} from './workbench-tabs'

/**
 * 开启中的文件文档的簿记（bookkeeping）——从 store 的 persist 闭包里拆出来的一整簇。
 *
 * 这些 Map 与 helper 本就是一件事的不同侧面：一份「当前打开的文件文档」在其生命周期里，Main 侧有一个
 * observer 子进程、renderer 侧有读/写/删/改名多条异步路径在并发跑。它们靠同一套纪律互相咬合：
 *   - 都以 `documentKey(workspaceId, path)` 为键（`regionDiffRequestIds` 例外，按 regionId 键——一个
 *     Region 同时只显示一个文件）；
 *   - `fileDocumentLifetimes` / `documentLifetime` / `advanceDocumentLifetime`：文档「代」计数。关一个
 *     文档面就 advance 一次，任何在途异步结果回来时先比对代号，代变了就丢弃——防止旧文档的读/写落到
 *     新文档上；
 *   - `fileReadRequestIds` + `fileReadInFlightCounts`：单调递增的读请求 id 做去抖，配合在途计数做去重；
 *   - `fileInvalidationSequences`：外部改动（observer 报文件变了）时递增，让在途的读知道自己已过期；
 *   - `fileSaveTails` + `workspaceFileMutationTails` + `withWorkspaceFileMutation` + `transferFileSaveTail`：
 *     写入/改名/删除的尾链（tail-chaining），保证同一文件、同一子树的写与结构性变更串行不交错；
 *   - `openFileRefs` / `disposeClosedFileOwners` / `disposeObserversForRemovedWorkspaces`：按当前打开的
 *     文件面枚举，回收不再被任何 Tab 引用（或所在 Workspace 已被删除）的 observer 子进程。
 *
 * 它们成为一个模块而不是散落在 store 里，是因为：这一簇全部位于 persist 闭包之前、且没有一个进入
 * `partialize`——即它们是纯进程内的运行期簿记，不随 store 快照持久化，也不依赖 store 的任何内部状态
 * （只经 `useAppStore`/`api` 这类外部句柄触达），因此可以整簇独立于 store 而存在。
 */

const fileDocumentLifetimes = new Map<string, number>()
export const fileReadRequestIds = new Map<string, number>()
export const fileReadInFlightCounts = new Map<string, number>()
export const fileInvalidationSequences = new Map<string, number>()
export const fileSaveTails = new Map<string, Promise<void>>()
export const workspaceFileMutationTails = new Map<string, Promise<void>>()
export const fileOpenRequests = new Map<string, Promise<boolean>>()

export function fileSurface(tab: WorkbenchTab | undefined, regionId?: string): FileWorkbenchSurface | null {
  if (!tab) return null
  const surface = regionId ? tab.regions[regionId] : titleWorkbenchSurface(tab)
  return surface?.kind === 'file' ? surface : null
}

export function isScratchTopicDocument(surface: FileWorkbenchSurface): boolean {
  const segments = surface.path.split('/').filter(Boolean)
  const directoryName = segments.at(-2)
  const fileName = segments.at(-1)
  return isScratchWorkspaceId(surface.workspaceId) &&
    fileName === 'topic.md' &&
    scratchTopicIdFromDirectoryName(directoryName ?? '') !== null
}

function openFileRefs(tabs: Readonly<Record<string, WorkbenchTab>>): Map<string, FileWorkbenchSurface> {
  return new Map(Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
    surface.kind === 'file' ? [[documentKey(surface.workspaceId, surface.path), surface] as const] : []
  ))))
}

export async function disposeClosedFileOwners(
  previousTabs: Readonly<Record<string, WorkbenchTab>>,
  nextTabs: Readonly<Record<string, WorkbenchTab>>
): Promise<void> {
  const previous = openFileRefs(previousTabs)
  const next = openFileRefs(nextTabs)
  await Promise.all([...previous].flatMap(([key, surface]) => {
    if (next.has(key)) return []
    advanceDocumentLifetime(key)
    return [api.files.unobserve(surface.workspaceId, surface.path)]
  }))
}

/**
 * Dispose the file observers of every open file surface whose Workspace no longer exists in `config`.
 *
 * Removing a Workspace (deleting a project, or deleting a host and with it every Workspace on it) runs
 * through `adoptedConfig`, which answers only "which Workspace is active now" — it never touches
 * `tabs`. So the removed Workspace's file Tabs stay in `state.tabs`, unreachable (the active Workspace
 * moved away) but still holding a live Main-side observer each. Every observer is a subprocess, and
 * Main frees it only when `WorkspaceFiles` disposes at app quit — the accumulation reported as a
 * file-observer subprocess leak. Persistence already drops these surfaces on the next restart
 * (`persistedSurfaceSurvives` requires the Workspace to still be configured), so the only thing that
 * outlives the removal within a session is the subprocess; this closes that gap.
 *
 * The unobserve is fire-and-forget for the same reason `disposeClosedFileOwners` does not await inside
 * a `set`: the caller's `set` must stay synchronous, and a failed unobserve has no recovery here.
 */
export function disposeObserversForRemovedWorkspaces(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  config: AppConfig
): void {
  const liveWorkspaceIds = new Set(config.workspaces.map((workspace) => workspace.id))
  for (const [key, surface] of openFileRefs(tabs)) {
    if (liveWorkspaceIds.has(surface.workspaceId)) continue
    advanceDocumentLifetime(key)
    void api.files.unobserve(surface.workspaceId, surface.path).catch(() => undefined)
  }
}

export async function withWorkspaceFileMutation<T>(
  workspaceId: string,
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previousMutation = workspaceFileMutationTails.get(workspaceId) ?? Promise.resolve()
  let releaseMutation!: () => void
  const mutation = new Promise<void>((resolve) => { releaseMutation = resolve })
  const tail = previousMutation.catch(() => {}).then(async () => await mutation)
  workspaceFileMutationTails.set(workspaceId, tail)
  const prefix = `${workspaceId}\0`
  const saves = [...fileSaveTails.entries()].flatMap(([key, save]) => (
    key.startsWith(prefix) && isPathWithinSubtree(key.slice(prefix.length), path) ? [save] : []
  ))
  try {
    await previousMutation.catch(() => {})
    await Promise.all(saves.map(async (save) => await save.catch(() => {})))
    return await operation()
  } finally {
    releaseMutation()
    await tail
    if (workspaceFileMutationTails.get(workspaceId) === tail) {
      workspaceFileMutationTails.delete(workspaceId)
    }
  }
}

export function transferFileSaveTail(workspaceId: string, path: string, nextPath: string): void {
  const key = documentKey(workspaceId, path)
  const tail = fileSaveTails.get(key)
  if (!tail) return
  const nextKey = documentKey(workspaceId, nextPath)
  const previous = fileSaveTails.get(nextKey) ?? Promise.resolve()
  const transferred = Promise.all([previous.catch(() => {}), tail.catch(() => {})]).then(() => {})
  if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  fileSaveTails.set(nextKey, transferred)
  void transferred.finally(() => {
    if (fileSaveTails.get(nextKey) === transferred) fileSaveTails.delete(nextKey)
  })
}

export function documentLifetime(key: string): number {
  return fileDocumentLifetimes.get(key) ?? 0
}

export function advanceDocumentLifetime(key: string): number {
  const lifetime = documentLifetime(key) + 1
  fileDocumentLifetimes.set(key, lifetime)
  fileReadRequestIds.set(key, (fileReadRequestIds.get(key) ?? 0) + 1)
  return lifetime
}

// Monotonic per-Region request id so a slow diff cannot overwrite a newer one (the same request-id
// discipline useGitStatus uses). Keyed by regionId — a Region shows exactly one file at a time.
export const regionDiffRequestIds = new Map<string, number>()
