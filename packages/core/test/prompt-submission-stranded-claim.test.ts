import { describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentPromptSubmissionCoordinator } from '../src/prompt-submission.js'
import type { AgentScreenEvidenceStore } from '../src/screen-evidence.js'
import type {
  AgentMuxAgentSession,
  AgentMuxStoredAgentSession
} from '../src/types.js'

// ---------------------------------------------------------------------------
// 同族第二个 P0（f-25q8fccdm / T-007，RED-LINES 反例 1 的第二实例）：
//
//   terminalPromptSubmission 这枚 claim 在 prompt-submission.ts:243 于**任何字节发出之前**落盘，
//   payload/submit 两个 acknowledged 都是 false，并同时把 readiness epoch 标记为已消费。唯一翻成
//   true 的地方是 acknowledgePhase（:400-407），要等 submit 阶段的 kernel.input 成功**且** CAS 落盘
//   成功。两者之间任何一次抛出——最可达的是 confirmRenderOrDegrade 那次 kernel.status 抛
//   CTXMUX_DISCONNECTED（:504-507 只特判 run_not_found，断线原样 rethrow）——都把 claim 永久留在
//   submit 未 ack。下一条 prompt 带着一个**结构上无法递回旧 id** 的新 submissionId（runtime-controller
//   每次 randomUUID，全链无 id 形参），必然撞 :190 的 BUSY 闸，而这个 Run 的 PTY 仍在接受字节。
//
// 这条不变量写成一句可证伪断言：一次断线在 render 确认窗口里搁浅了 claim 之后，对一个仍 running 的
// Run 用**新** submissionId 再发一条 prompt，必须真的发得出去（两阶段字节都送达），而不是永久 BUSY。
//
// 结构照 readiness-consumed-recovery-invariant.test.ts：一条**健康路径**正向控制（证明 harness 与
// 断言本身能观测到「发送发生了」，不是恒绿），一条**断线搁浅**用例（本 finding 本体）。两条只差
// 第一次 render 确认时 kernel.status 是否抛 CTXMUX_DISCONNECTED——这个差就是变异探针。
// ---------------------------------------------------------------------------

const RUN_ID = 'stranded-run'
const SESSION_ID = 'stranded-agent'

/** 一个活着、running、readiness 已就绪（readyThroughByte 定义、未被消费）的会话。 */
function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding-stranded-claim'.padEnd(43, 'A'),
    hookToken: 'token-stranded-claim'.padEnd(43, 'B'),
    outputCursorBytes: 0,
    createdAt: 1,
    updatedAt: 1,
    // initial-composer 要求 readyThroughByte 严格大于 epoch 的 outputCursorBytes，故不能是 0。
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'stranded-epoch-1',
      run: { runId: RUN_ID },
      outputCursorBytes: 0,
      readyThroughByte: 12
    }
  }
}

function run(acceptedInputBytes = 0): CtxmuxAdapterRun {
  return {
    runId: RUN_ID,
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/repo',
    pid: 321,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 12,
    firstAvailableByte: 0,
    acceptedInputBytes
  }
}

type RenderOutcome = { throwCode: string } | { resolve: number }

async function fixture() {
  const registry = new AgentMuxAgentSessionRegistry(new AgentMuxMemoryAgentSessionStore())
  await registry.put(storedSession())

  // 有状态的 kernel：input 逐字节透传并推进 daemon 受据游标（真实 daemon 的受据形状），status 由
  // disconnect 开关控制。cursor 让后续调用读到的 acceptedInputBytes 跟真实受据一致——否则同 id 幂等
  // 重放会撞 :355 那道「CtxMux 游标不能落在已落盘阶段收据之前」的门（那是 fixture 假象，非本缺陷）。
  let disconnected = false
  let cursor = 0
  const kernel = {
    identity: () => ({ daemonInstanceId: 'daemon-1', protocolVersion: 1, buildIdentity: 'test' }),
    input: vi.fn(async (_runId: string, operation: { expectedByte: number; data: string }) => {
      cursor = operation.expectedByte + Buffer.byteLength(operation.data)
      return {
        run: run(cursor),
        appliedByteRange: {
          startByte: operation.expectedByte,
          endByte: cursor
        }
      }
    }),
    // confirmRenderOrDegrade 的权威状态查询。断线时抛 CTXMUX_DISCONNECTED——这正是 :506 不特判、
    // 于是 :507 原样 rethrow 的那一类我方故障。
    status: vi.fn(async () => {
      if (disconnected) throw new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
      return run(cursor)
    })
  }

  // 屏幕证据：每次调用按队列决定这次 render 观察是抛（走降级判定）还是解析（render 确认成功）。
  const renderOutcomes: RenderOutcome[] = []
  const screenEvidence = {
    wait: vi.fn(async (..._args: Parameters<AgentScreenEvidenceStore['wait']>) => {
      const outcome = renderOutcomes.shift()
      if (!outcome) return 1
      if ('throwCode' in outcome) {
        throw new AgentMuxError('render observation failed', outcome.throwCode)
      }
      return outcome.resolve
    })
  }

  const publisher = new AgentMuxClientEventPublisher()
  const coordinator = new AgentPromptSubmissionCoordinator({
    kernel: kernel as never,
    providers: new AgentProviderRegistry(),
    registry,
    publisher,
    agentInputCursors: new Map(),
    screenEvidence: screenEvidence as never,
    requireAgentSession: (agentSessionId: string) => registry.get(agentSessionId),
    assertAgentRun: () => {},
    updateExactAgentSession: async (agentSessionId, expectedRun, update) => (
      await registry.update(agentSessionId, expectedRun, update)
    )
  })

  // 每次提交都从当前受据游标构造一个新的 currentRun——faithful 于生产：submitAgentPrompt 的 run 来自
  // serializeAgentInput → kernel.status，读的是 daemon 此刻的 acceptedInputBytes。acceptedOverride 用于
  // 模拟「重连后 daemon 报了个更低的游标」，让一次同 id 重放在 :355 抛 STATE_INVALID、进到回滚路径。
  const submit = (submissionId: string, acceptedOverride?: number) => coordinator.submitInputPlan(
    registry.get(SESSION_ID) as AgentMuxAgentSession,
    run(acceptedOverride ?? cursor),
    submissionId,
    'ship it',
    new AgentProviderRegistry().get('codex').planPromptInput('ship it')
  )

  return {
    registry,
    kernel,
    submit,
    queueRender: (outcome: RenderOutcome) => renderOutcomes.push(outcome),
    disconnect: (value: boolean) => { disconnected = value },
    stored: () => registry.get(SESSION_ID)
  }
}

