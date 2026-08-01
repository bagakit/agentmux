import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, normalize as normalizeLocalPath, posix } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { BUILT_IN_AGENT_PROVIDERS, durableWriteFile } from '@agentmux/core'
import type { AppConfig, WorkspaceRecord } from '../shared/contracts.js'
import { CONFIG_VERSION, SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME } from '../shared/contracts.js'
import { DEFAULT_NOTIFICATION_MODE_ID, NOTIFICATION_TIERS } from '../shared/notification-presentation.js'

const hostSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.literal('local'), kind: z.literal('local'), label: z.string().min(1) }).strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('ssh'),
      label: z.string().min(1),
      hostname: z.string().min(1),
      user: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      identityFile: z.string().min(1).optional()
    })
    .strict()
])

const providerIds = new Set(BUILT_IN_AGENT_PROVIDERS.map((provider) => provider.id))
const executorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)

const executorSchema = z
  .object({
    label: z.string().min(1),
    providerId: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    injectAgentMuxGuide: z.boolean()
  })
  .strict()

const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    hostId: z.string().min(1),
    path: z.string().min(1),
    kind: z.enum(['folder', 'worktree']),
    repoPath: z.string().min(1).optional(),
    branch: z.string().min(1).optional()
  })
  .strict()

const notificationModeIds = NOTIFICATION_TIERS.map((tier) => tier.id) as [string, ...string[]]

// Named rather than inlined below because the retirement path validates each of these on its own, to
// carry a still-valid user preference across a version bump. Two definitions of the same shape would
// drift, and the drift would be silent: the config would parse while the carry-over dropped the field.
const appearanceSchema = z.object({ terminalTheme: z.enum(['graphite', 'catppuccin-mocha']) }).strict()
const browserSchema = z.object({
  toolbar: z.object({
    selectElement: z.boolean(),
    screenshot: z.boolean(),
    devTools: z.boolean(),
    viewport: z.boolean(),
    more: z.boolean()
  }).strict()
}).strict()
const notificationsSchema = z.object({ mode: z.enum(notificationModeIds) }).strict()

