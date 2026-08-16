import type {
  AgentCatalogEntry,
  AgentMuxAgentContinuityResult,
  AgentMuxAgentContinuityConflictReason,
  AgentMuxAgentContinuityUnavailableReason,
  AgentCapabilities,
  AgentDisplayState,
  AgentExecutorConfig,
  AgentExecutorId,
  AgentProviderId,
  LaunchOptionSelection,
  AgentMuxClientEvent,
  AgentMuxEvidenceSource,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRunDataEvent,
  AgentMuxRunExitReason,
  AgentMuxRunInputData,
  AgentMuxRunRef,
  AgentMuxRunReplayGap,
  AgentMuxRunState,
  AgentTerminalCapabilityState,
  AgentTerminalPromptDeliveryState,
  AgentTerminalOutputChannelState,
  AgentTurnUsage,
  AgentMuxControlError,
  AgentMuxControlErrorCode,
  AgentMuxControlBrowserRunOutcome,
  AgentMuxControlBrowserOperation,
  AgentMuxControlRequest,
  AgentMuxControlResult,
  AgentMuxExecutorProbeOutcome,
  AgentTimelineItem,
  AgentTimelineSnapshot
} from '@agentmux/core'
import type { BrowserActivityState, BrowserOperator, BrowserOperation, BrowserReplayPlan } from './browser-operation'
export type { BrowserActivityState, BrowserOperator } from './browser-operation'
export type { BrowserOperation, BrowserReplayPlan } from './browser-operation'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type ScratchTopicSnapshot
} from './scratch-topics'
import type {
  CreatePullRequestInput,
  CreatePullRequestResult,
  GitAheadBehind,
  GitFileDiff,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions,
  GitRemoteResult,
  GitStatusResult,
  PrReadiness
} from './git-contracts'
import type { UsageSnapshot } from './process-usage'
import type {
  NotificationDelivery,
  NotificationModeId,
  NotificationSettings
} from './notification-presentation'

export { SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME }
export type { RunUsage, UsageSnapshot } from './process-usage'
export type { ScratchTopicSnapshot } from './scratch-topics'
// Only the two names product code imports through the contracts path are re-exported here; the rest of
// the notification vocabulary is imported straight from ./notification-presentation where it is used.
export type { NotificationDelivery, NotificationModeId } from './notification-presentation'

/**
 * The attention-notification payload, as it crosses renderer → preload → main.
 *
 * ONE declaration, because there were four: this contract, `preload/index.ts`'s parameter, `ipc.ts`'s
 * inline handler type, and `AttentionNotifierPorts.notify` in the renderer. Every one of them spelled
 * the same four fields by hand, so adding a fifth meant editing four places — and the failure mode of
 * missing one is silent in the worst way: the extra field is simply dropped at whichever hop still has
 * the old shape, and the feature quietly does not work while every layer type-checks.
 *
 * That is not hypothetical. `sound` is exactly such a field (see below), and the reason it is being
 * added at all is that its predecessor — an optional `silent` on main's request type — existed, was
 * honoured by delivery, and had no caller anywhere in the app.
 *
 * Main's own `NotificationRequest` stays separate on purpose: it is main's internal shape, and it
 * carries nothing the renderer sends. This is the wire, not the implementation.
 */
export type AgentAttentionNotifyInput = {
  sessionId: string
  title: string
  body: string
  mode: NotificationModeId
  /**
   * Whether the user asked for a sound. Resolved from config by the renderer (the side that owns the
   * config projection) and sent as an ANSWER, so main never re-derives a default that could disagree.
   */
  sound: boolean
}

// Not exported: the only consumer is the `HostConfig` union below. Its sibling `SshHostConfig` IS
// exported because five call sites narrow on it by name; this one has none, and an export nobody
// imports reads as a promise that the shape is part of the wire surface.
type LocalHostConfig = {
  id: 'local'
  kind: 'local'
  label: string
}

export type SshHostConfig = {
  id: string
  kind: 'ssh'
  label: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}

export type HostConfig = LocalHostConfig | SshHostConfig

export type { AgentExecutorConfig, AgentExecutorId, AgentTimelineItem, AgentTimelineSnapshot }

/**
 * Every `WorkspaceRecord['kind']`, once, and the single source of truth for it. Iterate this (never a
 * hand-written list) when a test or a consumer needs to walk every kind.
 *
 * Before this tuple existed, `kind` was a bare `'folder' | 'worktree'` union compared by hand at ~7
 * sites (`kind === 'folder'`, `kind !== 'worktree'`, …). Adding a third member was therefore a SILENT
 * change: every one of those comparisons kept compiling and quietly took the pre-existing branch. That
 * is sharper here than for a many-armed union — with only two members, a `kind !== 'worktree'` test
 * literally MEANS "is a folder", so a third kind is silently folded into whichever side the author
 * happened to write. The tuple + `WorkspaceKind` + `assertUnreachableWorkspaceKind` turn that into a
 * compile error at the one place each semantic question is decided (see `isFolderWorkspace` /
 * `isWorktreeWorkspace`).
 */
export const WORKSPACE_KINDS = ['folder', 'worktree'] as const

/**
 * The kind of on-disk backing a Workspace record has. DERIVED from `WORKSPACE_KINDS` so the direction
 * is forced: a member added to the tuple widens this type (and reds every exhaustive switch below),
 * whereas a hand-written union could silently disagree with the tuple. See the two-way exactness proof
 * next to `isScratchWorkspaceId`, which bites if the field is ever re-divorced from the tuple.
 */
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/**
 * The exhaustiveness backstop for any consumer that switches on `workspace.kind`.
 *
 * `tsconfig` here runs `strict` but NOT `noImplicitReturns`, so a `switch (workspace.kind)` that
 * forgets a case does not fail on its own — tsc just widens the return type to include `undefined` and
 * stays green. Route every such switch's `default` through this: with all kinds handled `kind` is
 * `never` here and it compiles; add a member and `kind` is that member (not `never`), the call fails to
 * type-check, and the omission cannot ship. The throw is only the runtime backstop — the compile error
 * at the call site is the guard.
 */
export function assertUnreachableWorkspaceKind(kind: never): never {
  throw new Error(`Unhandled workspace kind: ${JSON.stringify(kind)}`)
}

export type WorkspaceRecord = {
  id: string
  name: string
  hostId: string
  path: string
  kind: WorkspaceKind
  repoPath?: string
  branch?: string
}

/**
 * Two-way exactness between `WORKSPACE_KINDS` and `WorkspaceKind`. Each conditional is `true` only when
 * its containment holds and `never` otherwise, and `never` is not assignable to a `true` slot — so a
 * break in either direction is a compile error that names which half failed.
 *
 * `satisfies readonly WorkspaceKind[]` alone would prove only ⊆ (the tuple lists nothing that is not a
 * kind); a short tuple would pass it. This proves ⊇ as well (every kind is in the tuple), which is the
 * direction a member addition would break. `void` keeps the proof from reading as dead code.
 */
const _workspaceKindsAreExactlyTheUnion: [
  (typeof WORKSPACE_KINDS)[number] extends WorkspaceKind ? true : never,
  WorkspaceKind extends (typeof WORKSPACE_KINDS)[number] ? true : never
] = [true, true]
void _workspaceKindsAreExactlyTheUnion

/**
 * Whether a Workspace is a plain folder rather than a git worktree. The SSOT for the `kind === 'folder'`
 * test that the rebind, project-grouping and file-explorer paths used to inline. Centralising it in a
 * `switch` routed through `assertUnreachableWorkspaceKind` means a third kind cannot compile until
 * someone decides, HERE, whether it is folder-like — instead of each call site silently answering "yes"
 * (its `=== 'folder'` stays false) or "no" (its `!== 'folder'` stays true) for the new kind.
 *
 * A `switch` (not `kind === 'folder'`) is what makes it exhaustiveness-checked: TypeScript narrows the
 * `true` branch to a folder surface, which keeps the returned type predicate sound, and the `default`
 * reds the day a member is added.
 */
export function isFolderWorkspace(
  workspace: WorkspaceRecord
): workspace is WorkspaceRecord & { kind: 'folder' } {
  switch (workspace.kind) {
    case 'folder':
      return true
    case 'worktree':
      return false
    default:
      return assertUnreachableWorkspaceKind(workspace.kind)
  }
}