describe('断线搁浅 submission claim 之后，活着的 Run 必须仍发得出下一条 prompt', () => {
  it('正向控制：无断线时提交完整落地（证明 harness 与断言能观测到「发送发生了」）', async () => {
    const f = await fixture()
    f.queueRender({ resolve: 1 })

    await expect(f.submit('healthy-submission')).resolves.toBeUndefined()

    // payload + submit 两阶段字节都发出去了。
    expect(f.kernel.input).toHaveBeenCalledTimes(2)
    expect(f.stored().terminalPromptSubmission).toMatchObject({
      submissionId: 'healthy-submission',
      submit: { acknowledged: true }
    })
  })

  it('断线搁浅 claim：新 submissionId 再发不再永久 BUSY，且原就绪 epoch 可复用（P0 本体）', async () => {
    const f = await fixture()

    // 第一次提交：payload 受据成功，随后 render 确认超时；confirmRenderOrDegrade 向 daemon 要权威状态
    // 时链路已断，kernel.status 抛 CTXMUX_DISCONNECTED，原样 rethrow。这正是最可达的搁浅触发点。
    f.queueRender({ throwCode: 'AGENT_PROMPT_RENDER_TIMEOUT' })
    f.disconnect(true)
    const first = await f.submit('stranded-submission').then(() => null, (error: unknown) => error as AgentMuxError)
    expect(first, '第一次提交应因断线失败').toBeInstanceOf(AgentMuxError)
    expect(first?.code, '失败必须是我方链路断（第 2 类），不是别的').toBe('CTXMUX_DISCONNECTED')
    // 第一次只发了 payload，submit 的 \r 从未发出（confirmRenderOrDegrade 在 applyPhase('submit') 前抛）。
    expect(f.kernel.input).toHaveBeenCalledTimes(1)

    // 回滚判据一：搁浅的 claim 被撤掉，不再挡住 :190。
    expect(
      f.stored().terminalPromptSubmission,
      '搁浅的 claim 没有被回滚——下一条 prompt 会永久撞 AGENT_PROMPT_SUBMISSION_BUSY（红线违规）'
    ).toBeUndefined()
    // 回滚判据二：epoch 原地留下、仍就绪、未被消费——下一次 claim 能复用它，且带的是**真实**光标（12），
    // 不是编造的 0（编造 0 会让消费侧字节记账错位）。
    expect(f.stored().terminalPromptReadiness).toMatchObject({
      id: 'stranded-epoch-1',
      readyThroughByte: 12
    })
    expect(
      f.stored().terminalPromptReadiness?.consumedBySubmissionId,
      'epoch 仍挂着旧的消费标记——存储不变量会连带把复用也堵死'
    ).toBeUndefined()

    // Run 仍然活着（daemon 恢复应答 running）：这是「活着的 Agent 有一条可发送的路」的直接证明。
    f.disconnect(false)
    f.queueRender({ resolve: 1 })
    const second = await f.submit('fresh-submission').then(() => null, (error: unknown) => error as AgentMuxError)
    expect(
      second,
      '断线搁浅之后，对一个仍 running 的 Run 用新 id 再发 prompt 必须真的发得出去，而不是永久 BUSY'
    ).toBeNull()
    // 第二次的 payload + submit 两阶段都送达（累计 1 + 2 = 3 次 kernel.input）。
    expect(f.kernel.input).toHaveBeenCalledTimes(3)
    expect(f.stored().terminalPromptSubmission).toMatchObject({
      submissionId: 'fresh-submission',
      submit: { acknowledged: true }
    })
  })

  it('去重不被回滚弱化：submit 已 ack 的完整提交，同 id 重放仍幂等返回、不被撤掉', async () => {
    const f = await fixture()
    f.queueRender({ resolve: 1 })
    await f.submit('done-submission')
    expect(f.kernel.input).toHaveBeenCalledTimes(2)

    // 同一 submissionId 重放：走 :186 的幂等返回，claim 原样保留，不重发字节。
    await expect(f.submit('done-submission')).resolves.toBeUndefined()
    expect(f.kernel.input, '同 id 重放不得重发任何字节').toHaveBeenCalledTimes(2)
    expect(f.stored().terminalPromptSubmission).toMatchObject({
      submissionId: 'done-submission',
      submit: { acknowledged: true }
    })
  })

  it('回滚不许抹掉已完成的 claim：submit 已 ack 的提交在重放中抛错时，去重记录必须存活', async () => {
    // 覆盖 rollbackStrandedClaim 的 `submit.acknowledged` 守卫项。构造：一次完整提交后，重连让 daemon
    // 报了个更低的受据游标（override=0），同 id 重放在 applyPhase 的 :355「CtxMux 游标不能落在已落盘阶段
    // 收据之前」抛 STATE_INVALID，于是进到 catch → rollback。此时 claim 的 submit 已 ack——回滚**绝不能**
    // 撤它，否则一条已完成的提交丢掉去重记录、下次会被当新提交重发一遍。这一条是那个守卫项的判别器：
    // 去掉 `|| stranded.submit.acknowledged` 后本条即红（claim 被误撤成 undefined）。
    const f = await fixture()
    f.queueRender({ resolve: 1 })
    await f.submit('done-submission')
    expect(f.kernel.input).toHaveBeenCalledTimes(2)

    const throwing = await f.submit('done-submission', 0).then(() => null, (error: unknown) => error as AgentMuxError)
    expect(throwing, '游标回退的重放应抛 STATE_INVALID，触发回滚路径').toMatchObject({
      code: 'AGENT_PROMPT_SUBMISSION_STATE_INVALID'
    })
    expect(
      f.stored().terminalPromptSubmission,
      '回滚误撤了一条已 ack 完成的 claim——它的去重记录必须存活，否则完成的提交会被重发'
    ).toMatchObject({
      submissionId: 'done-submission',
      submit: { acknowledged: true }
    })
  })

  it('提交键已落地才失败：claim 照撤，但 epoch 的消费标记必须留着（不得复活一枚已作废的就绪）', async () => {
    // 覆盖回滚里的 submitLanded 分支。submit 阶段的 \r 先到 daemon（:364），ack CAS 后落盘（:412）；
    // 这中间抛一次存储故障，字节其实**已经进了 composer**，那一 turn 已经开跑。此时 claim 要撤（否则
    // 永久 BUSY），但消费标记不能撤：撤了会让下一条 prompt 拿着一枚早已作废的就绪 epoch 去投字节，
    // 正好撞上本子系统存在的理由。判别器：去掉 submitLanded 条件后本条即红。
    const f = await fixture()
    f.queueRender({ resolve: 1 })

    // 让第二次 CAS（submit 阶段的 ack 落盘）抛一个非 STALE 的存储故障。
    const reg = f.registry as unknown as { update: (...args: never[]) => Promise<unknown> }
    const realUpdate = reg.update.bind(reg)
    let cas = 0
    reg.update = async (...args: never[]) => {
      cas += 1
      if (cas === 2) throw new AgentMuxError('store write failed', 'AGENT_SESSION_STORE_WRITE_FAILED')
      return realUpdate(...args)
    }

    const failed = await f.submit('landed-submission').then(() => null, (error: unknown) => error as AgentMuxError)
    expect(failed?.code, '原始存储故障必须原样上抛，不被回滚吞掉').toBe('AGENT_SESSION_STORE_WRITE_FAILED')
    // 两阶段字节都已发出——提交键确实落地了。
    expect(f.kernel.input).toHaveBeenCalledTimes(2)
    expect(f.kernel.input.mock.calls.map((call) => (call[1] as { data: string }).data)).toEqual(['ship it', '\r'])

    // claim 照撤：不留下永久 BUSY。
    expect(f.stored().terminalPromptSubmission).toBeUndefined()
    // 这枚 epoch 真的被用掉了（turn 已开跑），必须整枚消失——不得以「仍然就绪」的面目留下。
    expect(
      f.stored().terminalPromptReadiness,
      '提交键已落地却把 epoch 留成就绪——下一条 prompt 会拿着作废的就绪对着生成中的 turn 投字节'
    ).toBeUndefined()
  })
})