const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    hosts: z.array(hostSchema),
    executors: z.record(executorIdSchema, executorSchema),
    workspaces: z.array(workspaceSchema),
    appearance: appearanceSchema,
    browser: browserSchema,
    // Optional: a config written before this field existed is still valid, and `get()` back-fills the
    // explicit default. The mode is validated against the one tier table so an unknown id is rejected
    // rather than silently meaning "off".
    notifications: notificationsSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const hostIds = new Set(config.hosts.map((host) => host.id))
    const hostsById = new Map(config.hosts.map((host) => [host.id, host]))
    if (hostIds.size !== config.hosts.length) {
      context.addIssue({ code: 'custom', path: ['hosts'], message: 'Host ids must be unique' })
    }
    if (!hostIds.has('local')) {
      context.addIssue({ code: 'custom', path: ['hosts'], message: 'Local host is required' })
    }
    for (const [executorId, executor] of Object.entries(config.executors)) {
      if (!providerIds.has(executor.providerId)) {
        context.addIssue({
          code: 'custom',
          path: ['executors', executorId, 'providerId'],
          message: `Unknown Agent Provider: ${executor.providerId}`
        })
      }
    }
    const workspaceIds = new Set<string>()
    const workspaceLocations = new Set<string>()
    for (const [index, workspace] of config.workspaces.entries()) {
      if (workspaceIds.has(workspace.id)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'id'],
          message: `Workspace id must be unique: ${workspace.id}`
        })
      }
      workspaceIds.add(workspace.id)
      if (!hostIds.has(workspace.hostId)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'hostId'],
          message: `Unknown workspace host: ${workspace.hostId}`
        })
        continue
      }
      const host = hostsById.get(workspace.hostId)!
      const normalizedPath = host.kind === 'local'
        ? normalizeLocalPath(join(workspace.path, '.'))
        : posix.normalize(posix.join(workspace.path, '.'))
      const location = `${workspace.hostId}\0${normalizedPath}`
      if (workspaceLocations.has(location)) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'path'],
          message: `Workspace path must be unique on ${workspace.hostId}: ${normalizedPath}`
        })
      }
      workspaceLocations.add(location)
    }
  })

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true },
    claude: { label: 'Claude', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true },
    traex: { label: 'TraeX', providerId: 'traex', command: 'traex', args: [], env: {}, injectAgentMuxGuide: true },
    hermes: { label: 'Hermes', providerId: 'hermes', command: 'hermes', args: [], env: {}, injectAgentMuxGuide: true },
    pi: { label: 'Pi', providerId: 'pi', command: 'pi', args: [], env: {}, injectAgentMuxGuide: true },
    grok: {
      label: 'Grok',
      providerId: 'grok',
      command: 'grok',
      args: ['--permission-mode', 'bypassPermissions'],
      env: {},
      injectAgentMuxGuide: true
    },
    gemini: { label: 'Gemini', providerId: 'gemini', command: 'gemini', args: [], env: {}, injectAgentMuxGuide: true },
    antigravity: { label: 'Antigravity', providerId: 'antigravity', command: 'agy', args: [], env: {}, injectAgentMuxGuide: true },
    cursor: { label: 'Cursor', providerId: 'cursor', command: 'cursor-agent', args: [], env: {}, injectAgentMuxGuide: true },
    // kimi / droid / copilot：Core 已把它们列为一等 built-in Provider（types.ts 的 BuiltInAgentProviderId、
    // agent-provider.ts 的 BUILT_IN_AGENT_PROVIDERS），但此前的默认表漏了它们，于是新建 Tab 界面（经
    // config.executors → configuredExecutors）根本不显示这三家。command/label 逐个取自各自 catalog 的
    // executable/label（SSOT，见 providers/{kimi,droid,copilot}.ts），三家都不需要特殊 args——它们的
    // buildArgs 只原样透传 args（grok 那两个参数写在下面的默认 args 里，同样是透传，不是 buildArgs 注入）。
    //
    // 补这三家**必须连带 version 从 7 到 8**，否则修复只对全新安装生效：v7 的磁盘配置会走下面的
    // `configSchema.parse` 原样返回，而 `executors` 是无数量约束的 record，于是「只有 9 家」完全合法、
    // 一路通过校验，界面上照旧缺这三家。08-24 到 09-01 之间跑过 v7 构建的用户就落在这个窗口里。
    //
    // 不用「遍历内置 Provider，缺谁补谁」的回填，有两个不可调和的理由：
    //   1. 那是 fallback——一段长期驻留在 `get()` 里、专门伺候一类历史磁盘状态的代码。本仓对配置演进的
    //      既定答案是版本号 +1 然后重置（见测试 `resets retired config to current default without
    //      migration or fallback`），不是往读取路径上叠补丁。
    //   2. 它分不清两种缺席。「配置写在这三家存在之前」与「用户自己删掉了 kimi」在磁盘上长得一模一样，
    //      磁盘里没有任何信息能区分，于是回填会把用户删掉的项每次启动塞回来。这不是判据不够聪明，是
    //      信息不存在。
    kimi: { label: 'Kimi', providerId: 'kimi', command: 'kimi', args: [], env: {}, injectAgentMuxGuide: true },
    droid: { label: 'Droid', providerId: 'droid', command: 'droid', args: [], env: {}, injectAgentMuxGuide: true },
    copilot: { label: 'Copilot', providerId: 'copilot', command: 'copilot', args: [], env: {}, injectAgentMuxGuide: true },
    opencode: { label: 'OpenCode', providerId: 'opencode', command: 'opencode', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: {
    toolbar: {
      selectElement: true,
      screenshot: true,
      devTools: true,
      viewport: true,
      more: true
    }
  },
  notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID }
}

/**
 * Dedicated on-disk directory that backs the "no project" scratch workspace. A hidden
 * subdirectory of home keeps it out of the way (vs. exposing the whole home to the file
 * explorer) while giving terminals/agents a real, stable cwd.
 */
const SCRATCH_BACKING_PATH = join(app.getPath('home'), '.agentmux', 'scratch')

function normalizedLocalPath(path: string): string {
  return normalizeLocalPath(join(path, '.'))
}

function scratchWorkspace(): WorkspaceRecord {
  return {
    id: SCRATCH_WORKSPACE_ID,
    name: SCRATCH_WORKSPACE_NAME,
    hostId: 'local',
    path: SCRATCH_BACKING_PATH,
    kind: 'folder'
  }
}

/**
 * Ensure the always-present scratch workspace is in the config. Guarded by both the
 * reserved id and the backing path so we never violate the unique-id / unique-path
 * refinements (e.g. if a user manually registered the same folder).
 */
