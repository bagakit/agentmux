import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  agentSessionServiceOutcome,
  classifyServiceNotice,
  serviceNoticeAriaLive,
  serviceNoticeToRender
} from '../src/renderer/src/lib/service-window-notice.js'
import {
  CONNECTION_LOST_DETAIL,
  CONNECTION_UNRECOVERABLE_DETAIL
} from '../src/renderer/src/lib/session-state.js'
import type { SessionSnapshot } from '../src/shared/contracts.js'

/**
 * 服务窗的判定层（AGENTS.md 原则 11）。
 *
 * 这条原则的全部要害在**分类**：一处失败在阻断用户之前，先分清 Agent 是真的坏了，还是只是我们的
 * 流程坏了。两条硬边界必须各有一条会变红的断言守住：第 2 类绝不静默放行；未知绝不当成好的。
 *
 * 判定的唯一公开入口是 `agentSessionServiceOutcome`（不为测试另开一条构造 outcome 的口子），
 * 因此下面的 outcome 全部由真实 Session 事实经这个入口得到。
 */

function agentSession(overrides: {
  state?: SessionSnapshot['status']['state']
  processState?: SessionSnapshot['processState']
  kind?: 'agent' | 'terminal'
  detail?: string
  terminalCapability?: Extract<SessionSnapshot, { kind: 'agent' }>['terminalCapability']
  terminalOutputChannel?: Extract<SessionSnapshot, { kind: 'agent' }>['terminalOutputChannel']
}): SessionSnapshot {
  return {
    id: 's',
    hostId: 'local',
    workspacePath: '/w',
    label: 'a',
    createdAt: 0,
    updatedAt: 0,
    processState: overrides.processState ?? 'running',
    kind: overrides.kind ?? 'agent',
    providerId: 'claude',
    executorId: 'claude-code',
    capabilities: {},
    ...(overrides.terminalCapability ? { terminalCapability: overrides.terminalCapability } : {}),
    ...(overrides.terminalOutputChannel ? { terminalOutputChannel: overrides.terminalOutputChannel } : {}),
    status: {
      state: overrides.state ?? 'working',
      source: 'run-process',
      observedAt: 0,
      ...(overrides.detail ? { detail: overrides.detail } : {})
    },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: 's', run: { runId: 'r', hostId: 'local' } }
  } as unknown as SessionSnapshot
}

const handshakeDegraded = agentSession({
  state: 'working',
  terminalCapability: {
    state: 'unknown',
    mode: 'degraded',
    reason: 'handshake-timeout',
    run: { runId: 'r', hostId: 'local' },
    observedAt: 10
  }
})

/** 断连但存活 = 第 2 类（我们的流程坏了）。 */
const aliveButDisconnected = agentSession({ state: 'disconnected', processState: 'running' })
/** 断连且退出 = 第 1 类（Agent 真的坏了）。 */
const deadAndDisconnected = agentSession({ state: 'disconnected', processState: 'exited' })
/** 断连、进程既非在跑也非退出 = 分不清。 */
const indeterminate = agentSession({ state: 'disconnected', processState: 'interrupted' })

