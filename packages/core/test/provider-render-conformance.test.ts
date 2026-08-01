import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'

// ---------------------------------------------------------------------------
// 「Provider 声明 = 测试合同」的第一条可执行纵切：Codex 的 recorded-PTY prompt-render conformance。
//
// 此前这条轴的覆盖是断开的两半，中间没人接：
//   1. `agent-provider.test.ts:299` 断言 codex 声明的三个 marker 字面量——那份期望是**手抄的**，
//      改坏声明和改坏断言是同一处知识，等于自证。
//   2. `fixtures/fake-codex-cli.mjs` 真的发出那些序列，但它自己也是手写常量，与声明各写一遍。
// 于是「声明的 marker 真的能在这个 Provider 的 PTY 输出里定位到 composer」从来没被执行过。
//
// **这里的关键是锚点必须独立于声明。** 我第一版把 transcript 用声明的 marker 合成，实测两个变异
// 存活：把 codex 的 `activeComposer` 从 '›' 换成 '>'、把 frameStart/frameEnd 对调，六条全绿——
// 因为 transcript 跟着声明一起变，自洽所以恒真。那是把「等于自证」从断言搬到了 fixture 里。
//
// 所以下面的 RECORDED 是**固定的录制字节**，形状照 fake-codex-cli.mjs 真实发出的那些帧（含 SGR
// 上色、逐字符写入、`[K` 擦除、第 5 行的历史回显），marker 在里面是写死的 '›' 和
// `?2026h/l`。声明只被用来**查询**这段录制。声明一改，查询就对不上录制，测试红。
//
// 断言形态遵循 T-005 的纪律：来自匹配结果而非手写清单，且 `toBeGreaterThan(0)` 挡住空集取胜。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

async function feed(screen: AgentTerminalScreen, data: string): Promise<void> {
  const dataBytes = encoder.encode(data)
  await screen.write({
    startByte: screen.throughByte,
    endByte: screen.throughByte + dataBytes.byteLength,
    dataBytes
  })
}

/**
 * Codex TUI 真实发出的几帧，逐字节录制，**不引用任何 Provider 声明**。
 *
 * 形状取自 `test/fixtures/fake-codex-cli.mjs`（`writeReadyFrame` / `writeComposerFrame` /
 * `writeAssistantMarkerWithoutComposer` / `writeComposerNearMiss`）：composer 提示符是 U+203A '›'
 * 在第 22 行，同步更新用 `?2026h`/`?2026l` 包裹，正文渲染在第 5 行。这里保留了 SGR 上色与逐字符
 * 写入——真实 TUI 不会把一个词一次写完，而屏幕必须把它们拼回同一个词。
 */
const RECORDED = {
  /** 就绪帧：composer 空，提示符加粗，光标停在输入位。 */
  ready:
    '[?2026h[22;1H[1m›[0m [K[22;3H[?25h[?2026l',
  /** 渲染帧：把 '/exit' 逐字符上色写进 composer——分色写入是真实形状，不是简化。 */
  typedExit:
    '[?2026h[22;3H' +
    '[32m/[0m[36me[0m[32mx[0m[36mi[0m[32mt[0m' +
    '[K[?2026l',
  /** 助手正文里出现同一个提示符：第 5 行不是 composer，绝不能被当成 composer。 */
  assistantMarkerOnly:
    '[2J[5;1H› assistant text only[22;1Hstatus[22;7H',
  /** near-miss：提示符后**没有空格**，紧跟内容——真实 TUI 的 composer 行不长这样。 */
  nearMiss: '[?2026h›/·e·x·i·t[?2026l'
} as const

/** 录制里 composer 真正含有的那段文本——录制侧的事实，与声明无关。 */
const RECORDED_TYPED = '/exit'

const registry = new AgentProviderRegistry()
const codex = registry.get('codex')