function withScratchWorkspace(config: AppConfig): { config: AppConfig; added: boolean } {
  const scratchLocation = normalizedLocalPath(SCRATCH_BACKING_PATH)
  const present = config.workspaces.some(
    (workspace) =>
      workspace.id === SCRATCH_WORKSPACE_ID ||
      (workspace.hostId === 'local' && normalizedLocalPath(workspace.path) === scratchLocation)
  )
  if (present) return { config, added: false }
  return {
    config: { ...config, workspaces: [...config.workspaces, scratchWorkspace()] },
    added: true
  }
}

/**
 * Back-fill the notification default for a config written before the field existed. Same pattern as the
 * scratch-workspace back-fill: fill an absent optional in `get()` and persist once, so every later read
 * sees a concrete default rather than `undefined` reaching the notifier. Present but unknown ids are
 * left for the schema to reject.
 */
function withNotificationDefault(config: AppConfig): { config: AppConfig; added: boolean } {
  if (config.notifications) return { config, added: false }
  return {
    config: { ...config, notifications: { mode: DEFAULT_NOTIFICATION_MODE_ID } },
    added: true
  }
}

/**
 * A retired config's **carry-forward** half: everything whose presence on disk is unambiguous, which
 * no default table can reconstruct.
 *
 * This split is the whole point. A version bump used to `rm` the file and load `DEFAULT_CONFIG`,
 * whose `workspaces: []`, so **every project the user had registered was discarded** — twice in
 * production (7→8 and 8→9), because the reset fires on *any* older version, not on one specific
 * bump. Refreshing the stale half never required destroying the authored half; the two just
 * happened to share one file and one version gate.
 *
 * The dividing line is **not** "authored vs. derived" — that framing cost this function a second
 * round of the same bug. Every field here is authored: the user picks a theme, toggles a toolbar
 * button, creates an Executor. The line is whether **a record's absence from the current defaults
 * is ambiguous**:
 *
 *   - **Unambiguous, so carried.** `workspaces` and `hosts` carry a unique id and a unique path.
 *     A custom Executor id is minted as `<providerId>` or `<providerId>-N` (see the settings pane),
 *     so an id that is not a current built-in default cannot be a Provider the user deleted — it is
 *     one they created. Same for the three preference objects: they are single values that are
 *     always present, never a set whose members can go missing.
 *   - **Ambiguous, so reset.** An Executor keyed by a *built-in default id* is the one genuinely
 *     undecidable case, and it is the case the old comment was written about: "this config predates
 *     the Provider" and "the user deleted this Provider" look identical on disk, so carrying it
 *     forward would resurrect deletions while resetting it restores a Provider the bump exists to
 *     add. Resetting the built-in slice is what makes a bump able to do its job (v7 held nine
 *     Providers; three more had to appear).
 *
 * `hosts` travels with `workspaces` because every workspace names one (`hostId`), and the schema's
 * refinement rejects a workspace whose host is absent: dropping hosts while keeping workspaces
 * would produce a config that cannot be parsed back.
 *
 * **Salvage is per record, never per file.** Parsing all workspaces as one object would resurrect
 * the very bug being fixed: the next bump that changes the workspace shape (a new required field,
 * a renamed one) makes the whole array fail, and every project vanishes again — silently, because
 * an empty carry-over is indistinguishable from "the user had no projects". Each record is judged
 * on its own, so one damaged entry costs one project instead of all of them. The preference objects
 * are judged the same way, each against its own sub-schema: a damaged `browser` must not cost the
 * user their theme.
 *
 * `found` vs. the returned length is the caller's evidence for the case salvage cannot cover: a
 * shape change that invalidates *every* record. There is no way to carry a record forward that the
 * current schema would reject — `save()` would refuse the result — so that case must be loud
 * rather than quiet. `strandedByDamagedHost` is the same evidence for the *partial* case, and it is
 * reported separately because those workspaces are intact and were dropped for a reason outside
 * themselves: the difference between "we cannot read this project" and "we can read it fine but its
 * host record is unreadable" is what tells the user which one byte to fix. Both are read by
 * `retiredConfigReplacement`.
 */