describe('把一处失败分成四类', () => {
  it('步骤走通了就是完全好的——不打扰', () => {
    const outcome = agentSessionServiceOutcome(agentSession({ state: 'working' }))
    expect(classifyServiceNotice(outcome)).toEqual({ kind: 'healthy' })
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))).toBeNull()
  })

  it('Agent 死了是完全坏了——服务窗不接手，阻断由恢复横幅承载', () => {
    const classification = classifyServiceNotice(agentSessionServiceOutcome(deadAndDisconnected))
    expect(classification.kind).toBe('agent-broken')
    // 完全坏了不渲染服务窗：一个死掉的 Agent，阻断本身就是诚实的。
    expect(serviceNoticeToRender(classification)).toBeNull()
  })

  it('Agent 活着但我们的流程坏了——放行，且绝不静默', () => {
    // 这是原则的样板。第 2 类必须能被看见：拿到一条带三段文案的 notice，而不是 null。
    const classification = classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected))
    expect(classification.kind).toBe('process-degraded')
    const rendered = serviceNoticeToRender(classification)
    // 边界一：第 2 类绝不静默放行。这条断言在「alive 也返回 null / healthy」时变红。
    expect(rendered).not.toBeNull()
    expect(rendered!.notice.step).toContain('Reconnecting to this Agent')
    expect(rendered!.notice.mode).toContain('still running')
    expect(rendered!.notice.restore).toContain('Resume')
  })

  it('分不清是哪一类——如实说分不清，不猜一个再照着做', () => {
    const classification = classifyServiceNotice(agentSessionServiceOutcome(indeterminate))
    // 边界二：未知绝不当成好的。这条在「unknown 被折进 healthy / 被当成 alive」时变红。
    expect(classification.kind).toBe('indeterminate')
    const rendered = serviceNoticeToRender(classification)
    expect(rendered).not.toBeNull()
    // 现在按什么状态在跑要如实说「分不清、但你没被阻断」，不冒充「一切正常」。
    expect(rendered!.notice.mode).toContain('can’t confirm')
    // 未知与完全好的必须分得开——这正是原则「不许把未知当成好的」。
    expect(classification.kind).not.toBe('healthy')
  })

  it('三段文案齐全：哪一步、什么状态、怎么恢复', () => {
    // 服务窗要说清的就是这三件事，缺一段都不算说清。
    for (const session of [aliveButDisconnected, indeterminate]) {
      const rendered = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(session)))!
      expect(rendered.notice.step.length).toBeGreaterThan(0)
      expect(rendered.notice.mode.length).toBeGreaterThan(0)
      expect(rendered.notice.restore.length).toBeGreaterThan(0)
    }
  })

  it('第 2 类与分不清的「当前状态」措辞不同——不拿降级文案冒充分不清', () => {
    const degraded = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected)))!
    const unknown = serviceNoticeToRender(classifyServiceNotice(agentSessionServiceOutcome(indeterminate)))!
    // 分不清不能宣称「进程还在跑」——那正是它分不清的那件事。
    expect(unknown.notice.mode).not.toBe(degraded.notice.mode)
    expect(unknown.notice.mode).not.toContain('still running')
  })
})

describe('把一个 Agent Session 映成步骤结局：看进程，不看我们的连接', () => {
  it('Core 的握手超时事实即使 status 仍是 working 也必须显示服务窗', () => {
    const outcome = agentSessionServiceOutcome(handshakeDegraded)
    const rendered = serviceNoticeToRender(classifyServiceNotice(outcome))
    expect(classifyServiceNotice(outcome).kind).toBe('process-degraded')
    expect(rendered?.notice.step).toContain('terminal capabilities')
    expect(rendered?.notice.mode).toContain('prompts remain available')
    expect(rendered?.notice.restore).toContain('retry')
  })

  it('非 Agent Session 没有服务窗', () => {
    expect(agentSessionServiceOutcome(agentSession({ kind: 'terminal' }))).toEqual({ completed: true })
    expect(agentSessionServiceOutcome(undefined)).toEqual({ completed: true })
  })

  it('没报 disconnected 的 Agent 走通了——不打扰', () => {
    expect(agentSessionServiceOutcome(agentSession({ state: 'working' }))).toEqual({ completed: true })
  })

  it('连接断了但进程在跑 = 第 2 类：我们的流程坏了，Agent 没坏', () => {
    // 判据是「Agent 还能干活吗」（进程在跑），不是「我们的连接过了吗」（连接断了）。
    const outcome = agentSessionServiceOutcome(aliveButDisconnected)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'alive' })
    // 端到端：一个断连但存活的 Agent 落成一条会渲染的服务窗，而不是被静默或被阻断。
    expect(serviceNoticeToRender(classifyServiceNotice(outcome))?.kind).toBe('process-degraded')
  })

  it('连接断了且进程退了 = 第 1 类：Agent 真的坏了', () => {
    const outcome = agentSessionServiceOutcome(deadAndDisconnected)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'dead' })
    expect(classifyServiceNotice(outcome).kind).toBe('agent-broken')
  })

  it('连接断了、进程既非在跑也非退出（interrupted）= 分不清', () => {
    // interrupted 是「不知道」而不是「坏了」：没有证据说进程死了，也没有证据说它好着。
    const outcome = agentSessionServiceOutcome(indeterminate)
    expect(outcome).toMatchObject({ completed: false, agentViability: 'unknown' })
    expect(classifyServiceNotice(outcome).kind).toBe('indeterminate')
  })
})