describe('Codex recorded-PTY prompt-render conformance', () => {
  it('codex 声明了终端渲染合同——否则下面每条都在 undefined 上取胜', () => {
    // T-005 明确要的那把尺：断言依赖声明存在时，声明缺席会让后面每条静默失去被测对象。
    expect(codex.terminalPromptRender).toBeDefined()
    // 且配套的提交计划必须是 render-then-submit：先渲染、验证、再提交。没有它，这条轴不可执行。
    expect(codex.planPromptInput('probe').kind).toBe('render-then-submit')
  })

  it('声明的 marker 能在录制的就绪帧里定位到空 composer', async () => {
    const matcher = codex.terminalPromptRender!
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED.ready)
      // 定位到了 composer 且它是空串——不是 null（marker 对不上录制就是 null）。
      expect(screen.composerText(matcher.activeComposer)).toBe('')
    } finally {
      screen.dispose()
    }
  })

  it('声明的 marker 在录制的渲染帧里读出那段真实文本，逐字符上色也拼得回来', async () => {
    const matcher = codex.terminalPromptRender!
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED.ready)
      await feed(screen, RECORDED.typedExit)
      // 这是提交验证真正等的那一刻。录制里是分色逐字符写的，屏幕必须拼回同一个词。
      expect(screen.composerText(matcher.activeComposer)).toBe(RECORDED_TYPED)
    } finally {
      screen.dispose()
    }
  })

  it('声明的帧边界真的框住那次同步更新——边界反了就框不住', async () => {
    // frameStart/frameEnd 对调是复制粘贴最常见的错，而它改不了"最终屏幕内容"，所以只看
    // composerText 抓不到。这里直接验声明的两个序列在录制里的**出现顺序**：start 必须先于 end。
    const { frameStart, frameEnd } = codex.terminalPromptRender!
    for (const frame of [RECORDED.ready, RECORDED.typedExit]) {
      const startAt = frame.indexOf(frameStart)
      const endAt = frame.indexOf(frameEnd)
      // 两个序列都必须真的出现在录制里——声明改成别的序列，这里就是 -1。
      expect(startAt).toBeGreaterThanOrEqual(0)
      expect(endAt).toBeGreaterThanOrEqual(0)
      // 且顺序不许反：一帧是 start…end，不是 end…start。
      expect(startAt).toBeLessThan(endAt)
    }
  })

  it('助手正文里的同一个提示符不算 composer——否则提交验证会对着回显自我确认', async () => {
    // 这条合同最容易错的一侧：提示符只是个普通字符，正文里必然出现。把它当 composer，提交验证
    // 就会在 Agent 回显用户输入的那一刻宣布"渲染成功"，而真正的 composer 可能还是空的。
    const matcher = codex.terminalPromptRender!
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED.assistantMarkerOnly)
      expect(screen.composerText(matcher.activeComposer)).toBeNull()
    } finally {
      screen.dispose()
    }
  })

  it('提示符后不带空格的 near-miss 不被读成那段文本', async () => {
    const matcher = codex.terminalPromptRender!
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED.ready)
      await feed(screen, RECORDED.nearMiss)
      // 关键是它**不等于**真实输入：near-miss 若被读成 '/exit'，一次没送达的提交会被判成已送达。
      expect(screen.composerText(matcher.activeComposer)).not.toBe(RECORDED_TYPED)
    } finally {
      screen.dispose()
    }
  })

  it('提交计划的 renderedText 与录制里屏幕真正显示的那串同源', async () => {
    // plan 和 matcher 各自绿仍可能对不上——那正是提交验证一直等到超时的形状。这里让 plan 给出
    // 录制里那段输入的 renderedText，再断言它就是屏幕上读到的那串。
    const matcher = codex.terminalPromptRender!
    const plan = codex.planPromptInput(RECORDED_TYPED)
    expect(plan.kind).toBe('render-then-submit')
    if (plan.kind !== 'render-then-submit') return
    // renderedText 是屏幕上会出现的样子；payload 是传输字节（括号粘贴、转义替换只改 payload）。
    // 谓词比的是 renderedText，所以它必须与录制里读出的那串一致。
    expect(plan.renderedText).toBe(RECORDED_TYPED)
    expect(plan.submit.length).toBeGreaterThan(0)

    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED.ready)
      await feed(screen, RECORDED.typedExit)
      expect(screen.composerText(matcher.activeComposer)).toBe(plan.renderedText)
    } finally {
      screen.dispose()
    }
  })

  it('渲染合同的三段互不相同且非空——任何一段塌成空串都让谓词失去锚点', () => {
    // frameStart/frameEnd 空 → 帧边界失效，任何部分输出都被当成完整帧；
    // activeComposer 空 → composerText 的定位没有锚点。
    const { frameStart, activeComposer, frameEnd } = codex.terminalPromptRender!
    for (const part of [frameStart, activeComposer, frameEnd]) {
      expect(part.length).toBeGreaterThan(0)
    }
    expect(new Set([frameStart, activeComposer, frameEnd]).size).toBe(3)
  })

  it('这条 harness 对其余声明了渲染合同的 Provider 同样可入口——不为它们伪造通过', () => {
    // 为 Claude 第二接入留同一个入口：列出所有声明了合同的 Provider，逐个验声明**自洽**
    // （三段非空互异 + 配套 render-then-submit）。但**不**为它们断言录制匹配——上面那段录制是
    // Codex 的 PTY，拿它去证别的 Provider 就是伪造证据。它们各自的录制要各自补。
    const declared = registry.list().filter((provider) => provider.terminalPromptRender)
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.map((provider) => provider.id)).toContain('codex')
    for (const provider of declared) {
      const { frameStart, activeComposer, frameEnd } = provider.terminalPromptRender!
      expect(new Set([frameStart, activeComposer, frameEnd]).size).toBe(3)
      expect(provider.planPromptInput('probe').kind).toBe('render-then-submit')
    }
  })
})