export function authoredConfigCarryOver(raw: unknown): {
  hosts: AppConfig['hosts']
  workspaces: WorkspaceRecord[]
  executors: AppConfig['executors']
  appearance: AppConfig['appearance'] | undefined
  browser: AppConfig['browser'] | undefined
  notifications: AppConfig['notifications'] | undefined
  found: number
  strandedByDamagedHost: Array<{ hostId: string; workspaceIds: string[] }>
  /**
   * Whether the `hosts` **container** was unreadable — not whether individual entries were.
   *
   * The distinction is the whole point, and getting it wrong made two different existing guards fire
   * on each other's cases. A single damaged host entry is already reported precisely by
   * `strandedByDamagedHost`, which can name the host and its projects. A damaged *container* names
   * nothing: every id vanishes at once, and the local fallback then hides it, because projects on
   * `local` still resolve and this result's `hosts` is non-empty thanks to the restored default. So
   * the container case needs its own signal, and the per-entry case must not raise it.
   */
  hostsUnreadable: boolean
  /**
   * Whether the `executors` container itself was unreadable — not whether individual entries were.
   *
   * A single Executor dropped because its Provider is gone is deliberate per-record salvage (see the
   * Provider-existence filter below), so counting entries would conflate the two. But a container
   * written as an array or a primitive costs the user *every* Executor they built, and the result
   * still looks healthy because the built-in defaults are spread in underneath.
   */
  executorsUnreadable: boolean

  /**
   * How many Executors the user minted, and how many of those the record schema could still read.
   *
   * Two numbers rather than one because the interesting loss is per-record and total: a container
   * that is a healthy record, holding entries that are all objects, every one of which the current
   * `.strict()` schema rejects at once. `executorsUnreadable` cannot see it (the container is fine)
   * and neither can any surviving-count (there are no survivors to compare against a total).
   *
   * Counted *before* the Provider-existence filter, so an Executor dropped because this build
   * retired its Provider stays silent salvage — that loss is forced by the data and is not ours.
   */
  authoredExecutorsFound: number
  authoredExecutorsReadable: number

  /**
   * The same pair for hosts, excluding `local` on both sides: it is in the defaults, so a damaged
   * local record is repaired by the back-fill rather than lost, and counting it would make this
   * fire on a case that loses nothing.
   */
  authoredHostsFound: number
  authoredHostsCarried: number
} {
  // Every key is `z.unknown().optional()`, including the three containers. In zod v4 a bare
  // `z.unknown()` key is **required** — an absent key fails the whole object — and this outer parse
  // failing is exactly the all-or-nothing collapse the per-record salvage below exists to prevent:
  // `rawWorkspaces` would fall back to `[]` and every project would be dropped. Caught by the guard
  // tests when the preference fields were first added here without `.optional()`.
  //
  // The containers are `unknown` rather than `z.array(...)` / `z.record(...)` for the same reason,
  // one step further in: `.optional()` only excuses an **absent** key. Declaring the shape here made
  // a key of the *wrong type* fail the whole outer parse, which collapsed all three containers at
  // once — a `hosts` written as a map, or an `executors` written as an array, silently emptied
  // `workspaces`. Each container is now narrowed on its own below, so one damaged container cannot
  // take the others with it.
  const outer = z
    .object({
      hosts: z.unknown().optional(),
      workspaces: z.unknown().optional(),
      executors: z.unknown().optional(),
      appearance: z.unknown().optional(),
      browser: z.unknown().optional(),
      notifications: z.unknown().optional()
    })
    .safeParse(raw)
  const rawHosts = outer.success && Array.isArray(outer.data.hosts) ? outer.data.hosts : []
  const rawWorkspaces =
    outer.success && Array.isArray(outer.data.workspaces) ? outer.data.workspaces : []
  const rawExecutors =
    outer.success &&
    typeof outer.data.executors === 'object' &&
    outer.data.executors !== null &&
    !Array.isArray(outer.data.executors)
      ? (outer.data.executors as Record<string, unknown>)
      : {}

  // The container was written, and it is not a record. Absent or `null` is not damage — it means the
  // user added none — so those pass; an array or a primitive is a shape nothing can read entries out
  // of, and every custom Executor in it is gone.
  const executorsUnreadable =
    outer.success &&
    outer.data.executors !== undefined &&
    outer.data.executors !== null &&
    (Array.isArray(outer.data.executors) || typeof outer.data.executors !== 'object')

  // Counted off the raw value, never off `rawWorkspaces`. Deriving it from the narrowed array made
  // the loud all-loss guard read `found: 0` in precisely the case it exists for: a `workspaces` the
  // current shape cannot read at all still *holds* the user's projects, and reporting zero let the
  // launch proceed and overwrite them. Measured before the fix: two intact projects on disk, no
  // throw, no warning, and the file rewritten with only the built-in scratch entry left.
  //
  // `evidenceOfWorkspaces` is not a count of projects — nothing can count records inside a shape it
  // cannot read. It answers the only question the guard needs: **did this file hold projects?** For
  // a readable array that is its length; for an unreadable non-empty container it is 1, which is
  // enough to make the guard fire and refuse the launch.
  const evidenceOfWorkspaces = ((): number => {
    if (!outer.success) return 0
    const value = outer.data.workspaces
    if (Array.isArray(value)) return value.length
    if (value === undefined || value === null) return 0
    if (typeof value === 'object') return Object.keys(value).length > 0 ? 1 : 0
    // A primitive where an array belongs: unreadable, but it was written by something. Treat it as
    // evidence rather than as "no projects" — the honest answer is "we cannot tell", and between
    // refusing to launch and overwriting the file, only one of those is recoverable.
    return 1
  })()

  // The `hosts` container was written, and it is not an array. Absent or `null` is not damage — the
  // local back-fill covers a file that authored no hosts — so those pass. Anything else is a shape
  // nothing can read entries out of, and every host in it is gone at once.
  //
  // Deliberately about the container only, never about entries. A single unreadable host entry is
  // already reported precisely by `strandedByDamagedHost`, and an earlier attempt that counted
  // surviving entries instead fired on that case (naming the wrong culprit) and on a config whose one
  // host was a damaged local record (which the back-fill repairs correctly). Both were measured
  // against the existing guard tests.
  const hostsUnreadable =
    outer.success &&
    outer.data.hosts !== undefined &&
    outer.data.hosts !== null &&
    !Array.isArray(outer.data.hosts)

  const hosts = rawHosts
    .map((host) => hostSchema.safeParse(host))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))

  // Entry-level evidence, and deliberately narrower than "how many entries survived". `:391-395`
  // records an attempt that counted survivors and had to be reverted: it fired on a single damaged
  // entry (which `strandedByDamagedHost` already reports, by name) and on a damaged **local** record
  // (which the back-fill repairs correctly, losing nothing). Both are excluded here at the source:
  //
  //   - `local` is not authored content, so it never counts as evidence on either side.
  //   - The count is of *authored* records, and the guard only fires when **none** of them survived.
  //     One bad host among several leaves survivors, so the stranded guard keeps that case.
  //
  // What this catches is the case no existing guard can see: the container is a well-formed array,
  // every entry is an object, and every one of them fails the record schema at once — which is what
  // adding any field to `hostSchema` does to a stored config, because it is `.strict()`.
  const authoredHostsFound = rawHosts.filter(
    (host) => !(typeof host === 'object' && host !== null && (host as { id?: unknown }).id === 'local')
  ).length
  const authoredHostsCarried = hosts.filter((host) => host.id !== 'local').length
  // The local host is not authored content — it is always present in the defaults — so a config
  // whose local entry is damaged still gets one, and its workspaces stay resolvable.
  const withLocal = hosts.some((host) => host.id === 'local')
    ? hosts
    : [...DEFAULT_CONFIG.hosts.filter((host) => host.id === 'local'), ...hosts]
  const hostIds = new Set(withLocal.map((host) => host.id))

  const workspaces = rawWorkspaces
    .map((workspace) => workspaceSchema.safeParse(workspace))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))

  // A workspace whose host did not survive cannot be carried: the schema's host-existence refinement
  // would reject the result and `save()` would refuse to write it. But dropping it quietly is the
  // amplification case, and it is different in kind from a damaged workspace record:
  //
  //   - A workspace record the schema rejects is *unreadable*. We do not know what it was, so there
  //     is nothing to carry and the loss is forced by the data. That stays per-record salvage.
  //   - A workspace stranded by an unresolvable host is **fully intact** — id, name, path all
  //     readable — and is being dropped for a reason outside itself. One damaged host record costs
  //     every project on it, so a single bad byte in one `hosts` entry can silently retire a dozen
  //     projects while the loud all-empty guard stays quiet because one local project survived.
  //
  // Reported rather than filtered in silence; `retiredConfigReplacement` is what refuses to launch.
  const resolvable = workspaces.filter((workspace) => hostIds.has(workspace.hostId))
  const strandedByHost = new Map<string, string[]>()
  for (const workspace of workspaces) {
    if (hostIds.has(workspace.hostId)) continue
    const already = strandedByHost.get(workspace.hostId)
    if (already) already.push(workspace.id)
    else strandedByHost.set(workspace.hostId, [workspace.id])
  }

  // Built-in ids are reset from the catalog; every other id is the user's own creation. Order puts
  // the defaults first so the carried entries are the ones a reader sees as additions.
  //
  // The two reasons an entry is dropped are separated rather than folded into one filter, because
  // only one of them is ambiguous:
  //
  //   - **Provider retired.** The record is intact; this build no longer ships that Provider, and
  //     keeping the entry would fail the schema's Provider-existence refinement so `save()` could
  //     never write the config. Nothing can be done about it and the loss is forced. Silent salvage.
  //   - **Record unreadable.** The record is whatever the user last saved, and the only thing that
  //     changed is what this build's `.strict()` schema demands of it. That is our doing, not theirs,
  //     and it is exactly what adding any field to `executorSchema` does to every stored Executor.
  //
  // An earlier single filter treated both as the same deliberate salvage, and the comment below the
  // guards said so — which left the second class with no signal at all.
  const authoredExecutors = Object.entries(rawExecutors)
    .filter(([executorId]) => !(executorId in DEFAULT_CONFIG.executors))
    .filter(([executorId]) => executorIdSchema.safeParse(executorId).success)
    .map(([executorId, executor]) => [executorId, executorSchema.safeParse(executor)] as const)
  const readableExecutors = authoredExecutors.filter(([, parsed]) => parsed.success)
  const carriedExecutors = Object.fromEntries(
    readableExecutors
      .filter(([, parsed]) => providerIds.has(parsed.data!.providerId))
      .map(([executorId, parsed]) => [executorId, parsed.data!])
  )

  const carried = <T,>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  // The cast crosses one representational gap, not a semantic one: under
  // `exactOptionalPropertyTypes` the contract's optionals are `?: T` while zod infers
  // `?: T | undefined`. Zod omits an absent optional key rather than setting it to `undefined`,
  // so no value here can actually be `undefined`. Same cast the two `configSchema.parse` sites use.
  return {
    hosts: withLocal as AppConfig['hosts'],
    workspaces: resolvable as WorkspaceRecord[],
    executors: { ...DEFAULT_CONFIG.executors, ...carriedExecutors } as AppConfig['executors'],
    appearance: carried(appearanceSchema, outer.success ? outer.data.appearance : undefined),
    browser: carried(browserSchema, outer.success ? outer.data.browser : undefined) as
      AppConfig['browser'] | undefined,
    // A second, different gap: `notificationModeIds` is widened to `[string, ...string[]]` where it
    // is built, so `z.enum` infers `mode: string` rather than the contract's `NotificationModeId`.
    // The values are the tier ids themselves, so the set is right and only the inferred type is
    // loose — the same reason `configSchema.parse` needs its cast at the two sites below.
    notifications: carried(notificationsSchema, outer.success ? outer.data.notifications : undefined) as
      AppConfig['notifications'] | undefined,
    found: evidenceOfWorkspaces,
    hostsUnreadable,
    executorsUnreadable,
    authoredExecutorsFound: authoredExecutors.length,
    authoredExecutorsReadable: readableExecutors.length,
    authoredHostsFound,
    authoredHostsCarried,
    strandedByDamagedHost: [...strandedByHost].map(([hostId, workspaceIds]) => ({ hostId, workspaceIds }))
  }
}