/**
 * Whether a Workspace is a git worktree rather than a plain folder. The SSOT for the `kind === 'worktree'`
 * / `kind !== 'worktree'` test that fan-out grouping and worktree removal used to inline. Same
 * exhaustiveness contract as {@link isFolderWorkspace}: a third kind must be classified here before it
 * compiles, rather than being silently swept into the "not a worktree" side at each call site.
 */
export function isWorktreeWorkspace(
  workspace: WorkspaceRecord
): workspace is WorkspaceRecord & { kind: 'worktree' } {
  switch (workspace.kind) {
    case 'worktree':
      return true
    case 'folder':
      return false
    default:
      return assertUnreachableWorkspaceKind(workspace.kind)
  }
}

/**
 * Reserved id for the always-present "no project" scratch workspace. It is a real
 * `kind:'folder'` record backed by a dedicated on-disk directory (so it satisfies the
 * strict config schema and every file/launch path works unchanged), rendered distinctly
 * in the sidebar. See `ConfigStore.get` (main) for provisioning.
 */
export function isScratchWorkspaceId(id: string | null | undefined): boolean {
  return id === SCRATCH_WORKSPACE_ID
}

/**
 * Every `TerminalThemeId`, once, and the single source of truth for it. Iterate this (never a
 * hand-written list) when a consumer or a validator needs to walk every theme.
 *
 * Before this tuple existed, the type was a bare `'graphite' | 'catppuccin-mocha'` union, and the
 * persistence-layer validator (`appearanceSchema` in `main/config-store.ts`) re-spelled the members as
 * an independent `z.enum(['graphite', 'catppuccin-mocha'])` with no compiler link back to the union.
 * Adding a member to the union therefore compiled clean while config load fail-closed rejected any
 * config carrying the new theme (`.strict()` + enum) — a valid user preference silently dropped, with
 * tsc silent throughout, and "add a member" is the common direction. Deriving both the union and the
 * schema from this one tuple removes the second declaration point. The sibling `notifications` field in
 * the same schema was already derived from `NOTIFICATION_TIERS` this way; `terminalTheme` was the copy.
 */
export const TERMINAL_THEME_IDS = ['graphite', 'catppuccin-mocha'] as const

/**
 * The terminal appearance theme id. DERIVED from `TERMINAL_THEME_IDS` so the direction is forced: a
 * member added to the tuple widens this type, and `z.enum(TERMINAL_THEME_IDS)` in `config-store.ts`
 * widens with it (the schema reads the tuple), so the validator can never fall behind the union.
 */
export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number]

/**
 * Two-way exactness between `TERMINAL_THEME_IDS` and `TerminalThemeId`, identical in intent to the
 * `_workspaceKindsAreExactlyTheUnion` proof above. `satisfies readonly TerminalThemeId[]` alone would
 * prove only ⊆; this proves ⊇ as well (every theme is in the tuple), the direction a member addition
 * would break. `void` keeps the proof from reading as dead code.
 */
const _terminalThemeIdsAreExactlyTheUnion: [
  (typeof TERMINAL_THEME_IDS)[number] extends TerminalThemeId ? true : never,
  TerminalThemeId extends (typeof TERMINAL_THEME_IDS)[number] ? true : never
] = [true, true]
void _terminalThemeIdsAreExactlyTheUnion

/**
 * The terminal font size, in CSS pixels, and the single source of truth for its default and its
 * allowed range. `terminal-theme.ts` READS `TERMINAL_FONT_SIZE_DEFAULT` (it does not re-declare a
 * literal), the persistence layer clamps every stored value through {@link clampTerminalFontSize}, and
 * the Appearance control bounds its input by these constants — one declaration point for a number that
 * would otherwise be copied into four files and silently drift.
 *
 * `DEFAULT` is the value the terminal shipped with before the size was adjustable, so a config that
 * predates the field, or one that never set it, renders exactly as it did before.
 */
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_FONT_SIZE_DEFAULT = 12

/**
 * Force a font size into the allowed range. This is the ONE place a size is clamped — the persistence
 * schema calls it on every parse, so no unclamped value can reach disk or the renderer. It is
 * deliberately not called from the renderer or `terminal-theme.ts`: those trust the persisted value.
 *
 * Rounds first (a hand-edited `12.6` becomes `13`, not a fractional cell metric), and a non-finite
 * input (`NaN`, `Infinity`) falls back to the default rather than to a boundary — `NaN` is not "too
 * small", it is "no value".
 */
export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_DEFAULT
  const rounded = Math.round(value)
  if (rounded < TERMINAL_FONT_SIZE_MIN) return TERMINAL_FONT_SIZE_MIN
  if (rounded > TERMINAL_FONT_SIZE_MAX) return TERMINAL_FONT_SIZE_MAX
  return rounded
}

export const APP_APPEARANCE_IDS = ['dark', 'light', 'system'] as const
export type AppAppearanceId = (typeof APP_APPEARANCE_IDS)[number]

/**
 * 用户对一个应用链接 scheme 记住的两档答案，唯一真源。
 *
 * 为什么是元组而不是裸 union：`config-store.ts` 的 `appLinkSchemes` 要用 `z.enum(...)` 校验磁盘上
 * 的值，而手抄一份 `z.enum(['allow', 'deny'])` 正是 `TERMINAL_THEME_IDS` 那段注释记下的形状——
 * 抄出来的那份今天等价，等到 union 加一档时只有一边跟着走，另一边 `.strict()` 静默丢值。房规由
 * `schema-enum-ssot.test.ts` 守着：枚举成员必须**追溯到一个 import 进来的元组**，不是文本相同。
 *
 * **缺席是第三档**，不在这个元组里：没记过就是没问过，与 `'deny'` 是两件事（见 `appLinkOutcome`）。
 * 这里只列「记下来的答案」有哪几种。
 */
export const APP_LINK_SCHEME_CHOICES = ['allow', 'deny'] as const

/**
 * 用户对某个 scheme 记住的答案。DERIVED 自 {@link APP_LINK_SCHEME_CHOICES}，方向被锁死：往元组里
 * 加一档，这个类型和 `config-store.ts` 的校验一起变宽。
 */
export type AppLinkSchemeChoice = (typeof APP_LINK_SCHEME_CHOICES)[number]

/**
 * 两向精确，同 `_terminalThemeIdsAreExactlyTheUnion`。`satisfies` 只能证 ⊆；加一档会先坏的是 ⊇。
 */
const _appLinkSchemeChoicesAreExactlyTheUnion: [
  (typeof APP_LINK_SCHEME_CHOICES)[number] extends AppLinkSchemeChoice ? true : never,
  AppLinkSchemeChoice extends (typeof APP_LINK_SCHEME_CHOICES)[number] ? true : never
] = [true, true]
void _appLinkSchemeChoicesAreExactlyTheUnion

/**
 * Project Rail 的密度档，唯一真源。用户拥有：控件就地落在 Projects 标题行加号旁，不进设置页。
 *
 * 极少的档位而非无级滑块——三个拨盘（每层缩进 / 行图标 / 行高）一起从缺省移到更紧，只有两三个
 * 好值，滑块只会逼用户自己找一个。缺席即 `default`（DEN「Project Rail 与 Topic 行密度」）。
 *
 * 与 `APP_LINK_SCHEME_CHOICES` 同形：`config-store.ts` 用 `z.enum(...)` 校验磁盘值，成员必须
 * **追溯到一个 import 进来的元组**（`schema-enum-ssot.test.ts`），手抄一份 `z.enum(['default',...])`
 * 会在加档时静默丢值。类型直接派生自元组，加档两处一起变宽。
 */
export const PROJECT_RAIL_DENSITY_IDS = ['default', 'compact'] as const
export type ProjectRailDensity = (typeof PROJECT_RAIL_DENSITY_IDS)[number]

/** Desktop identity styling belongs to the executor, not the Provider or Runtime. */
export type AgentAvatarAppearance = { tint?: string; badge?: string }

export type AppearanceConfig = {
  agentAvatars?: Record<string, AgentAvatarAppearance>
  appAppearance?: AppAppearanceId
  terminalTheme: TerminalThemeId
  /**
   * Optional so the field lands without a version bump or a migration (the same path the sibling
   * `notifications` field took): a config written before it existed still parses, and consumers resolve
   * an absent value to `TERMINAL_FONT_SIZE_DEFAULT`. Absence therefore means "the default", never
   * "zero". Persisted values are guaranteed in range because the schema clamps every write.
   */
  terminalFontSize?: number
}

