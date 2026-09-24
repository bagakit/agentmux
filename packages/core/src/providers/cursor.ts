import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { CURSOR_LAUNCH_OPTIONS } from '../agent-launch-option.js'
import type { AgentProvider, AgentProviderDefinition } from '../agent-provider.js'
import type { AgentManagedHookPlan } from '../managed-hook-installer.js'
import { normalizeNativeHook, type AgentNativeHookSpecification } from '../hook-normalizer.js'
import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'
import { cursorDataRoot, cursorWorkspaceSlug, readCursorSessionHistoryPage } from './cursor-native-history.js'

type ProviderFactory = (definition: AgentProviderDefinition) => AgentProvider

/**
 * 写进 `~/.cursor/hooks.json` 的事件名。
 *
 * 只装 AgentMux 真的要用的八个。Cursor 的完整事件表比这大得多（`sessionStart`/`sessionEnd`/
 * `preCompact`/`subagentStart`/`subagentStop`/`afterAgentThought`/`afterShellExecution`/
 * `afterMCPExecution`/`beforeReadFile`/`afterFileEdit`/`beforeTabFileRead`/`afterTabFileEdit`/
 * `workspaceOpen`）——`beforeReadFile` 与 `afterFileEdit` 尤其致命：Agent 每读一个文件、每改一处
 * 都会新起一个子进程，那是把 hook 开销挂到最热的路径上，而 Core 今天没有任何判断需要它们。
 *
 * 装进来的八个各有其不可替代的作用：
 * - `beforeSubmitPrompt`：一轮的起点，也是 Cursor 唯一带 `prompt` 的事件。
 * - `preToolUse`/`postToolUse`/`postToolUseFailure`：一次工具调用的事前、成功事后、失败事后。
 *   三条都带 `tool_use_id`，故能收敛到时间轴上的同一条。
 * - `beforeShellExecution`/`beforeMCPExecution`：授权门。装它们不是为了回决定（我们不回），
 *   是为了让「Agent 正卡在一个授权提示上」这件事对 Core 可见。
 * - `afterAgentResponse`：助手正文（`text`）。
 * - `stop`：一轮收尾，且是 Cursor 唯一带 token 用量的事件。
 */
export const CURSOR_HOOK_EVENTS = [
  'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'beforeShellExecution', 'beforeMCPExecution', 'afterAgentResponse', 'stop'
] as const

/**
 * Cursor 的 hook 合同。
 *
 * 事件名是 camelCase，负载键却是 Claude 同族的 snake_case（`tool_name`/`tool_input`/`tool_output`/
 * `tool_use_id`）——normalizer 的既有读取顺序已覆盖这些键，所以时间轴不需要 Cursor 专属分支。
 *
 * `stop` 状态按 status 诚实区分：
 * 官方 2026.10.01-e373342 实测，Cursor 在 stop 负载里传递 status（"completed" / "aborted" / "error"）。
 * 只有已证明成功的 "completed" 赋予 state: 'done' 与 successful completion 身份（放行 automatic 进度）；
 * 实际 "error" 诚实映射为 state: 'error'，lifecycleEvent: 'turn-end'（放行 manual 下一轮，automatic 零写拒绝）；
 * "aborted" 取消收尾使用已有诚实语义 state: 'unknown'，lifecycleEvent: 'turn-end'（无 completion 身份）；
 * 未知或缺席的 status 不得猜成功亦不能断定已结束，映射为 state: 'unknown'，lifecycleEvent: null。
 *
 * 两个授权门判 waiting 而非 working：它们触发的时刻，Cursor 正把这次执行按住等一个决定。我们不回
 * 决定（见 catalog 的 permission: 'observe'），于是它会落到 Cursor 自己的 TUI 提示上等用户——
 * 那正是 waiting 的定义。判成 working 会让「等我点一下」和「正在干活」在界面上长得一模一样。
 *
 * nativeHandle 与 subagent 隔离：
 * Cursor 运行时的会话标识统一为 UUID（执行循环中的 `Mt`），它同时用作 `conversationId` 和 chat 目录名；
 * `~/.cursor/chats/<32 hex>` 的 32 hex 仅是 `md5(resolve(cwd))` 的工作区目录桶，其下的子目录与 transcript
 * 路径均直接使用完整 UUID。`--resume <chatId>` 消费的正是该 UUID。Hook 负载通过 `conversation_id`（并带
 * `transcript_path`）送达，故声明 nativeHandle 解析主会话恢复句柄与定位器；同时声明 subagentTracking
 * 隔离子代理事件（`subagentStart`/`subagentStop` 携带 `subagent_id`），防止子代理覆盖主会话句柄。
 */