// ---------------------------------------------------------------------------
// 输出通道断了、进程没死（T-002）。
//
// 缺陷形状：重连成功、进程仍在跑，但这一屏到该 Run 的实时输出泵没能重建（core 的 `resumed==='dead'`）。
// 放行是对的——输入照常送达 Agent（原则 11 第 2 类），可它的输出永远到不了这块屏。此前我们放行却什么都
// 不说，用户对着一块永不回显的屏幕打字。Core 落一条 `terminalOutputChannel` 降级事实，这里把它投影成
// 一条服务窗。判据取 T-001 收敛后的那一处 `agentViabilityFromProcessState`，不新增第五份三分类。
// ---------------------------------------------------------------------------

/** 输出通道断了，但进程还在跑。 */
const outputChannelSevered = agentSession({
  state: 'working',
  processState: 'running',
  terminalOutputChannel: {
    state: 'severed',
    mode: 'degraded',
    reason: 'reattach-failed',
    run: { runId: 'r' },
    observedAt: 20
  }
})

describe('输出通道断了、进程没死：放行必须配告知', () => {
  it('落成一条会渲染的服务窗——进程在跑就是第 2 类，放行 + 提醒', () => {
    // 承重条：Core 发布这条事实后，Activity 视图必须显示服务窗，而不是一块沉默的屏幕。
    // 删掉 core 里 `publishOutputChannelSevered` 那一发（事实永不到达），或删掉这里 lib 对它的投影，都让它红。
    const outcome = agentSessionServiceOutcome(outputChannelSevered)
    const classification = classifyServiceNotice(outcome)
    expect(classification.kind).toBe('process-degraded')
    const rendered = serviceNoticeToRender(classification)
    expect(rendered).not.toBeNull()
    // 三段文案要点名「输出可能没在显示」「输入仍到达 Agent」「Resume 重新附着」——正是用户此刻需要的判断。
    expect(rendered!.notice.mode).toContain('Output may not be showing')
    expect(rendered!.notice.mode).toContain('input still reaches the Agent')
    expect(rendered!.notice.restore).toContain('Resume')
  })

  it('权威事实压过推断的 disconnected：即使 status 仍是 working 也要显示', () => {
    // 这条事实比推断的连接状态强——它说的正是「重连成功了、只有这一个 Run 的输出泵没接上」。
    // 所以判定不挂在 status.state 上（这里 status 是 working），而是直接读 Core 落下的标记。
    expect(outputChannelSevered.status.state).not.toBe('disconnected')
    expect(classifyServiceNotice(agentSessionServiceOutcome(outputChannelSevered)).kind).toBe('process-degraded')
  })

  it('进程退了就交给恢复横幅——输出通道事实不许把死掉的 Agent 画成「还能用」', () => {
    // 判据是「Agent 还能干活吗」（进程），不是「有没有这条标记」：进程退了是第 1 类，服务窗不接手。
    const exited = agentSession({
      state: 'working',
      processState: 'exited',
      terminalOutputChannel: {
        state: 'severed',
        mode: 'degraded',
        reason: 'reattach-failed',
        run: { runId: 'r' },
        observedAt: 20
      }
    })
    expect(classifyServiceNotice(agentSessionServiceOutcome(exited)).kind).toBe('agent-broken')
  })
})

// ---------------------------------------------------------------------------
// 失联的两类：还在重连 vs 已经放弃。
//
// 缺陷形状：恢复横幅（terminal 视图）早就分了这两类，但**只在终端分支里**——Agent 在 Activity
// （对话）视图下唯一可见的失联文案就是这条服务窗，而它此前完全不读 `status.detail`。于是抖动预算
// 用尽后的终局在对话视图下一直说「Reconnecting to this Agent」+「Resume the session to reattach」，
// 用户以为等一会儿就好，实际上没有任何东西在重试。
//
// 判据取自 `status.detail` 那对 SSOT 常量（连接投影唯一的写入点），不是另起一个状态位：状态位就是
// `disconnected`，两类共用它。
// ---------------------------------------------------------------------------