export type BrowserToolbarConfig = {
  selectElement: boolean
  screenshot: boolean
  devTools: boolean
  viewport: boolean
  saveBookmark: boolean
  more: boolean
}

export type BrowserConfig = {
  /**
   * Agent 驱动浏览器页面的总开关。可选是因为字段是后加的——`ConfigStore.get` 会把缺席补成具体的
   * `false` 并落盘一次（同 scratch/notifications 的补齐），所以缺席从不意味着"开"。
   * 这是一个总开关，不是权限分级：开了就是全套页面能力可用。
   */
  agentAutomation?: boolean
  /**
   * 用户对「把某个 scheme 的应用链接交给系统」记住的答案，按 scheme 名存（不带冒号，如 `alphaapp`）。
   *
   * 为什么按 scheme 而不按站点：用户回答的那一问是「准不准这类链接启动本机应用」，那是一个关于
   * **目标应用**的判断，不是关于当前这个页面的。按站点存会让同一个应用链接在文档域和开放平台域
   * 上各问一次，而用户两次想的是同一件事。
   *
   * 缺席即「没问过」，不是「拒绝」——这三档必须分得开（见 `appLinkOutcome`）。同 `agentAutomation`
   * 一样 optional，理由也一样：既有磁盘 config 没有这个字段，写成必需会让 browser 整块判失败。
   * 但这一个**不**回填成 `{}`：空对象与缺席在语义上完全一样（都是「一个都没记过」），补一次盘
   * 只是白写。
   */
  appLinkSchemes?: Record<string, AppLinkSchemeChoice>
  toolbar: BrowserToolbarConfig
}

/**
 * 当前配置形状的版本号，唯一真源。
 *
 * 本仓对配置演进的答案是**版本号 +1 然后重置**，不是往读取路径上叠回填（见测试
 * `resets retired config to current default without migration or fallback`）。凡改动配置形状到
 * 「旧文件读出来在语义上已经不对」的程度，就把这个数字 +1：低于它的磁盘配置被删掉重置成当前默认，
 * 等于它的正常校验，高于它的严格拒绝并保留文件（不猜未来形状）。
 *
 * 落在 contracts 而不是 config-store，是因为这个数字有**五**处消费者：本文件的 `AppConfig.version`
 * 类型、config-store 的 zod 字面量、`DEFAULT_CONFIG.version`、`get()` 里的重置阈值、以及 renderer
 * 那份浏览器预览用的 mock config。它们必须联动，而分居各处的联动常量必然 drift。
 *
 * 值得记下的是**谁在守它**：漏改这里的类型时，2058 条测试全绿（vitest 只转译不查类型），只有
 * `tsc --noEmit` 报错；而 tsc 是逐个挖的——修好类型才暴露出 api.ts 那处，一共两轮。所以这条的守卫是
 * 类型检查而不是测试，落在 `pnpm check` 的第一步（`pnpm typecheck` → 各包 `tsc --noEmit`）。只跑
 * `pnpm test` 验不出这一族漂移。
 */
export const CONFIG_VERSION = 9

/**
 * 用户自己的一条本地 prompt。
 *
 * 这一族此前是渲染层的一个 `as const` 数组（`COMPOSER_SHORTCUT_PRESETS`），于是「快捷指令」有两套：
 * Provider 声明的原生命令，和代码里写死的两条 prompt。用户的判断是「应该只有一套」，且要能自定义
 * ——所以正文搬到配置里，内置那两条降为**可改可删的默认项**。删掉即永久没有：保留一档不可删的
 * 内置就是保留两套数据所有权，只是把重复从界面挪到了数据层。
 *
 * `keyword` 一个字段供两处识别：`/` 候选的补全词，以及正文里的裸词识别（打出 `eli5` 即命中）。
 * 不建第二份注册表——两份清单必然漂移，而漂移时自己不会响。
 *
 * `providerId` 缺席即「对所有 Agent 可见」，不是「对谁都不可见」：一条不绑定的 prompt 是通用的，
 * 那是最常见的情形，所以它必须是缺席的那一档。绑定后只在该 Provider 的 Composer 出现。
 */
export type ComposerShortcut = {
  id: string
  keyword: string
  label: string
  body: string
  providerId?: AgentProviderId
}

export type AppConfig = {
  version: typeof CONFIG_VERSION
  hosts: HostConfig[]
  executors: Record<AgentExecutorId, AgentExecutorConfig>
  workspaces: WorkspaceRecord[]
  appearance: AppearanceConfig
  browser: BrowserConfig
  // Optional so the field can land without a version bump or a migration: `ConfigStore.get` fills the
  // explicit default when it is absent (same shape as the scratch-workspace back-fill), and every read
  // goes through resolveNotificationModeId, which also defaults. Absence therefore never means "off".
  notifications?: NotificationSettings
  /**
   * 用户拥有的本地 prompt 库。可选是因为字段是后加的（同 `appLinkSchemes` 的落地路径），既有磁盘
   * config 没有它，写成必需会让整块配置判失败。
   *
   * 与 `notifications` 不同，这一个**不回填**：缺席就地解析成空列表，不补一次盘。理由同
   * `appLinkSchemes`——空与缺席语义完全一样（都是「一条都没有」），补盘只是白写。更要紧的是它必须
   * 不回填：内置那两条是 `DEFAULT_CONFIG` 里的默认项，用户删光之后配置里就是空列表，任何「缺席即
   * 补上默认」的回填都会把删掉的东西送回来——删了又回来比一开始不能删更糟。
   */
  composerShortcuts?: ComposerShortcut[]
  /**
   * 用户就地选的 Project Rail 密度档。可选是因为字段后加（同 `appLinkSchemes` 的落地路径）：既有
   * 磁盘 config 没有它，写成必需会让整块判失败。
   *
   * **不回填**（同 `appLinkSchemes`）：缺席即默认档，读的地方一律 `?? 'default'`，落盘只在用户
   * 真的切了档时发生。密度是看法不是数据，补一次盘只是白写。
   */
  projectRailDensity?: ProjectRailDensity
}

export type FileDocument = {
  path: string
  content: string
  revision: string
}

export type WorkspaceFileReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'deleted' }
  // The target exists but is a directory. Not an error: the caller reveals it in the file tree
  // instead of opening it as a document. Path detection is pure-string, so a directory path is a
  // valid clickable link; only Main can tell it is a directory, so Main says so here.
  | { status: 'directory' }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileWriteInput = {
  path: string
  content: string
  expectedRevision: string | null
}

export type WorkspaceFileWriteResult =
  | { status: 'written'; revision: string }
  | { status: 'conflict'; observedRevision: string | null }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileInvalidated = {
  workspaceId: string
  path: string
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
  ignored?: boolean
  linkTarget?: string
  linkIssue?: 'unavailable'
}

export type CreateWorkspacePathInput = {
  path: string
  kind: 'file' | 'directory'
}

// Not exported: only `MoveWorkspacePathInput` below reads it, as the shape of its two ends.
type WorkspacePathRef = {
  workspaceId: string
  path: string
}

export type MoveWorkspacePathInput = {
  source: WorkspacePathRef
  destination: WorkspacePathRef
}

export type WorkspacePathMoveResult =
  | { status: 'moved' }
  | {
      status: 'error'
      code: string
      message: string
      finalLocation: 'source' | 'unknown'
    }

export type CreateWorkspaceInput = {
  hostId: string
  path: string
  name?: string
}

export type CreateWorktreeForBranchInput = {
  workspaceId: string
  branch: string
  path: string
  /**
   * Create `branch` from the repository's current HEAD instead of requiring it to already exist.
   *
   * This is what makes a fan-out possible: opening N fresh branches for one bake-off. Without it a
   * caller must create every branch by hand first. When the branch already exists this is refused
   * rather than silently re-pointing it — moving someone's existing branch is never the intent.
   */
  createBranch?: boolean
}

/**
 * One fan-out: the same prompt taken down N lanes, each on its own new branch and worktree.
 *
 * `baseName` is only a stem — the concrete branch names and paths are derived in main by the single
 * planning source, never chosen here, so a re-run of the same request is reproducible and no caller
 * can mint a second naming scheme.
 */