/**
 * The config a retired file becomes: current defaults for the ambiguous half, everything whose
 * presence was unambiguous carried across.
 *
 * Two classes of loss make this throw instead of launching. Both share one criterion — **a project's
 * absence must never be ambiguous** — and one mechanic: `get()` only writes after this returns, so
 * on a throw the retired file is still on disk, intact, and the projects are recoverable. Launching
 * "successfully" with projects missing is what destroys them, because the next `save()` overwrites
 * the only copy. A loud launch failure is recoverable; a quiet one is not.
 *
 *   - **Not one project could be carried.** Every record is unreadable under the current schema.
 *   - **A host record was unreadable, stranding projects that were themselves intact.** This is the
 *     partial case, and covering only the total one is what made the guard silent where it mattered
 *     most: one damaged `hosts` entry drops every project on it, and as long as a single local
 *     project survives, `workspaces.length` is non-zero and the total-loss check never fires.
 *     Measured: a `port: "twenty-two"` in one SSH host silently cost 4 of 5 projects plus the host.
 *   - **Not one authored host, or not one authored Executor, could be carried.** The container is
 *     well-formed and every record in it is rejected at once. Neither the container guards (the
 *     shape is fine) nor the stranding guard (nothing survived to be named, and nothing need sit on
 *     those hosts) can see this, and it is the shape every future `.strict()` field addition takes.
 *
 * The second class is deliberately not softened into "carry the workspace and drop the host": the
 * schema's host-existence refinement would reject that config, so `save()` could never write it.
 * Nothing here can repair a damaged host — only the user can — so the honest move is to say which
 * host and which projects, and leave the file alone.
 */