export const CURSOR_HOOKS: AgentNativeHookSpecification = {
  // 固定第一方版本同时提供 hook_event_name；托管配置继续显式用 --event 传递事件名。
  eventNameSource: { kind: 'flag' },
  rules: [
    // 授权门：Cursor 正等一个决定。
    { events: ['beforeShellExecution', 'beforeMCPExecution'], state: 'waiting' },
    { events: ['stop'], matches: payload => payload.status === 'completed', state: 'done' },
    { events: ['stop'], matches: payload => payload.status === 'error', state: 'error', lifecycleEvent: 'turn-end' },
    { events: ['stop'], matches: payload => payload.status === 'aborted', state: 'unknown', lifecycleEvent: 'turn-end' },
    { events: ['stop'], state: 'unknown', lifecycleEvent: null },
    {
      events: [
        'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse'
      ],
      state: 'working'
    }
  ],
  subagentTracking: {
    startEvents: ['subagentStart'], stopEvents: ['subagentStop'], mainStopEvents: ['stop'], idKeys: ['subagent_id']
  },
  nativeHandle: { sessionIdKeys: ['conversation_id'], transcriptPathKeys: ['transcript_path'] }
}

/**
 * Cursor 的 workspace trust marker 路径。
 *
 * marker **不在 workspace 里**，而在数据根下按 workspace 路径派生的子目录里：
 * `<root>/projects/<slug>/.workspace-trusted`。slug 是路径的逐字变换（非字母数字换 `-`、连续 `-`
 * 折叠、去掉首尾 `-`）——这三步必须与 Cursor 完全一致，差一步就写到另一个目录、marker 形同不存在。
 * 本机实测目录名如 `Users-bytedance-proj-priv-bagakit-agentmux`。
 */
export function cursorTrustMarkerPath(
  workspacePath: string,
  env?: Readonly<Record<string, string>>
): string {
  return join(cursorDataRoot(workspacePath, env), 'projects', cursorWorkspaceSlug(workspacePath), '.workspace-trusted')
}

/**
 * Cursor 的 managed hook 计划：hooks 配置 + workspace trust marker。
 *
 * **两个 mutation 都必须在这一个计划里**，因为它们要在同一时刻成立：hooks 装好了但 workspace 未
 * 授信，Cursor 会先用一个交互式 trust 提示吃掉第一个 prompt——用户看到的是「AgentMux 把我的第一句
 * 话弄丢了」。marker 是 Cursor 自己写的那份格式（`trustedAt` + `workspacePath`，本机实测逐字如此），
 * 不是我们发明的旗标：Cursor 只做 `existsSync` 判存在，内容供人和它自己诊断用。
 *
 * `trustMethod` 刻意不写。Cursor 自己在 CLI 旗标路径上写 `"cli-flag"`、在继承路径上写
 * `"inherited"`，而 AgentMux 走的是第三条路（预置），冒用它任何一个都是在 marker 里撒谎；这个字段
 * 在 Cursor 侧是可选的（它的读取只判文件存在），所以缺席是如实且无损的。
 *
 * hooks 配置写 `~/.cursor/hooks.json`——Cursor 认四层配置（enterprise / team / **user** / project），
 * user 层是唯一「属于这台机器的这个用户、且与仓库无关」的一层。**绝不**写 project 层的
 * `<workspace>/.cursor/hooks.json`：那是会被提交进用户仓库的文件。也绝不碰它同时会读的
 * `~/.claude/settings.json`（Cursor 为兼容也读那份）——那是用户为 Claude 维护的配置。
 *
 * `version: 1` 跟随本机实测的既有文件。它今天不被校验，但写一个与真实文件不同的形状是无谓的偏离。
 */