export type RunFanOutInput = {
  workspaceId: string
  prompt: string
  count: number
  baseName: string
  /** Executors to spread the lanes across, reused cyclically when there are fewer than lanes. */
  executorIds: readonly string[]
}

/**
 * What became of one lane. Mirrors the orchestrator's own three states exactly — a partial failure is
 * neither reported as total failure nor dressed up as success, and a lane that built a worktree but
 * could not launch says whether that directory is still on disk, or it becomes an orphan nobody claims.
 *
 * `cleanup` is that answer, and it uses the same vocabulary as every other teardown ({@link
 * WorktreeRetention}) rather than a second one. It was a `worktreeRetained: boolean` until the three
 * retention states were separated, and the boolean got one of them backwards: a removal that deleted the
 * directory and then failed to withdraw the record came back as `retained: true`, i.e. "the directory is
 * still there" about a directory git had just deleted. A boolean cannot carry that distinction, so it is
 * not a boolean.
 *
 * `null` means the lane's worktree was handed back — nothing is left for anyone to decide about.
 */
export type FanOutLaneOutcome =
  | { status: 'launched'; branch: string; path: string; sessionId: string }
  | {
      status: 'launch-failed'
      branch: string
      path: string
      error: string
      cleanup: { retention: WorktreeRetention; reason: string } | null
    }
  | { status: 'worktree-failed'; branch: string; path: string; error: string }

/**
 * `rejected` carries the planner's own reason (a count below one, past the ceiling, or no executors).
 * `single` is not a failure: one lane is not a bake-off, so the caller should take the ordinary launch
 * path rather than pay for orchestration to compare a result with nothing.
 */
export type RunFanOutResult =
  | { kind: 'fanout'; lanes: FanOutLaneOutcome[] }
  | { kind: 'single'; executorId: string }
  | { kind: 'rejected'; reason: string }

export type KeepOneOfFanOutInput = {
  keepWorkspaceId: string
  removeWorkspaceIds: readonly string[]
}

/**
 * Remove one worktree on its own, outside any bake-off.
 *
 * `discardChanges` is the opt-in that says what it is: without it a worktree holding uncommitted work is
 * refused and git's own words come back as the reason. Losing an agent's output is the one outcome this
 * must never produce silently, so the caller has to ask for it in a second, separate act.
 */
export type RemoveWorktreeInput = {
  workspaceId: string
  discardChanges?: boolean
}

/**
 * The sentence shown in the removal confirm dialog about what the branch keeps.
 *
 * A plain string rather than a count, deliberately. The count has three outcomes that are NOT on one
 * scale — a number, zero, and "could not be checked" — and the last one is not a number at all. Handing
 * the renderer `number | null` would make every consumer re-derive the wording, and the wording is the
 * whole point: 0 means "checked, nothing unique, safe", null means "we do not know". A consumer that
 * treats null as 0 tells the user a reassuring lie. The one place that decision is made is
 * `branchRetentionNote`, on the main side, where the count is produced.
 */
export type WorktreeRemovalNotice = {
  note: string
}

/**
 * How far a removal got before it stopped. Three genuinely different states of the world, and the reason
 * this is a field rather than something each consumer infers from the message text.
 *
 * `retained` used to carry only a `reason` string, and every consumer then guessed the cause from its own
 * context. All three guessed differently and one could not be right: the batch banner asserted "they
 * still hold changes" for every retained lane, the removal dialog offered "Discard uncommitted work?"
 * whatever git had actually said, and the fan-out's launch-failure cleanup assumed a failed removal meant
 * the directory survived. That last assumption is false in exactly one case — the one below that says so.
 */
export type WorktreeRetention =
  /**
   * The dirty-tree protection refused. The directory and its record are both intact, git's own words say
   * what is uncommitted, and discarding it explicitly is a real next step the user can take.
   */
  | 'uncommitted-changes'
  /**
   * Git failed, or a precondition did. The directory and its record are both intact and nothing was
   * discarded. There is nothing to discard here, so offering to is a lie — the reason is the whole answer.
   */
  | 'git-failed'
  /**
   * Git removed the worktree and the record could not be withdrawn. **The directory is gone** and the
   * record still points at it. This is the one retention where "still on disk" is false, so saying "it
   * still holds changes" here sends the user to look for work that is deleted.
   *
   * Removing again IS the way out, and it is the caller's next step rather than a dead end — but only
   * because the service now recognizes the state. Verified against real git (2.50.1, one fresh
   * repository per case): a retry after a completed removal exits **128** with `fatal: '<path>' is not
   * a working tree`, for plain and `--force` alike, because our own successful removal already
   * deregistered the entry. Git is telling us its half is done; there was never anything left for it
   * to do. What made this permanent was reading that as a failure — two of ours in a row, first the
   * dirty-tree probe running inside the vanished directory (128) and then the removal itself. The
   * service now skips the probe when the path provably does not exist, and treats that one sentence
   * from git as "already gone" when the directory is likewise gone, so the retry reaches the record.
   */
  | 'record-not-withdrawn'

/**
 * Mirrors the batch teardown's states rather than inventing a second vocabulary: `removed` means git
 * confirmed and the record is withdrawn, `retained` means the removal did not complete, with `retention`
 * saying how far it got and git's reason carried through unedited.
 *
 * A refusal is deliberately NOT a thrown error across this boundary. `retained` is an ordinary answer the
 * surface has to render — the whole point of the protection is that "there is work here" reaches the user.
 */
export type RemoveWorktreeOutcome =
  | { status: 'removed'; removedPath: string; config: AppConfig }
  | { status: 'retained'; retention: WorktreeRetention; reason: string }

/**
 * One loser's fate in a keep-the-winner teardown. `retention` is required rather than optional so that a
 * new construction site cannot compile without deciding which of the three states it is reporting.
 */
export type FanOutTeardownResult =
  | { status: 'removed'; workspaceId: string; removedPath: string }
  | { status: 'retained'; workspaceId: string; retention: WorktreeRetention; reason: string }

export type KeepOneOfFanOutOutcome = {
  keptWorkspaceId: string
  outcomes: FanOutTeardownResult[]
}

export type WorkspaceBranchRecord = {
  name: string
  worktreePath: string | null
  workspaceId: string | null
  isCurrent: boolean
}

export type WorkspaceBranchesSnapshot =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      branches: WorkspaceBranchRecord[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

export type WorkspaceSelectionResult = {
  config: AppConfig
  workspace: WorkspaceRecord
}

export type AgentLaunchInput = {
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  scratchTopicId?: string
  agentSessionId?: string
  createOperationId?: string
  prompt?: string
  /**
   * The choice ids the launcher picked for this Provider's declared launch options (DESCRIBE half in
   * {@link AgentCatalogEntry.launchOptions}). Core resolves each choice's argv at spawn; a choice the
   * Provider does not declare fails closed. Absent/empty leaves the Provider's own defaults untouched.
   */
  launchOptions?: LaunchOptionSelection
  cols?: number
  rows?: number
}

export type TerminalLaunchInput = {
  hostId: string
  workspacePath: string
  createOperationId?: string
  shellCommand?: string
  cols?: number
  rows?: number
}

export type AgentSessionControl = {
  kind: 'agent'
  hostId: string
  agentSessionId: string
  run: AgentMuxRunRef
}

// Not exported, unlike its sibling `AgentSessionControl` (11 external narrowing sites): the two
// consumers are the `SessionControl` union below and the terminal arm of the Session union.
type TerminalSessionControl = {
  kind: 'terminal'
  hostId: string
  runId: string
  run: AgentMuxRunRef
}

export type SessionControl = AgentSessionControl | TerminalSessionControl

export type SessionStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
  /**
   * WHY an `exited` Run ended, carried verbatim from Core — synthesized there from the stop intent we
   * recorded and the code/signal the kernel observed. Absent unless the Run exited. Lets the surface tell
   * "you stopped it" (`user-stopped`) apart from "it died" (`crashed`) and from a bare 0 with no intent
   * (`unknown`), which we refuse to dress up as a clean finish.
   */
  exitReason?: AgentMuxRunExitReason
  continuity?: 'unavailable' | 'conflict'
  /**
   * WHY a continuity recovery could not happen, carried verbatim from Core.
   *
   * `continuity` alone answers "did it fail", and folding Core's distinct reasons into that single bit
   * is what makes every dead Agent read as one indistinguishable "resume unavailable". The three cases
   * call for different things from the user — a Provider that cannot resume at all is permanent, a
   * missing handle is about this one Session, and a conflict means something else already owns it — so
   * the reason has to survive the trip to the renderer. Absent for `conflict`, whose own two classes
   * ride on `continuityConflict` instead — see there for why they cannot share this field.
   */
  continuityReason?: AgentMuxAgentContinuityUnavailableReason
  /**
   * WHICH of Core's two conflict classes this is, carried verbatim.
   *
   * A separate field rather than another member of `continuityReason`: that field's union is Core's
   * *unavailable* reasons, and widening it would let a conflict value flow into the `unavailable`
   * branch of every existing switch — the compiler would stop objecting exactly where the two
   * concepts must stay apart.
   *
   * Why it must reach the renderer at all: the two classes call for **opposite** actions.
   * `session-run-changed` means this Agent Session is alive on a NEWER Run (something already resumed
   * it), so "wait" is a wrong instruction — waiting never brings back a Run that has been replaced;
   * the surface should re-read the live Session, which `sessions.refresh` does by stable
   * `agentSessionId`. `lifecycle-busy` means another lifecycle operation holds it right now, which is
   * transient — there waiting IS the right answer. Folding them lost that difference and told half the
   * users to wait for something that will never happen.
   */
  continuityConflict?: AgentMuxAgentContinuityConflictReason
}