function retiredConfigReplacement(raw: unknown): AppConfig {
  const carried = authoredConfigCarryOver(raw)
  // Hosts first, because an unreadable `hosts` container is the *cause* of the stranding the next
  // guard would otherwise report: every host id vanishes at once, so every project on a remote host
  // reads as stranded and the message would blame each host individually for one damaged container.
  // The criterion is about the container alone — a single damaged entry belongs to the next guard,
  // which can name it — and the local back-fill is what makes this class need its own signal: it
  // keeps projects on `local` resolvable and puts a default local entry back, so nothing else in the
  // result looks wrong.
  if (carried.hostsUnreadable) {
    throw new Error(
      'Refusing to retire a config whose host list the current schema cannot read: the file on disk ' +
      'is unchanged and still holds it. Every remote host you configured would be replaced by the ' +
      'default local entry.'
    )
  }
  // Stranding is checked before total project loss. Both guards refuse the launch, so ordering does
  // not change whether the projects survive — it changes what the user is told to do, and only one
  // of the two messages is actionable. `carried.workspaces` is already host-filtered, so when every
  // project sits on one damaged host both conditions hold at once: reporting "no record the schema
  // accepts" there would name the wrong culprit and point the user at their intact project records,
  // when the repair is one byte in one `hosts` entry. Naming the specific loss class beats naming
  // the general one whenever both are true.
  if (carried.strandedByDamagedHost.length > 0) {
    const detail = carried.strandedByDamagedHost
      .map(({ hostId, workspaceIds }) => `${hostId} (${workspaceIds.join(', ')})`)
      .join('; ')
    const stranded = carried.strandedByDamagedHost.reduce(
      (total, entry) => total + entry.workspaceIds.length,
      0
    )
    throw new Error(
      `Refusing to retire a config that would drop ${stranded} intact project(s) whose host record ` +
      `the current schema cannot read: ${detail}. The file on disk is unchanged and still holds ` +
      'them; fix or remove that host entry to keep the projects.'
    )
  }
  if (carried.found > 0 && carried.workspaces.length === 0) {
    throw new Error(
      `Refusing to retire a config holding ${carried.found} project(s) that none of the current ` +
      'schema accepts: the file on disk is unchanged and still holds them.'
    )
  }
  // Hosts, per-record. Ordered after `strandedByDamagedHost` on purpose: that guard fires whenever
  // *some* host survived and can name which one broke and which projects it cost, which is the
  // actionable message. This one is for the case it cannot see — **every** authored host record
  // rejected at once, with no project on any of them, so nothing is stranded, the container is a
  // well-formed array, and the local back-fill puts a healthy-looking `hosts` back. All three
  // existing guards stay silent while the machines the user configured are gone.
  if (carried.authoredHostsFound > 0 && carried.authoredHostsCarried === 0) {
    throw new Error(
      `Refusing to retire a config holding ${carried.authoredHostsFound} host record(s) that none ` +
      'of the current schema accepts: the file on disk is unchanged and still holds them. Only the ' +
      'default local entry would be left.'
    )
  }
  // Executors are the third container, and the same argument applies: a custom Executor id is one
  // the user minted, so its presence is unambiguous. Two guards, for the two ways they vanish —
  // the container being unreadable, and every record in a readable container being rejected.
  if (carried.executorsUnreadable) {
    throw new Error(
      'Refusing to retire a config whose Executor table the current schema cannot read: the file on ' +
      'disk is unchanged and still holds it. Every Executor you created would be replaced by the ' +
      'built-in defaults.'
    )
  }
  // Per-record total loss. The count is taken before the Provider-existence filter, so an Executor
  // dropped because this build retired its Provider does not reach here — that one is forced by the
  // data and stays silent salvage. This fires only when the *records themselves* became unreadable,
  // which is what adding a field to `executorSchema` does to every stored Executor at once. The
  // built-in defaults spread in underneath are what make it silent otherwise: the result looks like
  // a healthy Executor table with the user's own entries missing.
  if (carried.authoredExecutorsFound > 0 && carried.authoredExecutorsReadable === 0) {
    throw new Error(
      `Refusing to retire a config holding ${carried.authoredExecutorsFound} Executor(s) that none ` +
      'of the current schema accepts: the file on disk is unchanged and still holds them.'
    )
  }
  // A preference the current schema rejects falls back to the default rather than failing the
  // launch: unlike a project, it is one value the user can set again in one click.
  return {
    ...structuredClone(DEFAULT_CONFIG),
    hosts: carried.hosts,
    workspaces: carried.workspaces,
    executors: carried.executors,
    ...(carried.appearance ? { appearance: carried.appearance } : {}),
    ...(carried.browser ? { browser: carried.browser } : {}),
    ...(carried.notifications ? { notifications: carried.notifications } : {})
  }
}

