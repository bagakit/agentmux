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
} {
  // Every key is `.optional()`, including the `unknown` ones. In zod v4 a bare `z.unknown()` key is
  // **required** — an absent key fails the whole object — and this outer parse failing is exactly
  // the all-or-nothing collapse the per-record salvage below exists to prevent: `rawWorkspaces`
  // would fall back to `[]` and every project would be dropped. Caught by the guard tests when the
  // preference fields were first added here without `.optional()`.
  const outer = z
    .object({
      hosts: z.array(z.unknown()).optional(),
      workspaces: z.array(z.unknown()).optional(),
      executors: z.record(z.string(), z.unknown()).optional(),
      appearance: z.unknown().optional(),
      browser: z.unknown().optional(),
      notifications: z.unknown().optional()
    })
    .safeParse(raw)
  const rawHosts = outer.success ? outer.data.hosts ?? [] : []
  const rawWorkspaces = outer.success ? outer.data.workspaces ?? [] : []
  const rawExecutors = outer.success ? outer.data.executors ?? {} : {}

  const hosts = rawHosts
    .map((host) => hostSchema.safeParse(host))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
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
  const carriedExecutors = Object.fromEntries(
    Object.entries(rawExecutors)
      .filter(([executorId]) => !(executorId in DEFAULT_CONFIG.executors))
      .filter(([executorId]) => executorIdSchema.safeParse(executorId).success)
      .map(([executorId, executor]) => [executorId, executorSchema.safeParse(executor)] as const)
      // An Executor pointing at a Provider this build no longer ships would fail the schema's
      // Provider-existence refinement, so it cannot be carried for the same reason as a homeless
      // workspace: keeping it would make the whole config unsavable.
      .filter(([, parsed]) => parsed.success && providerIds.has(parsed.data.providerId))
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
    found: rawWorkspaces.length,
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
 *
 * The second class is deliberately not softened into "carry the workspace and drop the host": the
 * schema's host-existence refinement would reject that config, so `save()` could never write it.
 * Nothing here can repair a damaged host — only the user can — so the honest move is to say which
 * host and which projects, and leave the file alone.
 */
function retiredConfigReplacement(raw: unknown): AppConfig {
  const carried = authoredConfigCarryOver(raw)
  if (carried.found > 0 && carried.workspaces.length === 0) {
    throw new Error(
      `Refusing to retire a config holding ${carried.found} project(s) that none of the current ` +
      'schema accepts: the file on disk is unchanged and still holds them.'
    )
  }
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