type SessionSnapshotBase = {
  id: string
  hostId: string
  workspacePath: string
  label: string
  createdAt: number
  updatedAt: number
  processState: AgentMuxRunState
  interruptionReason?: string
  status: SessionStatus
  latestOutputBytes: number
}

/**
 * 「PTY 为什么消失」那一条事实，从任何带着它的形状里取出来。
 *
 * Core 的 `runExitFacts` 将此事实交给状态投影以解释原因；这里另负责 Session 本体上的字段，
 * 且只有 interrupted 时保留。为什么这个落点也收成一处：这一段
 * `...(state === 'interrupted' && reason ? { interruptionReason: reason } : {})` 此前在三个地方
 * 各抄了一份——主进程的 agent 快照、主进程的 terminal 快照、renderer 的实时事件路径。
 *
 * 漏抄一处没有任何东西会红（字段可选、投影不要求在场），而后果是具体的：SessionPane 靠
 * `interruptionReason === 'daemon_restart'` 决定要不要自动重开一个终端。实时路径丢掉这条事实时，
 * 一个被 daemon 重启打死的终端不会自动恢复，只会摊着一个「Check again」——而按 PTY 已经没了的
 * 事实，那个按钮永远不可能成功。同一族事故已经发生过两次（`exitSignal`、`exitReason` 各一次，
 * 都是「崩溃当下看不到、reload 之后反而看到了」）。
 *
 * 入参收成「带这两条字段的任意对象」而不是具名类型：三个调用方的载体是三个不同的类型
 * （台账里的 run、线上的 process-state 事件），它们只在这两条上同名同义。
 */
export function runInterruptionFact(source: {
  state: AgentMuxRunState
  interruptionReason?: string
}): { interruptionReason?: string } {
  // 两个条件都必需：`interrupted` 之外的状态不该带这条（它只对「PTY 没了」有定义），而理由缺席时
  // 不能落成空串——空串会把「没说原因」伪装成「原因是空的」，也会让 daemon_restart 的判定读到假值。
  return source.state === 'interrupted' && source.interruptionReason
    ? { interruptionReason: source.interruptionReason }
    : {}
}

export type SessionSnapshot = SessionSnapshotBase & (
  | {
      kind: 'agent'
      providerId: AgentProviderId
      executorId: AgentExecutorId
      capabilities: AgentCapabilities
      /** Core-owned terminal capability fact; absent means no active degradation marker. */
      terminalCapability?: AgentTerminalCapabilityState
      terminalPromptDelivery?: AgentTerminalPromptDeliveryState
      /** Core-owned fact that this Run's live output channel could not be re-established; absent means healthy. */
      terminalOutputChannel?: AgentTerminalOutputChannelState
      pendingInteraction?: AgentMuxInteractionRequest
      /**
       * The launch-option choice ids that fixed this Agent's security posture at spawn, projected from
       * the Core Session record so a surface can show what this Agent is ALLOWED to do without asking
       * the user to remember what they picked. This is the DESCRIBE half only — ids, resolved against
       * the Provider's catalog declaration for labels. The argv these ids resolve to never leaves Core.
       * Absent when the create narrowed nothing, in which case the Agent runs on the Provider's own
       * defaults and no scope is displayed rather than a guess.
       */
      launchOptions?: LaunchOptionSelection
      /**
       * 最近一个 turn 的真实原生 token 用量，仅 usage 能力声明的 Provider（claude/codex）会有。缺席读作
       * "此 Provider 不报 token 用量"或"还没有一 turn 的用量"，UI 两者都不显示 0 或估算值。
       */
      turnUsage?: AgentTurnUsage
      control: AgentSessionControl
    }
  | { kind: 'terminal'; providerId: null; control: TerminalSessionControl }
)

export type RuntimeEvent = {
  type: 'core'
  hostId: string
  event: AgentMuxClientEvent
}

export type RuntimeSnapshot = {
  /** Connected hosts whose daemon launch provenance could not be verified. */
  runtimeOwnershipWarnings?: string[]
  /** Non-secret, app-lifetime notice for incomplete local shell environment loading. */
  environmentWarning?: string
  sessions: SessionSnapshot[]
  timelines: Record<string, AgentTimelineSnapshot>
  recoveryCandidates: AgentSessionRecoveryCandidate[]
}

export type AgentSessionRecoveryCandidate = {
  agentSessionId: string
  hostId: string
  workspacePath: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  capabilities: AgentCapabilities
  terminalCapability?: AgentTerminalCapabilityState
  label: string
  createdAt: number
  updatedAt: number
  run: AgentMuxRunRef
}

export type AgentLaunchResult = {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  timeline: AgentTimelineSnapshot
}