export class ConfigStore {
  private saveTail: Promise<void> = Promise.resolve()

  constructor(private readonly path = join(app.getPath('userData'), 'agentmux.config.json')) {}

  /**
   * 这份配置在盘上的位置，用来在启动失败的对话框里告诉用户去哪里看。
   *
   * 只读、只用于展示。四道拒绝启动的守卫（见 `retiredConfigReplacement`）的全部意义是「你的东西
   * 还在这个文件里，去修一个字节」，而用户拿不到路径就无法行动——那些守卫也就白设了。
   */
  get filePath(): string {
    return this.path
  }

  async get(): Promise<AppConfig> {
    await mkdir(SCRATCH_BACKING_PATH, { recursive: true })
    let loaded: AppConfig
    let persist = false
    // Retirement resets the built-in Executor slice from the catalog, which is the one class of
    // rebinding the binding check would flag. See `write()` for why enforcing it here cannot work.
    let retiring = false
    try {
      const rawText = await readFile(this.path, 'utf8')
      const rawJson = JSON.parse(rawText)
      const isOlderVersion =
        typeof rawJson === 'object' &&
        rawJson !== null &&
        'version' in rawJson &&
        typeof (rawJson as { version: unknown }).version === 'number' &&
        Number.isInteger((rawJson as { version: number }).version) &&
        (rawJson as { version: number }).version > 0 &&
        (rawJson as { version: number }).version < CONFIG_VERSION
      if (isOlderVersion) {
        // No `rm`: the authored half is read out of `rawJson` right here, and the write below
        // overwrites this same path. Deleting first only widened the window in which the file was
        // gone and the projects were not yet rewritten — and it is what let the old code get away
        // with re-reading the file it had just deleted.
        loaded = retiredConfigReplacement(rawJson)
        persist = true
        retiring = true
      } else {
        loaded = configSchema.parse(rawJson) as AppConfig
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      loaded = structuredClone(DEFAULT_CONFIG)
      persist = true
    }
    const scratch = withScratchWorkspace(loaded)
    if (scratch.added) persist = true
    const notifications = withNotificationDefault(scratch.config)
    if (notifications.added) persist = true
    if (persist) {
      return await this.write(notifications.config, { enforceExecutorBinding: !retiring })
    }
    return notifications.config
  }

  async save(value: AppConfig): Promise<AppConfig> {
    return await this.write(value, { enforceExecutorBinding: true })
  }

  /**
   * `enforceExecutorBinding: false` is for exactly one caller: retiring an older-version file.
   *
   * The binding check reads the previous table off disk to refuse re-pointing a live Executor at
   * another Provider. Enforcing it during a retirement does active harm in two ways. It reads the
   * retired file through the **current** schema, whose `version` is a literal, so the read itself
   * throws and no config could ever be retired. And the one class of Executor a retirement *does*
   * rewrite is exactly the class the check would flag: an id that collides with a current built-in
   * default is reset from the catalog (see `authoredConfigCarryOver` — that collision is the
   * undecidable case), so a hand-made `opencode` pointing at another Provider would read as a
   * rebinding and brick the launch over a binding the bump has already decided to discard.
   *
   * Custom-id Executors are carried through untouched, so for them there is nothing to rebind.
   */
  private async write(
    value: AppConfig,
    { enforceExecutorBinding }: { enforceExecutorBinding: boolean }
  ): Promise<AppConfig> {
    const config = configSchema.parse(value) as AppConfig
    let saved!: AppConfig
    const operation = this.saveTail.catch(() => {}).then(async () => {
      if (enforceExecutorBinding) {
        let current: AppConfig | null = null
        try {
          current = configSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) as AppConfig
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const [executorId, executor] of Object.entries(current?.executors ?? {})) {
          const next = config.executors[executorId]
          if (next && next.providerId !== executor.providerId) {
            throw new Error(
              `Agent Executor ${executorId} is already bound to Provider ${executor.providerId}. ` +
              'Create a new Executor to choose another Provider.'
            )
          }
        }
      }
      await mkdir(dirname(this.path), { recursive: true })
      await durableWriteFile(this.path, `${JSON.stringify(config, null, 2)}\n`)
      saved = structuredClone(config)
    })
    this.saveTail = operation.then(() => {}, () => {})
    await operation
    return saved
  }
}
