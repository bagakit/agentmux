import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxClient, AgentMuxControlServer, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue, hashAgentCapability, issueAgentCapability, type AgentMuxControlRequest, type AgentMuxControlResponse, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { executorDetectionKey, useAppStore } from '../src/renderer/src/store.js'

const exec = promisify(execFile)
// packages/core/bin/agentmux — the real CLI entry the CLI attribution test also uses.
const cli = fileURLToPath(new URL('../../../packages/core/bin/agentmux', import.meta.url))

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent', providerId: 'codex', executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: '/repo', label: id,
    createdAt: 1, updatedAt: 1, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function seedStore(recipientId: string) {
  const caller = agent('caller-cli')
  const recipient = agent(recipientId)
  const tab = createWorkbenchTab('tab-recipient', {
    regionId: 'region-recipient', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: recipient.id
  })
  useAppStore.setState({
    config,
    sessions: [caller, recipient],
    activeWorkspaceId: 'workspace',
    mainSurface: 'workbench',
    tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    pendingAgentLaunches: {},
    executorDetections: {
      [executorDetectionKey('local', 'codex')]: {
        state: 'ready',
        result: { executorId: 'codex', providerId: 'codex', hostId: 'local', availability: 'available' }
      }
    },
    error: null
  })
  return { recipient, tab }
}

async function seedCoreSessionStore(path: string): Promise<{ readonly capability: string }> {
  const capability = issueAgentCapability()
  const now = Date.now()
  const make = (agentSessionId: string, runId: string, withCapability = false): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    run: { runId }, retiredRuns: [], hookBindingId: `hook-${agentSessionId}`, hookToken: `token-${agentSessionId}`,
    ...(withCapability ? { capabilityHash: hashAgentCapability(capability) } : {}), outputCursorBytes: 0, createdAt: now, updatedAt: now
  })
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, make('caller-cli', 'run-caller-cli', true))
  await store.compareAndSwap(null, make('mailbox-recipient', 'run-mailbox-recipient'))
  return { capability }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