export function createCursorManagedHookPlan(
  workspacePath: string,
  env?: Readonly<Record<string, string>>
): AgentManagedHookPlan {
  const command = managedHookCommand('cursor')
  const hooks = Object.fromEntries(CURSOR_HOOK_EVENTS.map((eventName) => [eventName, [
    // 托管脚本的事件名来源保持显式 --event，不猜负载别名。
    { command: `${command} --event ${eventName}`, ...hookCommandTimeout('cursor') }
  ]]))
  return {
    providerId: 'cursor',
    mutations: [
      {
        path: join(cursorDataRoot(workspacePath, env), 'hooks.json'),
        content: `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
        mode: 0o600,
        merge: { kind: 'json-managed-events', marker: 'agentmux-hook.js' }
      },
      {
        path: cursorTrustMarkerPath(workspacePath, env),
        // marker 是 Cursor 独占的一个文件（它只判存在），AgentMux 是唯一写它的人，故整文件拥有、
        // 不需要合并。内容按 workspace 派生，所以对同一个 workspace 幂等——installer 的
        // unchanged-hash 判定因此在重启后不会白写一次。
        content: `${JSON.stringify({ trustedAt: cursorTrustStamp(workspacePath), workspacePath: resolve(workspacePath) }, null, 2)}\n`,
        mode: 0o600
      }
    ]
  }
}

/**
 * marker 的 `trustedAt`。
 *
 * 必须是**对同一个 workspace 恒定**的值，不能用 `new Date()`：installer 靠「内容 hash 未变」判定
 * 无需重写（见 AgentManagedHookInstaller.ensure）。真实时钟会让每次启动都算出新内容、每次都重写
 * 一遍 marker，还会让 preview/install 两次渲染结果不一致而撞上 HOOK_TARGET_CHANGED。
 *
 * 于是取 workspace 路径的 hash 前 8 位当稳定纪元偏移：它是一个真实、合法、可解析的 ISO 时间戳
 * （Cursor 从不解析它，只判文件存在），却完全由 workspace 决定。不假装那是「真的授信时刻」——
 * AgentMux 的授信时刻就是 workspace 被纳管的时刻，而那正是这个值代表的东西。
 */
function cursorTrustStamp(workspacePath: string): string {
  const digest = createHash('sha256').update(resolve(workspacePath)).digest('hex').slice(0, 8)
  // 2020-01-01T00:00:00Z 起、按 hash 派生的秒偏移（上限约 136 年，落在合法 Date 区间内）。
  return new Date(Date.UTC(2020, 0, 1) + Number.parseInt(digest, 16) * 1_000).toISOString()
}

export function createCursorProvider(defineAgentProvider: ProviderFactory): AgentProvider {
  const { subagentTracking: _tracking, nativeHandle: _identity, ...observationOnly } = CURSOR_HOOKS
  const provider = defineAgentProvider({
    planManagedHooks: ({ workspacePath, env }) => createCursorManagedHookPlan(workspacePath, env),
    catalog: catalog({
      id: 'cursor', label: 'Cursor', executable: 'cursor-agent', expectedProcess: 'cursor-agent',
      promptDelivery: 'positional-argv',
      hookStrategy: { kind: 'native', installation: 'explicit-managed' },
      // `--resume [chatId]` 直传 chat id（bundle 实测：`else fe=o.resume`，无 UUID 校验、无序号
      // 解释；只有 `-1` 与 `-<n>` 两种**负数**形式才被当成「第 n 近」）。chat id 是
      // `<configRoot>/chats/<workspaceBucket>/<chatId>` 的原生会话 UUID，跨会话稳定。
      resumeStrategy: { kind: 'provider-native', locator: 'session-id' },
      acpStrategy: { kind: 'none' },
      capabilities: {
        terminal: true, timeline: 'complete-events',
        // observe 而非 respond：`preToolUse` 与两个 shell/MCP 门确实读 stdout 上的
        // `permission: allow|deny|ask`，但回决定要把这条 fire-and-forget 的 hook 变成阻塞 RPC。
        // 我们回 `{}`——Cursor 的校验器写明 permission 可以是 undefined，且它只在**显式**
        // `continue === false` 时拦提交，所以 `{}` 既合法又不改变它的行为。
        permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
        // usage 刻意不声明：Cursor 的 `stop` 负载**直接带** `input_tokens`/`output_tokens`/
        // `cache_read_tokens`/`cache_write_tokens`，压根不需要读 transcript——而今天的 usage 通路
        // （AgentUsageCapability）只有 native-transcript 一种形状，声明它等于承诺去解析一个
        // Cursor 从不产出的 transcript 文件。这条留给「负载直报 usage」那一类能力单独接。
      }
    }),
    launchOptions: CURSOR_LAUNCH_OPTIONS,
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])],
    hook: CURSOR_HOOKS,
    readSessionHistoryPage: readCursorSessionHistoryPage,
    buildResumeArgs: (sessionId, _transcriptPath, prompt, args) => [
      '--resume', sessionId, ...args, ...(prompt ? [prompt] : [])
    ]
  })
  return {
    ...provider,
    normalizeHook(envelope, context) {
      const payload = envelope.payload ?? {}
      const sessionId = typeof payload.conversation_id === 'string' && payload.conversation_id.trim()
        ? payload.conversation_id.trim() : undefined
      const known = context.nativeHandle
      const foreign = known !== undefined && sessionId !== undefined && sessionId !== known.sessionId
      // A foreign receipt must not mutate this Run's existing child roster before
      // its return value is fenced. It contributes only the authenticated raw observation.
      const normalized = foreign ? normalizeNativeHook({ ...observationOnly, rules: [] }, envelope)
        : provider.normalizeHook(envelope, context)
      if (!foreign) {
        // An authenticated first-party receipt establishes birth. A later receipt cannot
        // replace the durable locator for the same main native Session. Known child
        // settlement retains the shared roster's proven parent completion contribution.
        return known && normalized.nativeHandle ? { ...normalized, nativeHandle: known } : normalized
      }
      const { nativeHandle: _handle, turnUsage: _usage, interaction: _interaction,
        interactionCompletion: _completion, ...neutral } = normalized
      return { ...neutral, lifecycleEvent: null, semanticState: 'unknown',
        status: { ...normalized.status, state: 'running' }, timeline: [] }
    }
  }

}