export type SessionAttachResult = {
  attachmentId: string
  session: SessionSnapshot
  /** Geometry confirmed by the Runtime snapshot that supplied this replay. */
  currentSize: { cols: number; rows: number } | null
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type SessionRecoveryResult =
  | { kind: 'terminal-restarted'; session: SessionSnapshot }
  | { kind: 'reattachable' | 'resumed'; session: SessionSnapshot }
  | Extract<AgentMuxAgentContinuityResult, { kind: 'unavailable' | 'retired' | 'conflict' }>

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type ExecutorDetection = {
  executorId: AgentExecutorId
  providerId: AgentProviderId
  hostId: string
  // 三态探测结局：available / missing / check-failed。boolean `installed` 会把「查不成」折进「没装」，
  // 而发现列表必须区分二者（环境退化那次误报的教训）。第四态 `unknown`（还没查）不在这里——它是
  // 「detect 还没返回」，由 store 侧的 checking 状态承载，不是一次探测能得出的结论。
  availability: AgentMuxExecutorProbeOutcome
}

export type DesktopControlResponse =
  | { requestId: string; ok: true; result: AgentMuxControlResult }
  | { requestId: string; ok: false; error: AgentMuxControlError }

export type DesktopControlCancellation = {
  requestId: string
  code: AgentMuxControlErrorCode
  message: string
}

export const CONTROL_REQUEST_CHANNEL = 'agentmux:control-request'
export const CONTROL_CANCEL_CHANNEL = 'agentmux:control-cancel'
export const CONTROL_RESPONSE_CHANNEL = 'control:response'

export type BrowserSnapshot = {
  id: string
  navigationId: string
  profileId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: BrowserViewport
  error: string | null
  /**
   * 这一刻有没有一段 Agent 程序在驱动这个页面。
   *
   * 为什么要出现在快照里、而不是只留在 Main：页面内角标（`buildBrowserDriveBadgeScript`）只在人
   * **看着那一页**时成立，而人恰恰常在别处干活。应用 chrome 上要认得出是哪一格，渲染进程就必须
   * 知道这件事。走这个既有快照而不是新开一条事件通路：驱动的开始与结束本来就各有一次 `emit`，
   * 新增一条通路只会让两份驱动真相有机会不一致。
   *
   * **瞬时事实，不进持久化**。`persistedSurfaceSurvives` 对 browser 面整面剥离，这一位不为自己开
   * 口子：冷启动复活一个「正在被驱动」的死标记，比不画更糟——它指的那段程序早就不在了。
   */
  driving: boolean
  /**
   * 这一页正等着用户回答「要不要把这个应用链接交给系统」。`null` 表示没有待答的。
   *
   * 走这份已经在流的快照，而不是新开一条 main→renderer 的提示通道：主进程今天**没有**任何能让
   * 渲染进程弹确认框的通路（`BrowserEvent` 只有 `updated` / `closed` 两种），新开一条意味着第二套
   * 「谁在等用户回答」的生命周期，而切 Tab、多 Region、窗口重建这些问题快照这条已经解决过一遍了。
   *
   * 和 `driving` 一样是**瞬时事实，不进持久化**：冷启动复活一个待答的提问，问的是一个早就不在的
   * 页面上的一次点击。
   */
  appLinkPrompt: { url: string; scheme: string } | null
  /** Latest bounded Browser operation projection; transient while the native page is live. */
  activity?: BrowserActivityState
}

export type BrowserProfileImportedSource = {
  browserLabel: string
  profileLabel: string
  importedAt: number
  importedCookies: number
  skippedCookies: number
}

export type BrowserProfileSummary = {
  id: string
  label: string
  createdAt: number
  isDefault: boolean
  source: BrowserProfileImportedSource | null
}

export type BrowserProfileImportSourceSummary = {
  token: string
  browserLabel: string
  profileLabel: string
}

export const BROWSER_VIEWPORT_PRESETS = {
  responsive: null,
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
} as const

export type BrowserViewport = keyof typeof BROWSER_VIEWPORT_PRESETS

export const BROWSER_PNG_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const BROWSER_PNG_MAX_BYTES = 18 * 1024 * 1024
export const BROWSER_PNG_MAX_PIXELS = 32 * 1024 * 1024
export const BROWSER_PNG_MAX_DIMENSION = 16_384

export type BrowserPng = {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

// A pasted (or captured) image is written to `<home>/.agentmux/pasted/…` and cited in the message text
// as a path the Agent reads for itself. This is the ONE list of formats that round-trips: the paste
// write clamps an unknown clip format to `png`, and the read IPC refuses any path whose extension is not
// here. Both sides import THIS tuple — a second hand-copied whitelist is exactly the drift that makes
// "the write accepted it but the read shows a broken image" appear in only half the cases. Values are
// lowercase, no leading dot.
export const PASTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export type PastedImageExtension = (typeof PASTED_IMAGE_EXTENSIONS)[number]

/** The `<img>`-ready mime for each accepted extension. `jpg` and `jpeg` share one. */
export const PASTED_IMAGE_MIME_TYPES: Record<PastedImageExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** A pasted screenshot is large but bounded; anything past this is a mistake, not a screenshot. The
 *  read cap equals the write cap so nothing the paste accepts is later unreadable. */
export const PASTED_IMAGE_MAX_BYTES = 16 * 1024 * 1024

/**
 * A pasted image read back from disk as an `<img>`-ready data URI. The only consumer (`ConversationImage`)
 * drops the `dataUrl` straight into an `<img src>`; no width/height (unlike a browser screenshot these are
 * not decoded in main, and the thumbnail sizes itself with CSS).
 */
export type PastedImage = {
  dataUrl: string
}

export type BrowserScreenshotCapture = {
  browserId: string
  navigationId: string
  image: BrowserPng
}

/**
 * 一段 Agent 程序跑完之后，Main 交回 Renderer 的东西。
 *
 * 形状**刻意与 Control 回执（core 的 browser.run result）一致**：Renderer 那一层不做翻译，只是把它
 * 原样交出去。两侧各定义一次自己的形状、中间做一次映射的话，映射漏一个字段是静默的——四类结局里
 * 少接住一类，会表现为"某些失败被报成了成功"。
 */
export type BrowserScriptRunReport = {
  /** 程序 return 的值。它 return 什么就是什么，我们不规定形状。 */
  result: unknown
  /** 程序 console 出来的每一行，**失败时照样有**——炸掉之前打的那几行往往正是要看的。 */
  logs: string[]
  outcome: AgentMuxControlBrowserRunOutcome
  runOperation: AgentMuxControlBrowserOperation
}

export type BrowserElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserElementSelection = {
  browserId: string
  navigationId: string
  pageTitle: string
  pageUrl: string
  tagName: string
  role: string
  accessibleName: string
  selector: string
  text: string
  nearbyText: string[]
  attributes: Record<string, string>
  html: string
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserAnnotationMarker = {
  id: string
  index: number
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

/**
 * 页面语义快照里的一个节点。
 *
 * `ref` 是本次快照发给 Agent 的**指名句柄**——Agent 后续要操作哪个元素，只说 ref，不说坐标。
 * 这是「结构化 ref 寻址 ≠ 键鼠模拟」那条线在类型上的落点：ref 由我方快照发出，解不开就是解不开，
 * 不存在"点空了但返回成功"这种结局。
 *
 * `backendNodeId` 是 ref 的身份键，把 ref 解回真实 DOM 节点全靠它。**没有它的节点不进快照**：
 * 一个解不开的 ref 发给 Agent，等于让它拿着一个永远失败的把手。
 */
export type BrowserPageNode = {
  /** 本次快照内唯一的指名句柄，形如 `@e1`。跨快照不保证稳定——导航或重建后要重新取快照。 */
  ref: string
  /** 可读角色名。交互元素做了展示归一（如 textbox → text input）。 */
  role: string
  /** 可访问名称。交互节点没有名称时为 `(unlabeled)`，不是空串——空串会让 Agent 以为字段缺失。 */
  name: string
  /** 解析用的身份键，来自 CDP。 */
  backendNodeId: number
  /** 结构缩进层级，仅用于把树渲染成文本给 Agent 看。 */
  depth: number
  /** 该节点所属 frame 的 CDP session；主 frame 为 undefined。派发动作时命令要发到这个 session。 */
  sessionId?: string
}

/**
 * 一次页面快照的完整结局。
 *
 * `missingFrames` 是这个类型存在的主要理由：跨域 iframe 取不到时**不静默跳过**。取不到就在这里
 * 列出来——缺了哪个 frame、为什么缺。快照本身照常返回（不阻断），但 Agent 能看见自己拿到的是
 * 一张有洞的地图，而不是误以为页面上就只有这些元素。
 */
export type BrowserPageSnapshot = {
  url: string
  title: string
  /** 取快照时的导航身份。与之不符的 ref 一律作废——页面已经换了。 */
  navigationId: string
  nodes: BrowserPageNode[]
  missingFrames: BrowserPageFrameFailure[]
}

/** 一个没能取到的 frame。`reason` 是原始错误文本，不做归类——归类会把没见过的原因吃掉。 */
export type BrowserPageFrameFailure = {
  frameId: string
  reason: string
}

export type BrowserEvent =
  | { type: 'updated'; browser: BrowserSnapshot }
  | { type: 'closed'; id: string }

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export const WINDOW_RESIZE_EVENT_CHANNEL = 'agentmux:window-resize'
/** Main -> renderer: the user clicked a notification about this Agent Session. */
export const AGENT_ATTENTION_ACTIVATE_CHANNEL = 'agentmux:agent-attention-activate'

// The four push channels below used to be hand-written string literals at BOTH ends — the sender in
// main and the `ipcRenderer.on` in preload each spelled the name out. That is not symmetric with the
// request/response channels above, and it is a silent failure mode: `webContents.send` and
// `ipcRenderer.on` both take `channel: string`, so misspelling one side compiles clean, registers a
// listener nobody ever fires, and the feature simply goes dead with no error anywhere. The
// invoke/handle surface cannot drift this way because ipc-parity.test.ts compares the two sets — but
// that extractor only reads `handle(...)`/`invoke(...)` call nodes, so `.send`/`.on` were entirely
// outside its view. Naming each channel once here makes a rename a compile error at every use site.
/** Main -> renderer: one runtime/session event from the Agent runtime controller. */
export const SESSION_EVENT_CHANNEL = 'agentmux:session-event'
/** Main -> renderer: one embedded-browser lifecycle/navigation event. */
export const BROWSER_EVENT_CHANNEL = 'agentmux:browser-event'
/** Main -> renderer: a periodic CPU/RSS sample for the resource panel. */
export const RESOURCE_USAGE_CHANNEL = 'agentmux:resource-usage'
/** Main -> renderer: a watched workspace file changed on disk; re-read it. */
export const WORKSPACE_FILE_INVALIDATED_CHANNEL = 'agentmux:workspace-file-invalidated'

export type WindowResizeEvent = {
  active: boolean
}

export type AgentMuxDesktopApi = {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
  }
  hosts: {
    check(host: HostConfig): Promise<HostCheckResult>
  }
  workspaces: {
    appearance(id: string): Promise<{ kind: 'repository' | 'directory'; icon: string | null }>
    chooseLocalFolder(): Promise<WorkspaceRecord | null>
    /** Pick a replacement directory while preserving the existing Workspace identity. */
    rebindLocalFolder(workspaceId: string): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    listBranches(workspaceId: string): Promise<WorkspaceBranchesSnapshot>
    openBranch(workspaceId: string, branch: string): Promise<WorkspaceSelectionResult>
    createWorktreeForBranch(input: CreateWorktreeForBranchInput): Promise<WorkspaceSelectionResult>
    removeWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome>
    /**
     * What this worktree's branch would keep if the checkout went away. Asked BEFORE the confirm dialog
     * opens — a warning that arrives after the button is reachable protects nobody.
     *
     * Never rejects: failing to answer a question about a removal must not block the removal. The
     * unanswerable case is a real answer here, and it says so in words.
     */
    worktreeRemovalNotice(workspaceId: string): Promise<WorktreeRemovalNotice>
    runFanOut(input: RunFanOutInput): Promise<RunFanOutResult>
    keepOneOfFanOut(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome>
  }
  files: {
    readDirectory(workspaceId: string, path: string): Promise<WorkspaceDirectoryEntry[]>
    read(workspaceId: string, path: string): Promise<WorkspaceFileReadResult>
    /**
     * 读一份书签文件（`.webloc`/`.url`），一次拿齐 `openFile` 要的两件事：`url`（拿去导航，取不出＝
     * `null`，调用方退回把文件当文本打开）和 `binary`（这份文件本身是不是二进制）。书签读走这条而不是
     * `read`：二进制 `.webloc` 过 `read` 的 `toString('utf8')` 会被破坏，且取 URL 要 main 侧的 `plutil`。
     * `binary` 供「查看源码」判断——二进制那一档不给（§2.7），判据是字节里有没有 NUL。非书签路径返回 `null`。
     */
    readBookmark(workspaceId: string, path: string): Promise<{ url: string | null; binary: boolean } | null>
    write(workspaceId: string, input: WorkspaceFileWriteInput): Promise<WorkspaceFileWriteResult>
    observe(workspaceId: string, path: string): Promise<void>
    unobserve(workspaceId: string, path: string): Promise<void>
    onInvalidated(listener: (event: WorkspaceFileInvalidated) => void): () => void
    create(workspaceId: string, input: CreateWorkspacePathInput): Promise<void>
    move(input: MoveWorkspacePathInput): Promise<WorkspacePathMoveResult>
    delete(workspaceId: string, path: string): Promise<void>
    reveal(workspaceId: string, path: string): Promise<void>
  }
  scratch: {
    listTopics(workspaceId: string): Promise<ScratchTopicSnapshot[]>
    readTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot | null>
    ensureTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot>
    renameTitle(workspaceId: string, topicId: string, title: string): Promise<ScratchTopicSnapshot>
  }
  ui: {
    rendererUpdateReady(token: string): Promise<void>
    captureScreenshot(): Promise<string | null>
    listAgentSkills(sessionId: string): Promise<import('@agentmux/core').AgentSkill[]>
    listWorkspaceSkills(workspaceId: string, providerId: string): Promise<import('@agentmux/core').AgentSkill[]>
    readClipboardText(): Promise<string>
    writeClipboardText(text: string): Promise<void>
    writeClipboardImage(image: BrowserPng): Promise<void>
    openExternal(url: string): Promise<void>
    /** Native file picker. Returns absolute paths, or null when dismissed. */
    chooseFiles(input?: { defaultPath?: string }): Promise<string[] | null>
    /** Persists pasted image bytes and returns the path an Agent can read them from. */
    savePastedImage(input: { bytes: Uint8Array; extension: string }): Promise<string>
    /**
     * Read one pasted/captured image back as an `<img>`-ready data URI.
     *
     * The trust boundary is the pasted directory, NOT a workspace root: these files live outside every
     * workspace, so this cannot route through `files.read` (which is hard-locked inside a workspace and
     * returns a utf8 string that would corrupt image bytes). Main confines the read to
     * `<home>/.agentmux/pasted` and rejects anything that escapes it, a non-image extension, or an
     * oversized file. Returns null when the path is not a readable pasted image so the caller can fall
     * back to the plain text reference rather than render a broken thumbnail.
     */
    readPastedImage(path: string): Promise<PastedImage | null>
    /**
     * Reveal the local crash-evidence file in the OS file manager, or report that nothing has been
     * written yet.
     *
     * The log is append-only NDJSON in userData and has never had a reader — evidence the app collects
     * about its own failures was, until this, visible only to someone who knew the path. `false` means
     * the file does not exist, which is the good case (no crashes recorded), and the caller must say so
     * rather than silently doing nothing. Reveal rather than an in-app viewer on purpose: the file is a
     * support artifact people attach to a report, and the OS file manager is where attaching happens.
     */
    revealCrashLog(): Promise<boolean>
    /**
     * Ask Desktop main to raise a native notification about one Agent Session.
     *
     * The renderer decides WHETHER a state change deserves a person's attention and passes the chosen
     * dwell `mode`; main only delivers, because only main can reach the OS. The result distinguishes
     * `shown` from `unsupported`, and within `shown` reports whether the requested mode was honoured
     * or the platform downgraded it — so a caller never assumes a persistent banner it did not get.
     */
    notifyAgentAttention(input: AgentAttentionNotifyInput): Promise<NotificationDelivery>
    /**
     * Fires when the user clicks one of those notifications, carrying the Session id it was about.
     * Main focuses the window; WHERE to go inside it stays with the renderer, which owns View/Region.
     */
    onAgentAttentionActivate(listener: (sessionId: string) => void): () => void
    getZoomFactor(): number
    onWindowResize(listener: (event: WindowResizeEvent) => void): () => void
  }
  providers: {
    list(): Promise<AgentCatalogEntry[]>
  }
  executors: {
    detect(executorId: AgentExecutorId, hostId: string): Promise<ExecutorDetection>
  }
  control: {
    onRequest(listener: (
      request: AgentMuxControlRequest,
      signal: AbortSignal
    ) => AgentMuxControlResult | Promise<AgentMuxControlResult>): () => void
  }
  sessions: {
    snapshot(): Promise<RuntimeSnapshot>
    launchAgent(input: AgentLaunchInput): Promise<AgentLaunchResult>
    launchTerminal(input: TerminalLaunchInput): Promise<SessionSnapshot>
    timeline(session: AgentSessionControl): Promise<AgentTimelineSnapshot>
    attach(session: SessionControl, afterByte?: number): Promise<SessionAttachResult>
    detach(attachmentId: string): Promise<void>
    write(session: SessionControl, data: AgentMuxRunInputData): Promise<void>
    // `operationId` is the caller's correlation key for ONE submission attempt. A retry of the same
    // prompt passes the SAME id so Core recognizes the replay (idempotent same-id continuation) instead
    // of gating it BUSY; a genuinely new prompt passes a fresh id. Omitting it lets the main process mint
    // a fresh one — used only by test callers, never by the UI, which always decides the id itself.
    submitPrompt(session: AgentSessionControl, prompt: string, operationId?: string, authorAgentSessionId?: string): Promise<void>
    respondInteraction(
      session: AgentSessionControl,
      response: AgentMuxInteractionResponse
    ): Promise<void>
    // Set the Agent's live security posture in-band. The renderer sends the picked mode id; Core resolves
    // the Provider's declared keystroke and writes it over the PTY-input transport (bytes never cross IPC).
    setPosture(session: AgentSessionControl, modeId: string): Promise<void>
    resume(session: AgentSessionControl, prompt: string, operationId: string): Promise<SessionSnapshot>
    acknowledge(session: SessionControl, throughByte: number): Promise<void>
    interrupt(session: SessionControl): Promise<void>
    resize(
      attachmentId: string,
      cols: number,
      rows: number
    ): Promise<{ cols: number; rows: number } | null>
    refresh(session: SessionControl): Promise<SessionSnapshot>
    // Recover a session whose PTY was lost (daemon_restart / tmux_* interruption, or exit).
    // The physical PTY cannot be revived, so this mints a *fresh* Run in the same cwd:
    // terminals relaunch the host shell; agents resume via provider-native resume. If the
    // Transport loss remains an error and never authorizes resume.
    // Returns the Core continuity disposition; the renderer rebinds only an attached/resumed
    // Agent or a newly restarted raw Terminal.
    recover(session: SessionControl, workspacePath?: string): Promise<SessionRecoveryResult>
    stop(session: SessionControl): Promise<void>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  /**
   * 进程资源用量。**只在有人订阅时才采样**——折叠态一次 `ps` 都不发生。
   *
   * 做成订阅而不是"查一次"，是因为零开销这件事必须由生命周期本身保证：给一个查询接口，
   * 调用方一开定时器就又回到了常驻轮询，而那不会让任何测试变红。
   */
  resourceUsage: {
    /** 开始采样并接收快照，返回退订函数；最后一个订阅者离开时采样停止。 */
    subscribe(listener: (snapshot: UsageSnapshot) => void): () => void
  }
  browser: {
    create(id: string, url: string): Promise<BrowserSnapshot>
    navigate(id: string, url: string): Promise<BrowserSnapshot>
    back(id: string): Promise<BrowserSnapshot>
    forward(id: string): Promise<BrowserSnapshot>
    reload(id: string): Promise<BrowserSnapshot>
    switchProfile(id: string, profileId: string): Promise<BrowserSnapshot>
    listProfiles(): Promise<BrowserProfileSummary[]>
    createProfile(label: string): Promise<BrowserProfileSummary>
    deleteProfile(profileId: string): Promise<void>
    detectProfileImportSources(): Promise<BrowserProfileImportSourceSummary[]>
    importProfile(sourceToken: string, label: string): Promise<BrowserProfileSummary>
    openDevTools(id: string): Promise<void>
    setViewport(id: string, viewport: BrowserViewport): Promise<BrowserSnapshot>
    captureScreenshot(id: string): Promise<BrowserScreenshotCapture>
    /**
     * 在这个 Browser 上跑一段 Agent 写的程序，返回它的结局。
     *
     * 程序在**独立子进程**里跑（browser-script-runner.ts），不在 Main、也不在页面里：它是 Agent 现写的
     * 代码，可以 throw、死循环、把堆吃光，这三件事都不许波及 AgentMux 主进程。
     *
     * 这是 Main 侧唯一对外暴露的驱动入口——页面能力（snapshot/click/...）是注入给那段程序的内部函数库，
     * 不在这个契约上，所以改它们不动这里。
     */
    runScript(id: string, code: string, operator?: BrowserOperator): Promise<BrowserScriptRunReport>
    listOperationHistory(): Promise<BrowserOperation[]>
    replayPlan(operationId: string): Promise<BrowserReplayPlan | null>
    runReplay(id: string, plan: BrowserReplayPlan, operator?: BrowserOperator): Promise<BrowserScriptRunReport>
    returnControl(id: string): Promise<BrowserSnapshot>
    stopOperation(id: string): Promise<BrowserSnapshot>
    selectElement(id: string): Promise<BrowserElementSelection | null>
    /**
     * 回答这一页上待答的那个应用链接提问。`remember` 为真时把这个答案按 scheme 记进
     * `BrowserConfig.appLinkSchemes`，此后同 scheme 不再问。
     *
     * 只收一个 id 而不收 url：待答的那一次就挂在这个 entry 上（`BrowserSnapshot.appLinkPrompt`），
     * 让渲染进程回传 url 等于开了第二个事实源——页面可以在人回答之前又发起一次，两边就对不上了。
     */
    answerAppLink(id: string, allow: boolean, remember: boolean): Promise<BrowserSnapshot>
    cancelElementSelection(id: string): Promise<void>
    setAnnotationMarkers(id: string, navigationId: string, markers: BrowserAnnotationMarker[]): Promise<void>
    setBounds(id: string, bounds: BrowserBounds | null): Promise<void>
    /** Release only the Main-owned native page surface; the Renderer Region remains present. */
    release(id: string): Promise<void>
    /** Rebuild a previously released native page from the retained Region projection. */
    restore(id: string, input: {
      profileId: string
      viewport: BrowserViewport
    }): Promise<BrowserSnapshot>
    close(id: string): Promise<void>
    onEvent(listener: (event: BrowserEvent) => void): () => void
  }
}

export type AgentMuxPreloadApi = Omit<AgentMuxDesktopApi, 'control'> & {
  control: {
    onRequest(listener: (request: AgentMuxControlRequest) => void): () => void
    onCancellation(listener: (cancellation: DesktopControlCancellation) => void): () => void
    respond(response: DesktopControlResponse): void
  }
  /**
   * Local Git source control. Lives on the preload API only, not the shared `AgentMuxDesktopApi`,
   * because it is a Desktop-main capability with no meaningful web-preview mock — the renderer reaches
   * it through `window.agentmux.git`, never through the shared mock `api`.
   *
   * **This surface speaks two path coordinate systems, and the parameter names say which.** They differ
   * whenever a workspace is a subfolder of its repository, and confusing them is silent — both are
   * well-formed relative paths, so a mix-up reads a same-named file somewhere else in the repo instead
   * of erroring:
   *   - `repoPath` — repo-root-relative, porcelain's own coordinate. `status` reports these
   *     ({@link GitFileChange.path}), and the write verbs hand the same value straight back to a
   *     pathspec. Everything porcelain names is reachable, including files outside the workspace.
   *   - `workspacePath` — workspace-relative, the coordinate everything the user points at uses: the
   *     file tree's nodes, `files.read`, `openFile`, the document key, the editor tab identity.
   *
   * `diff` is the one method on the workspace side of that line, because a diff is an *editor* surface:
   * its path is the open document's path. A caller holding porcelain output must therefore convert
   * before calling it — `workspaceRelativeGitPath` in the renderer does that, and returns null for the
   * changes a subfolder workspace cannot show at all.
   */
  git: {
    status(workspaceId: string): Promise<GitStatusResult>
    stage(workspaceId: string, repoPath: string): Promise<void>
    commit(workspaceId: string, message: string): Promise<void>
    diff(workspaceId: string, workspacePath: string): Promise<GitFileDiff>
    unstage(workspaceId: string, repoPath: string): Promise<void>
    discard(workspaceId: string, repoPath: string, untracked: boolean): Promise<void>
    push(workspaceId: string, options?: GitPushOptions): Promise<GitRemoteResult>
    pull(workspaceId: string, options?: { strategy?: GitPullStrategy }): Promise<GitRemoteResult>
    fetch(workspaceId: string, options?: GitRemoteOptions): Promise<GitRemoteResult>
    aheadBehind(workspaceId: string): Promise<GitAheadBehind>
  }
  /**
   * GitHub CLI capability probing. Like `git`, a Desktop-main capability with no web-preview mock —
   * the renderer reaches it through `window.agentmux.gh`. Only *probes* `gh auth status`; it never
   * reads or persists a token, so it adds no credential-storage surface.
   *
   * There is deliberately no `authStatus` leaf here. `GhService.authStatus` still exists and runs — but
   * only *inside* main, as the first step of `prReadiness` — because the auth answer must be read
   * together with the branch facts, not on its own (see {@link PrReadiness}). Exposing it separately
   * re-opened the drift that type explicitly closes: a renderer could read auth, then read the branch,
   * and act on a pair that was never simultaneously true. Ask `prReadiness`; `auth` is one of its fields.
   */
  gh: {
    prReadiness(workspaceId: string): Promise<PrReadiness>
    createPullRequest(workspaceId: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>
  }
}