// ── 集成 gate：把 CLI→ControlServer→store→submitPrompt 一整条 bytes 串起来 ─────────────
// 修复合同（docs/reviews/a2a-durable-send-acceptance-repair-2026-09-29.md）里最后一颗
// 未闭合验收判据：「The integrated test must assert bytes passed to the production
// submitPrompt caller.」现有两个 test 各自成立但**不相接**：
//   - packages/core/test/agent-send-cli-attribution.test.ts 用一个 fake executor（第 24 行）
//     自己**再** render 一次 envelope 塞进 delivered[]——就算 store.ts:2707 停止调用
//     renderAgentMuxMessageEnvelope，那个 test 仍会绿；这正是修复合同点名的
//     「fake executor that ignores request.message」陷阱。
//   - apps/desktop/test/control.test.ts:243-260 断言 store→submitPrompt 拿到 envelope 的
//     bytes，但 envelope 是测试内合成的、不是**从真 CLI 出**的。
// 本测试把两半接起来：起真 AgentMuxControlServer 在 unix sock 上，其 execute() 直接调 store 的
// executeControl（生产也走同一函数，见 ipc.ts:781 → executeControl）→ spawn 真 CLI，其 send 走
// sock 到 server → server 转 store → store 里 renderAgentMuxMessageEnvelope → spy submitPrompt。
// 断言：CLI stdout 拿到的 messageId 与 submitPrompt 接到的 wrapper 里的 messageId 完全一致，
// 且 wrapper bytes 包含 CLI 传入的 body。
//
// 变异探针（不写进 test，靠 review 落实）：把 store.ts:2707 的 renderAgentMuxMessageEnvelope
// 换成 request.text——本 test 与 control.test.ts:259 都红；CLI-attribution 仍绿。这就是「两半
// 分裂」的指纹，本 test 把它并起来。
it('CLI-written envelope reaches production submitPrompt with the same bytes and messageId', async () => {
  const runtime = await mkdtemp('/tmp/amux-a2a-integrated-')
  const queuePath = join(runtime, 'state', 'global-messages.ndjson')
  const sessionStorePath = join(runtime, 'state', 'agent-sessions.json')
  const sock = join(runtime, 'control.sock')

  const { recipient } = seedStore('mailbox-recipient')
  const { capability } = await seedCoreSessionStore(sessionStorePath)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()

  // Exercise the same Core capability and Session/Run binding used by main IPC before handing the
  // request to the renderer Control executor. The CLI child reads this durable store through the
  // injected path; no caller/session title or mock identity is accepted.
  const core = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(sessionStorePath) })
  await (core as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')

  // 起真 AgentMuxControlServer。execute 转发到 store.executeControl —— 就是生产 ipc.ts:781 那条路。
  const server = new AgentMuxControlServer({
    execute: async (request: AgentMuxControlRequest): Promise<AgentMuxControlResponse> => {
      if (request.operation === 'send' && request.message?.sender.kind === 'agent-session') {
        if (!request.caller?.capability) throw new Error('managed capability missing')
        core.authorizeAgentMessage({
          capability: request.caller.capability,
          callerAgentSessionId: request.caller.agentSessionId,
          senderSessionId: request.message.senderSessionId,
          senderRunId: request.message.senderRunId,
          recipientSessionId: request.message.recipientSessionId,
          recipientRunId: request.message.recipientRunId
        })
      }
      return (await useAppStore.getState().executeControl(request)) as AgentMuxControlResponse
    }
  }, sock)
  await server.start()

  try {
    // 1) 真 CLI 走 send 到 sock。AGENTMUX_ENV=1 + AGENTMUX_AGENT_SESSION_ID 让 CLI 认作 managed sender。
    //    timeout=15000 而非 5000：CLI 子进程 + fs + sock 握手 + queue append + store executeControl 一整套，
    //    在忙碌 CI 机上 5s 会 flake。见 MINOR-4 (review 2026-09-29)。
    const stdout = await exec(cli, ['send', '--to-session', recipient.id, '--text', 'integrated body bytes'], {
      timeout: 15000,
      env: {
        ...process.env,
        AGENTMUX_RUNTIME_DIRECTORY: runtime,
        AGENTMUX_MESSAGE_QUEUE_PATH: queuePath,
        AGENTMUX_AGENT_SESSION_STORE: sessionStorePath,
        AGENTMUX_ENV: '1',
        AGENTMUX_AGENT_SESSION_ID: 'caller-cli',
        AGENTMUX_AGENT_CAPABILITY: capability
      }
    }).then((r) => JSON.parse(r.stdout) as Record<string, unknown>)

    const cliMessageId = (stdout.result as Record<string, unknown>).messageId as string
    expect(cliMessageId, 'CLI 必须回 messageId').toEqual(expect.any(String))

    // 2) 生产 submitPrompt 收到的必须是 envelope 派生出的 wrapper——含 CLI 生成的 messageId + body 原文。
    //    这里断言不能只写 `toContain('body')`——store.ts:2707 换成 request.text 后 body 会照旧透传，
    //    但**messageId 那个 attribute** 只可能从 renderAgentMuxMessageEnvelope(envelope) 出。判据钉
    //    在 messageId 上。
    expect(submit).toHaveBeenCalledTimes(1)
    const [, submittedPrompt, submittedMessageId] = submit.mock.calls[0]!
    expect(submittedMessageId, 'submitPrompt 拿到的 messageId 就是 CLI 出的那个').toBe(cliMessageId)
    // mutation-kill: store.ts:2706-2708 —— 把 renderAgentMuxMessageEnvelope(request.message) 换成 request.text
    // 会让下面两条 toContain 里的第一条红：messageId 属性只从 renderAgentMuxMessageEnvelope 出。
    expect(submittedPrompt, 'wrapper 必须携带 CLI 生成的 messageId 属性')
      .toContain(`messageId="${cliMessageId}"`)
    expect(submittedPrompt, 'wrapper 里必须一字不差携带 CLI 传的 body')
      .toContain('integrated body bytes')
    expect(submittedPrompt, 'wrapper 是 <amux> 信封形态，不是裸 text')
      .toMatch(/^<amux\s/)

    // 3) 双向 verify：queue 落盘的 envelope 与 CLI stdout messageId 一致，说明 sock 与 durable
    //    队列同源、没有编造。**恰好** 1 条 message record——多写一次就红，钉住 append 只走了一次。
    const queue = new DurableAgentMuxMessageQueue(queuePath)
    const records = await queue.listAfter(0)
    const messages = records.filter((r) => r.envelope.messageId === cliMessageId)
    expect(messages, 'CLI 只 append 一次，queue 里恰好一条同 messageId 的记录').toHaveLength(1)

    // 4) recipientRunId 反例：store.ts:2717-2719 那道 recipient-run-mismatch 交叉校验 CLI 本身走不进
    //    （agentmux.ts:627 恒设 null），本 test 主线也覆盖不到——手工构造一条带**错** runId 的请求
    //    直接送 executeControl，钉住那道守卫存在且真会红。缺了这条，把 store.ts:2717-2719 整段删掉
    //    上面的主断言仍绿——覆盖会有洞。见 MINOR-3 (review 2026-09-29)。
    const cliMessage = messages[0]!.envelope
    const badRunId = 'run-not-the-recipient'
    await expect(useAppStore.getState().executeControl({
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'control-run-mismatch',
      operation: 'send',
      target: { kind: 'agent-session', agentSessionId: recipient.id },
      text: cliMessage.body,
      caller: { agentSessionId: 'caller-cli', capability },
      message: { ...cliMessage, messageId: 'test-run-mismatch', recipientRunId: badRunId }
    })).rejects.toMatchObject({ code: 'MESSAGE_RECIPIENT_MISMATCH' })
  } finally {
    await server.stop()
    await core.dispose()
    await rm(runtime, { recursive: true, force: true })
  }
})