/** 抖动预算用尽、自动重连已放弃，但进程还在跑。 */
const gaveUpButAlive = agentSession({
  state: 'disconnected',
  processState: 'running',
  detail: CONNECTION_UNRECOVERABLE_DETAIL
})
/** 还在重连（detail 写的是另一条常量）。 */
const retryingAndAlive = agentSession({
  state: 'disconnected',
  processState: 'running',
  detail: CONNECTION_LOST_DETAIL
})

describe('失联的两类文案（Activity 视图下唯一的失联出口）', () => {
  it('放弃重连后不再说「Reconnecting」——终局不许顶着暂时的皮', () => {
    // 这是本条的样板。把判据从 detail 上摘掉（两类共用同一份文案）时它变红。
    const rendered = serviceNoticeToRender(
      classifyServiceNotice(agentSessionServiceOutcome(gaveUpButAlive))
    )!
    expect(rendered.notice.step).not.toContain('Reconnecting')
    // 且必须说清「等不会好」——否则用户读不出该自己动手。
    expect(rendered.notice.mode.toLowerCase()).toContain('waiting')
  })

  it('还在重连时照旧说「Reconnecting」——不许把暂时说成终局', () => {
    // 反向那一侧。若实现宽到「disconnected 一律说已放弃」，上面那条仍绿而一次正常抖动会被
    // 说成判死，用户白白手动重开。
    const rendered = serviceNoticeToRender(
      classifyServiceNotice(agentSessionServiceOutcome(retryingAndAlive))
    )!
    expect(rendered.notice.step).toContain('Reconnecting')
    expect(rendered.notice.mode).toContain('still running')
  })

  it('终局不许带上「重连中」那句话的安慰词——措辞近似就等于没分类', () => {
    // 本仓栽过「not.toBe 逐字不等仍可能同一句话要求两件相反的事」。但「实词无交集」是错的判据：
    // 两句话**本来就在说同一个东西**（link），共用主语名词是应该的。真正不许共用的是让人读出
    // 「等着就好」的那几个进行时——它们正是「还在重连」那条的全部安慰。
    const REASSURANCES = ['still running', 'reconnecting', 'retrying']
    const gaveUp = serviceNoticeToRender(
      classifyServiceNotice(agentSessionServiceOutcome(gaveUpButAlive))
    )!
    const retrying = serviceNoticeToRender(
      classifyServiceNotice(agentSessionServiceOutcome(retryingAndAlive))
    )!
    const gaveUpText = `${gaveUp.notice.step} ${gaveUp.notice.mode}`.toLowerCase()
    const retryingText = `${retrying.notice.step} ${retrying.notice.mode}`.toLowerCase()

    // 自检：这张清单不是为了让断言通过而挑的词——它必须真的是「还在重连」那条在用的措辞。
    // 若哪天那条改了词，这里先红，提醒把清单跟上，而不是让下面的检查变成恒真。
    expect(
      REASSURANCES.filter((phrase) => retryingText.includes(phrase)),
      '判据失效了：清单里没有一个词是「还在重连」那条真在用的'
    ).not.toEqual([])

    expect(REASSURANCES.filter((phrase) => gaveUpText.includes(phrase))).toEqual([])
    // 且两句话不能逐字相同（上面那条挡不住「两边都不带安慰词」的退化写法）。
    expect(gaveUp.notice.mode).not.toBe(retrying.notice.mode)
  })

  it('放弃之后仍是第 2 类（放行 + 提醒），不是阻断', () => {
    // 放弃的是**我们的连接**，不是 Agent：进程还在跑，所以照旧不阻断。若这里退化成 agent-broken，
    // 服务窗会整条消失（agent-broken 不渲染），而 Activity 视图没有横幅接手 —— 用户回到彻底静默。
    const classification = classifyServiceNotice(agentSessionServiceOutcome(gaveUpButAlive))
    expect(classification.kind).toBe('process-degraded')
    expect(serviceNoticeToRender(classification)).not.toBeNull()
  })

  it('放弃且进程也退了仍是第 1 类——detail 不许盖过进程事实', () => {
    // 判据的优先级：Agent 还能不能干活（进程）永远压过「我们的连接怎么了」（detail）。
    const outcome = agentSessionServiceOutcome(
      agentSession({
        state: 'disconnected',
        processState: 'exited',
        detail: CONNECTION_UNRECOVERABLE_DETAIL
      })
    )
    expect(classifyServiceNotice(outcome).kind).toBe('agent-broken')
  })

  it('detail 缺席时按「还在重连」讲——缺席不等于放弃', () => {
    // 老快照、非连接来源的 disconnected 都可能没有 detail。把缺席读成放弃，会让一次普通断连
    // 直接劝用户动手。
    const rendered = serviceNoticeToRender(
      classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected))
    )!
    expect(rendered.notice.step).toContain('Reconnecting')
  })

  it('判据引用 SSOT 常量而不是手抄那句话', () => {
    // 手抄的那份必然漂移：连接投影改一个字，这条判定就静默退回「一律说重连」。所以钉 import 关系。
    const source = readFileSync(
      new URL('../src/renderer/src/lib/service-window-notice.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain('CONNECTION_UNRECOVERABLE_DETAIL')
    expect(source).toContain("from './session-state'")
    // 自检：别让上面两条被一句注释满足。判据必须真的参与比较。
    expect(source).toContain('=== CONNECTION_UNRECOVERABLE_DETAIL')
  })
})

// ---------------------------------------------------------------------------
// 通报的音量：由分类派生，降级轻声、dead 才刺眼（T-003，需求池 f-25h8fysz9）。
//
// 缺陷形状：此前所有通报一律用第 1 类的音量（assertive）说出来，第 2 类的降级也被喊成「Agent 完了」，
// 用户学会忽略它，告知就失效了。修法是把音量做成分类的**派生值**——kind 已 1:1 承载存活判定，
// 直接按 kind 映射就是「由 agentViability 推导」，不另起第二个枚举、不由调用点各自挑。
//
// 这里钉住的是**具体档位对应关系**（alive/unknown→polite、dead→assertive），不是「每个档位都被映射到了」——
// 后者在映射改窄（比如把 dead 也改成 polite）时仍会全绿。
// ---------------------------------------------------------------------------
describe('通报音量随存活判定分档', () => {
  it('第 2 类（alive，我们的流程坏了）用克制的 polite 说——降级不该喊狼来了', () => {
    // 端到端：一个断连但存活的 Agent，其分类音量必须是 polite。改成 assertive 时这条变红。
    const kind = classifyServiceNotice(agentSessionServiceOutcome(aliveButDisconnected)).kind
    expect(kind).toBe('process-degraded')
    expect(serviceNoticeAriaLive(kind)).toBe('polite')
  })

  it('分不清（unknown）也用 polite——如实标注不确定，不就高也不就低', () => {
    const kind = classifyServiceNotice(agentSessionServiceOutcome(indeterminate)).kind
    expect(kind).toBe('indeterminate')
    expect(serviceNoticeAriaLive(kind)).toBe('polite')
  })

  it('第 1 类（dead，Agent 真没了）才 assertive——只有需要打断的那一档刺眼', () => {
    const kind = classifyServiceNotice(agentSessionServiceOutcome(deadAndDisconnected)).kind
    expect(kind).toBe('agent-broken')
    expect(serviceNoticeAriaLive(kind)).toBe('assertive')
  })

  it('dead 与降级/分不清不同档——否则「轻声说」就没发生', () => {
    // 挡住「一律 assertive」（原缺陷）与「一律 polite」（矫枉过正）两种退化：dead 必须比另两档响。
    const degraded = serviceNoticeAriaLive('process-degraded')
    const unknown = serviceNoticeAriaLive('indeterminate')
    const dead = serviceNoticeAriaLive('agent-broken')
    expect(dead).not.toBe(degraded)
    expect(dead).not.toBe(unknown)
  })
})
