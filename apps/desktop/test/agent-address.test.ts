import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENTMUX_CONTROL_ERROR_CODES } from '@agentmux/core/control'
import type { DesktopControlResponse } from '../src/shared/contracts.js'
import {
  addressingRecovery,
  formatMessagingAddress,
  formatRegionAddress,
  formatSessionAddress,
  formatViewAddress
} from '../src/renderer/src/lib/agent-address.js'

// 复制出去的是一个寻址方式，不是一个 id。判据只有一条：接收方仅凭这段文本，
// 能不能不问人、不查文档就完成寻址。因此每条断言都在问"这段文本自足吗"，
// 而不是"字符串长得对不对"。

// CLI 真实语法（见 packages/core/src/agentmux.ts 的 verb 分发）：
//   - inspect 必须恰好带一个选择器 flag；
//   - send 除了选择器，**还必须带 `--text`**——`requiredData(flags, '--text', 'Message text')`，
//     少了它是 INVALID_CLI_ARGUMENT（实跑确认："Message text is required."）；
//   - list 必须带 agents 或 sessions 子命令。
// send 与 inspect 不能共用一条形状：合写成 `(?:send|inspect)` 会让漏掉 `--text` 的 send 照样匹配，
// 和本轮修掉的裸 inspect 是同一个洞——断言的粒度比它要防的 bug 更粗，于是分不清能跑与不能跑。
// 选择器的值用 `\S.*` 而不是 `\S+`：id 经 shell 转义后合法地含空格（`'a'"'"'b c'`），
// `\S+` 会在第一个空格处断掉，把一条真能跑的命令误判为跑不了。
const RUNNABLE: readonly RegExp[] = [
  /^agentmux send --to-(?:session|region|tab)=\S.* --text ./u,
  /^agentmux inspect --(?:session|region|tab|run|provider-native|acp-native)=\S/u,
  /^agentmux list (?:agents|sessions)$/u
]

/** 恢复文本里那条"列出活着的 Agent"的命令。是 sessions 不是 agents——后者列的是配好的 executor 类型。 */
const LIST_SESSIONS_COMMAND = 'agentmux list sessions'

/** 一段文本里每一行 `agentmux …` 都必须能跑；返回检查过的行数，供调用方防"一行都没检查"。 */function assertEveryCommandRunnable(text: string, where: string): number {
  let seen = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith('agentmux')) continue
    seen += 1
    expect(RUNNABLE.some((shape) => shape.test(line)), `跑不了的命令：${where} → ${line}`).toBe(true)
  }
  return seen
}

describe('Session 地址：哪个 Agent', () => {
  const address = formatSessionAddress('agent-7')

  it('说清目标是哪一层身份，而不是甩一个裸 id', () => {
    expect(address).toContain('agent-7')
    expect(address).toMatch(/Session/u)
  })

  it('给出可直接执行的命令，用既有 flag', () => {
    expect(address).toContain("agentmux send --to-session='agent-7'")
    expect(address).toContain("agentmux inspect --session='agent-7'")
  })
})

describe('Region 地址：屏幕上哪一格', () => {
  const address = formatRegionAddress('region:pane-2')

  it('给出 --to-region 命令', () => {
    expect(address).toContain("agentmux send --to-region='region:pane-2'")
    expect(address).toContain("agentmux inspect --region='region:pane-2'")
  })

  it('说明它在分屏下无歧义地指向那一格', () => {
    // 这正是 Region 地址存在的理由：Tab 地址在多 Agent 时有歧义，它没有。
    expect(address).toMatch(/split|Region/u)
    expect(address.toLowerCase()).toContain('unambiguous')
  })
})

describe('View 地址：哪张完整工作面', () => {
  const address = formatViewAddress('view:abc')

  it('给出 --to-tab 命令', () => {
    expect(address).toContain("agentmux send --to-tab='view:abc'")
    expect(address).toContain("agentmux inspect --tab='view:abc'")
  })

  it('如实声明它只在该 View 承载唯一 Agent 时可用于 Agent 寻址', () => {
    expect(address.toLowerCase()).toContain('exactly one')
  })

  it('多 Agent 时引导用 Region 地址，而不是把消歧甩给接收方', () => {
    // 旧 handoff 让接收方先 inspect、撞了 MESSAGE_TARGET_NOT_UNIQUE 再自己挑 candidate。
    // 歧义只在源头可见——复制时我们知道用户点的是哪一格，接收方不知道。
    expect(address).toMatch(/Region/u)
    expect(address).not.toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(address).not.toContain('candidates')
  })
})

describe('shell 转义：粘贴即可执行', () => {
  it('复制出的三级地址，每一行命令都真能跑', () => {
    // 恢复侧早有这条，复制侧一直没有——而"粘贴即可执行"本就是复制这件事的全部意义。
    // 缺口是实测撞出来的：把命令出口的 `--text` 改名，只有 tab-control-handoff.test.ts 里
    // 一条断言变红，本文件三个地址 describe 纹丝不动；它们只 toContain 到 id 就收手了。
    let seen = 0
    for (const [where, address] of [
      ['session', formatSessionAddress("a'b c")],
      ['region', formatRegionAddress("a'b c")],
      ['view', formatViewAddress("a'b c")]
    ] as const) {
      seen += assertEveryCommandRunnable(address, where)
    }
    // 每个地址至少一条 send、一条 inspect。少于 6 说明扫描本身漏了，不是命令都合格。
    expect(seen).toBeGreaterThanOrEqual(6)
  })

  it('转义带单引号与空格的 id', () => {
    const address = formatSessionAddress("--evil id$'quoted")
    expect(address).toContain(`--to-session='--evil id$'"'"'quoted'`)
  })

  it('三级地址用同一套转义', () => {
    const nasty = "a'b c"
    expect(formatRegionAddress(nasty)).toContain(`--to-region='a'"'"'b c'`)
    expect(formatViewAddress(nasty)).toContain(`--to-tab='a'"'"'b c'`)
  })
})

describe('交接入口：按意图命名，替用户解析出最精确的地址', () => {
  // 用户想的是"把这个 Agent 交给别人"，不是"我要 Region 还是 Session"。解析顺序只有一条规则：
  // 指向某一格分屏时给 Region，目标唯一时给 Session。两条分支都要有断言。

  it('指向某一格分屏时给 Region 地址——消歧做在源头', () => {
    const handoff = formatMessagingAddress({ agentSessionId: 'agent-7', regionId: 'region:pane-2' })
    expect(handoff).toBe(formatRegionAddress('region:pane-2'))
    expect(handoff).toContain("agentmux send --to-region='region:pane-2'")
    // 点击发生在那一格上，此时给 Session 就是把"是哪一格"这个我们已知、接收方未知的信息丢掉。
    expect(handoff).not.toContain('--to-session')
  })

  it('没有那一格时给 Session 地址——它跨 View 稳定', () => {
    const handoff = formatMessagingAddress({ agentSessionId: 'agent-7' })
    expect(handoff).toBe(formatSessionAddress('agent-7'))
    expect(handoff).toContain("agentmux send --to-session='agent-7'")
    expect(handoff).not.toContain('--to-region')
  })

  it('同一 Session 从交接入口与复制入口产出的地址逐字一致', () => {
    // 同一份真相的两个入口，不是两套格式。
    expect(formatMessagingAddress({ agentSessionId: "a'b" })).toBe(formatSessionAddress("a'b"))
  })
})

describe('寻址失败自带下一步命令，而不只是候选清单', () => {
  it('多 Agent：每个候选都给一条能直接跑的命令，不是让人自己拼', () => {
    const recovery = addressingRecovery({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [
        { agentSessionId: 'agent-a', regionIds: ['region:1'] },
        { agentSessionId: 'agent-b', regionIds: ['region:2'] }
      ]
    })
    // 有 Region 就用 Region：分屏下唯一无歧义的那一格。
    expect(recovery).toContain("agentmux send --to-region='region:1'")
    expect(recovery).toContain("agentmux send --to-region='region:2'")
    // 判据是"能不能直接跑"，所以必须是完整命令而不是裸 id。
    expect(recovery).not.toMatch(/^\s*region:1\s*$/mu)
  })

  it('一个 Agent 都没有，与"有多个"是不同的下一步', () => {
    const recovery = addressingRecovery({ code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates: [] })
    // 没有目标可挑，给出的必须是"怎么才能有一个"，而不是一份空清单。
    expect(recovery).not.toContain('agentmux send --to-')
    expect(recovery).toMatch(/没有 Agent/u)
  })

  it('stale View、目标不是 Agent、Agent 已退出各自有自己的恢复入口', () => {
    // 码取自真实抛出点：TAB_NOT_OPEN 见 lib/control.ts，UNKNOWN_AGENT_SESSION 见 store.ts。
    const notAgent = addressingRecovery({ code: 'MESSAGE_TARGET_NOT_AGENT' })
    const stale = addressingRecovery({ code: 'TAB_NOT_OPEN' })
    const gone = addressingRecovery({ code: 'UNKNOWN_AGENT_SESSION' })
    // 三种失败的原因不同，下一步也不该是同一句话——否则等于没有分类。
    expect(new Set([notAgent, stale, gone]).size).toBe(3)
    // REGION_NOT_OPEN 与 TAB_NOT_OPEN 是同一件事的两个粒度，共用一条下一步是有意的。
    expect(addressingRecovery({ code: 'REGION_NOT_OPEN' })).toBe(stale)
  })

  // 恢复文本里出现的每一行命令都必须真能跑。这条是本轮补的：原来那句
  // `expect(recovery).toContain('agentmux inspect')` 对**裸** `agentmux inspect` 同样为真，
  // 而裸 inspect 跑起来是 INVALID_CLI_ARGUMENT（"requires exactly one of --session/--run/…"）。
  // 断言分不清能跑与不能跑，于是三条恢复全是死路，测试却一直绿着。
  it('恢复里的每一行命令都真能跑，不是长得像命令', () => {
    const codes = [
      'MESSAGE_TARGET_NOT_UNIQUE',
      'MESSAGE_TARGET_NOT_AGENT',
      'UNKNOWN_AGENT_SESSION',
      'TAB_NOT_OPEN',
      'REGION_NOT_OPEN'
    ]
    let seen = 0
    for (const code of codes) {
      const recovery = addressingRecovery({
        code,
        candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1'] }]
      })
      seen += assertEveryCommandRunnable(recovery ?? '', code)
    }
    // 没有这条，把所有命令都删光也会绿——"一条都没检查"和"每条都合格"打印出来一样。
    expect(seen).toBeGreaterThanOrEqual(codes.length)
  })

  it('拿不到 id 的分支老实不给命令，而不是凑一条跑不了的', () => {
    // MESSAGE_TARGET_NOT_AGENT 想给的是 `inspect --region=<regionId>`——这个码只在 Region 分支
    // 抛（store.ts:1624，全仓仅此一处），但 regionId 在抛出点就丢了。
    // 此时凑一条命令形状的文字比不给更糟：看着像出路，粘过去撞第二次失败。
    const notAgent = addressingRecovery({ code: 'MESSAGE_TARGET_NOT_AGENT' })
    expect(notAgent).not.toMatch(/^agentmux (?:inspect|send)\s*$/mu)
    expect(notAgent).toMatch(/右键|界面/u)
  })

  it('"列出活着的 Agent"是 list sessions，不是 list agents', () => {
    // 两个子命令都能跑，所以上面那条"命令真能跑"对它们一视同仁——但 `list agents` 列的是配好的
    // executor 类型（codex / claude / …），不是此刻活着的 Session，答非所问。本轮 review 就
    // 在这里栽过一次：诊断对（裸 inspect 跑不了），开的药方错。所以单独钉住这一条。
    for (const code of ['UNKNOWN_AGENT_SESSION', 'TAB_NOT_OPEN', 'MESSAGE_TARGET_NOT_AGENT']) {
      const recovery = addressingRecovery({ code })
      expect(recovery).toContain('agentmux list sessions')
      expect(recovery).not.toContain('agentmux list agents')
    }
  })

  it('每个控制错误码都被显式分类过，新增码不能默默落进"没有下一步"', () => {
    // 本模块自称是"哪些码算寻址失败"的唯一权威。但 `return null` 兜底意味着：有人在 Core 加一个
    // 新的寻址失败码，这里什么都不做也照样绿——权威悄悄失守，而漂移那天没有测试会红。
    // 本轮实测就撞到了：AMBIGUOUS_REGION_TARGET / AMBIGUOUS_TAB_TARGET / CALLER_NOT_OPEN
    // 三个码抛在同一条 send/inspect 解析路径上（lib/control.ts:133-163），却都落进了兜底。
    //
    // 所以这条不断言"某某码有恢复"，而是断言**每个码都被想过**：要么在 WITH_RECOVERY 里，
    // 要么在 DELIBERATELY_SILENT 里。加了新码而两边都没列，这条就红——它逼人做一次选择，
    // 而不是让沉默成为默认值。
    const WITH_RECOVERY = new Set([
      'MESSAGE_TARGET_NOT_UNIQUE',
      'MESSAGE_TARGET_NOT_AGENT',
      'UNKNOWN_AGENT_SESSION',
      'TAB_NOT_OPEN',
      'REGION_NOT_OPEN',
      'AMBIGUOUS_TAB_TARGET',
      'AMBIGUOUS_REGION_TARGET',
      'CALLER_NOT_OPEN'
    ])
    // 这些不是寻址失败：传输层、生命周期、启动配置等。它们的原始 message 已经说清了原因，
    // 硬塞一句"下一步"只会盖住它。
    //
    // 必须**逐个列出**，不能写成 `CODES.filter(c => !WITH_RECOVERY.has(c))`。那样写是个恒等式：
    // 新码会被自动吸收进这一侧，下面的加法永远成立，这条测试就永远绿。本轮初版正是这么写的，
    // 变异（往码表塞一个没分类的码）照样通过——守卫自己成了假绿的第七种形态。
    const DELIBERATELY_SILENT = [
      'INVALID_CONTROL_REQUEST',
      'CONTROL_PROTOCOL_ERROR',
      'CONTROL_TIMEOUT',
      'CONTROL_UNAVAILABLE',
      'CONTROL_OWNER_BUSY',
      'CONTROL_FAILED',
      'CONTROL_CANCELLED',
      'CONTROL_REQUEST_CONFLICT',
      'CONTROL_OWNER_LOST',
      'AGENT_EXECUTOR_NOT_CONFIGURED',
      'SESSION_CLOSING',
      'SESSION_NOT_RUNNING',
      'UNKNOWN_WORKSPACE',
      'REGION_WORKSPACE_MISMATCH',
      'REGION_TOPIC_MISMATCH',
      'LAUNCH_RESULT_MISMATCH',
      'LAUNCH_CLEANUP_FAILED',
      'LAYOUT_CAPACITY_EXCEEDED',
      'LAUNCHER_REGION_REQUIRED',
      'AGENT_NOT_FOUND',
      'INVALID_AGENT_PROMPT',
      'AGENT_SESSION_STILL_RUNNING',
      'AGENT_RESUME_UNAVAILABLE',
      'AGENT_RESUME_UNSUPPORTED',
      'STALE_AGENT_SESSION',
      'STALE_AGENT_SESSION_BINDING',
      'CTXMUX_DISCONNECTED',
      'CTXMUX_INPUT_CURSOR_MISSING',
      'SIGNAL_UNSUPPORTED'
    ]

    for (const code of AGENTMUX_CONTROL_ERROR_CODES) {
      const recovery = addressingRecovery({
        code,
        candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1'] }]
      })
      if (WITH_RECOVERY.has(code)) {
        expect(recovery, `${code} 该有下一步，却是 null`).not.toBeNull()
        assertEveryCommandRunnable(recovery!, code)
      } else {
        expect(recovery, `${code} 不该有下一步，却给了一句：${recovery}`).toBeNull()
      }
    }
    // 防这条自己假绿：两份名单合起来必须与码表**逐个相等**。比个数不够——一个新码顶掉一个
    // 被删的码，个数照样对得上。所以两个方向都要查：码表里有而两边都没列的（新码没分类），
    // 以及名单里有而码表里没有的（臆造码，会把个数凑平）。
    const classified = new Set([...WITH_RECOVERY, ...DELIBERATELY_SILENT])
    const unclassified = AGENTMUX_CONTROL_ERROR_CODES.filter((code) => !classified.has(code))
    expect(unclassified, `这些码没被分类，请在 WITH_RECOVERY 或 DELIBERATELY_SILENT 里做个决定：\n${unclassified.join('\n')}`).toEqual([])
    const invented = [...classified].filter((code) => !(AGENTMUX_CONTROL_ERROR_CODES as readonly string[]).includes(code))
    expect(invented, `这些码不在 Core 码表里，删掉：\n${invented.join('\n')}`).toEqual([])
    // 两边都非空，否则"全给恢复"或"全不给"也能满足上面两条。
    expect(WITH_RECOVERY.size).toBeGreaterThan(0)
    expect(DELIBERATELY_SILENT.length).toBeGreaterThan(0)
  })

  it('三个 self 码说的是"相对寻址塌了"，不是"粘来的地址有歧义"', () => {
    // 这条钉的是语义，不是形状。AMBIGUOUS_* / CALLER_NOT_OPEN 只从 `self` 分支抛：
    // control.ts:133-134 在 `target.kind === 'self'` 之内，:162-163 在 `target.kind === 'tab'`
    // 提前 return 之后。显式 id 走不到——region id 是 `region:${crypto.randomUUID()}`
    // （store.ts:960），全局唯一，跨 Tab 撞号不成立。
    //
    // 本轮初版把它们写成"这个地址匹配到不止一个目标"，那是**把粘贴地址的失败张冠李戴**：
    // 用户照着改地址不会有任何效果，因为问题出在"我在哪"这个前提上。两个 agent 独立
    // 复核才逼出这个区分，所以单独钉住。
    for (const code of ['AMBIGUOUS_REGION_TARGET', 'AMBIGUOUS_TAB_TARGET', 'CALLER_NOT_OPEN']) {
      const recovery = addressingRecovery({ code })!
      expect(recovery, `${code} 该有下一步`).not.toBeNull()
      // 必须点名 self：不说是相对寻址塌了，用户就会去改地址，白忙一场。
      expect(recovery, `${code} 没说清这是 self 失败`).toMatch(/self/u)
      // 不许把它描述成"地址匹配到多个"——那是 MESSAGE_TARGET_NOT_UNIQUE 的剧本。
      expect(recovery).not.toMatch(/这个地址匹配到不止一个/u)
      // 给的是与位置无关的身份，而不是"再挑一个候选"。
      expect(recovery).toContain(LIST_SESSIONS_COMMAND)
      expect(recovery).not.toContain('--to-region=')
    }
  })

  it('不是寻址失败的码返回 null，而不是一句放之四海的"再试一次"', () => {
    // 一句通用套话既没信息、又会盖住真正的原因。这里必须缺席，让原始 message 独自说话。
    for (const code of ['SESSION_CLOSING', 'AGENT_EXECUTOR_NOT_CONFIGURED', 'CONTROL_CANCELLED']) {
      expect(addressingRecovery({ code })).toBeNull()
    }
  })

  it('MESSAGE_TARGET_NOT_UNIQUE 缺 candidates 时按"一个都没有"处理，不抛', () => {
    // 边界处 candidates 是可选的；缺席不该让恢复本身炸掉，那会把一个可解释的失败变成崩溃。
    expect(addressingRecovery({ code: 'MESSAGE_TARGET_NOT_UNIQUE' })).toMatch(/没有 Agent/u)
  })
})

describe('恢复命令与复制地址共用同一个格式化出口', () => {
  // 这条是本 task 的架构核心：两份拼接会各自演进，漂移时不会有任何测试变红。
  // 因此这里不是"看起来一样"，而是断言两侧逐字来自同一处。

  it('同一个 Region，复制出的命令与恢复给出的命令逐字一致', () => {
    const copied = formatRegionAddress('region:1')
    const recovered = addressingRecovery({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1'] }]
    })
    // 从复制出的地址里取出那一行 send 命令，它必须原样出现在恢复文本里。
    const sendLine = copied.split('\n').find((line) => line.startsWith('agentmux send '))
    expect(sendLine).toBeDefined()
    expect(recovered).toContain(sendLine!)
  })

  it('恢复给的是那一格，不是退回 Session——已知的东西不许丢', () => {
    // 这条原来叫"同一个 Session 两侧逐字一致"，测的是候选没有 Region 时退到 Session。
    // 那条路已经删了：候选的 regionIds 现在是非空元组，"没有 Region"在类型上就不成立。
    // 留下的这条问的是另一件事——恢复必须给最精确的那个身份。多 Agent 的 View 里，
    // 我们知道每个候选在哪一格，接收方不知道；给 Session 等于把这个信息丢掉，
    // 让接收方再撞一次歧义。
    const recovered = addressingRecovery({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1'] }]
    })
    const sessionSendLine = formatSessionAddress('agent-a')
      .split('\n')
      .find((line) => line.startsWith('agentmux send '))
    expect(sessionSendLine).toBeDefined()
    expect(recovered).not.toContain(sessionSendLine!)
    expect(recovered).toContain("agentmux send --to-region='region:1'")
  })

  it('复制侧与恢复侧断言的是同一段文本，改格式必然一起红', () => {
    // 上面两条断言"两侧一致"，但共用出口时它们在任何格式下都一致——那证明不了"同时变红"。
    // 这条锁住的是另一件事：两侧各自都有**独立的字面断言**钉住命令长什么样。
    // 复制侧钉在 `agentmux send --to-region='…'`（本文件上方三个地址 describe），
    // 恢复侧钉在同一段字面（下方 recovery describe）——所以改一次格式，两组断言一起塌。
    // 实测（2026-08-31 复测）：把命令出口的 `=` 改成空格，本文件 15 条红，横跨复制侧与恢复侧。
    // 这个数字随本文件的用例增减而变——它只是"确实横跨两侧"的一次佐证，不是被守护的不变量。
    // 上一版写 11，后来加了 RUNNABLE 与分类两组用例就过时了；再引用前请重跑一次，别照抄。
    const region = 'region:1'
    const literal = `agentmux send --to-region='${region}'`
    expect(formatRegionAddress(region)).toContain(literal)
    expect(
      addressingRecovery({
        code: 'MESSAGE_TARGET_NOT_UNIQUE',
        candidates: [{ agentSessionId: 'agent-a', regionIds: [region] }]
      })
    ).toContain(literal)
  })

  it('仓库里不存在第二处拼接寻址命令', () => {
    // 上面两条证明当下一致，但挡不住有人另写一份拼接、且恰好写得一样。这条锁住结构：
    // 整个 renderer 里 `agentmux send --to-` 这种字面拼接只允许出现在本模块的命令出口。
    const module = readFileSync(new URL('../src/renderer/src/lib/agent-address.ts', import.meta.url), 'utf8')
    const code = module.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    const literalSends = code.match(/agentmux send /gu) ?? []
    expect(literalSends).toHaveLength(1)
    // 带 flag 的 inspect 也只允许拼一次。
    const flaggedInspects = code.match(/agentmux inspect \S*=/gu) ?? []
    expect(flaggedInspects).toHaveLength(1)
    // `list sessions` 是第三种命令形状（恢复文本里的 Session 旁路），同样只允许有一处字面。
    // 它不带 id，所以不是"寻址"拼接，但它一样会漂——上面两条挡不住它写成两份。
    const listSessions = code.match(/agentmux list /gu) ?? []
    expect(listSessions).toHaveLength(1)
    // 裸 `agentmux inspect`（不带 flag、不带子命令）跑不了：CLI 要求恰好一个选择器 flag。
    // 它一旦出现在恢复文本里就是一条死路，所以这里直接禁掉。
    expect(code).not.toMatch(/agentmux inspect(?!\s*\$?\{?\S*=)[^\n]*$/mu)
  })

  // 上面那条只读本模块一个文件：它锁住的是"出口内部只拼一次"，够不着"别的文件没有另拼一份"——
  // 而后者才是这条不变量真正要防的事。有人在 store.ts 里手拼一句 `agentmux send --to-region=...`，
  // 上面那条纹丝不动。所以这里把扫描面抬到整棵 renderer 源码树。
  const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
  const SOLE_ASSEMBLER = 'lib/agent-address.ts'
  // 动词命令，或三个 send flag 之一。注释里描述规则的文字不是规则本身，先去注释（沿用
  // rendered-class-has-rule.test.ts 的写法；`[^:]` 是为了不误伤 `https://` 里的双斜杠）。
  const ASSEMBLY = /agentmux\s+(?:send|inspect)\b|--to-(?:tab|region|session)\b/u

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) out.push(...sourceFiles(path))
      else if (/\.tsx?$/u.test(entry.name)) out.push(path)
    }
    return out
  }

  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
  }

  it('整棵 renderer 源码树里只有寻址出口拼命令', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_SRC)) {
      const relative = file.slice(RENDERER_SRC.length + 1)
      if (relative === SOLE_ASSEMBLER) continue
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
        if (ASSEMBLY.test(line)) offenders.push(`${relative}:${index + 1}  ${line.trim()}`)
      })
    }
    // 报出 file:line 而不是只给个数字——漂移点要一眼看得到，否则红了还得自己找。
    expect(offenders, `寻址命令只能在 ${SOLE_ASSEMBLER} 拼接，这些文件另拼了一份：\n${offenders.join('\n')}`).toEqual([])
  })

  it('自检：扫描面真的覆盖到了寻址出口本身', () => {
    // 少了这条，上面那条会以最难发现的方式假绿：路径写错、后缀过滤写错、去注释把整个文件吃空，
    // 任何一种都让 offenders 恒为空数组，而"没扫到"和"扫过了没问题"打印出来一模一样。
    const files = sourceFiles(RENDERER_SRC).map((file) => file.slice(RENDERER_SRC.length + 1))
    expect(files).toContain(SOLE_ASSEMBLER)
    expect(ASSEMBLY.test(withoutComments(readFileSync(`${RENDERER_SRC}/${SOLE_ASSEMBLER}`, 'utf8')))).toBe(true)
  })
})

describe('入口接线：菜单真的调用了交接出口，并且真的把它画出来', () => {
  // 纯函数正确不代表菜单接上了，而"model 里造了一项"也不代表用户点得到——本轮实测踩过：
  // 两个菜单都构造了 handoff，却都没渲染它，于是那条能力对用户根本不存在。所以这里查两件事：
  // 解析走的是交接出口（而不是退回直接复制地址），以及那一项确实被渲染成菜单项。

  it('Region 菜单把那一格交给交接出口，并渲染出这一项', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/RegionContextMenu.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('formatMessagingAddress({ agentSessionId, regionId })')
    // 造了不画等于没有。onSelect 被接到某个菜单项上，才谈得上"用户点得到"。
    expect(source).toContain('model.handoff.onSelect')
    expect(source).toContain('model.handoff.label')
  })

  it('Tab 菜单不带那一格，于是落到 Session，并渲染出这一项', () => {
    const source = readFileSync(
      new URL('../src/renderer/src/components/WorkbenchTabContextMenu.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain('formatMessagingAddress({ agentSessionId })')
    expect(source).toContain('copyModel.handoff.onSelect')
    expect(source).toContain('copyModel.handoff.label')
  })

  it('两个菜单的 model 类型都声明了 handoff——否则它连类型上都不存在', () => {
    // 上一轮的死代码正是这样溜过去的：对象字面量里多写一个字段，类型里没有，
    // 组件那侧也就永远取不到它，而 tsc 不会为"多写"报错。
    for (const file of ['RegionContextMenu.tsx', 'WorkbenchTabContextMenu.tsx']) {
      const source = readFileSync(
        new URL(`../src/renderer/src/components/${file}`, import.meta.url),
        'utf8'
      )
      expect(source).toMatch(/handoff\?: \w+CopyAction/u)
    }
  })

  it('send 的失败路径真的把恢复命令塞进了错误消息', async () => {
    // 不读源码字面，真跑一次控制响应边界：这是控制错误离开渲染进程的唯一出口。
    const { createRendererControlApi } = await import('../src/renderer/src/lib/control-api.js')
    const responses: DesktopControlResponse[] = []
    const listeners: ((request: { requestId: string }) => void)[] = []
    const api = createRendererControlApi({
      onRequest: (listener) => {
        listeners.push(listener as (request: { requestId: string }) => void)
        return () => {}
      },
      onCancellation: () => () => {},
      respond: (response) => responses.push(response)
    } as never)

    const failures = [
      Object.assign(new Error('Target Tab does not contain exactly one Agent Session.'), {
        code: 'MESSAGE_TARGET_NOT_UNIQUE',
        candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1'] }]
      }),
      Object.assign(new Error('Target Region is not an Agent.'), { code: 'MESSAGE_TARGET_NOT_AGENT' }),
      Object.assign(new Error('Tab target is not currently open.'), { code: 'TAB_NOT_OPEN' }),
      Object.assign(new Error('Agent Session is not available to the Desktop.'), { code: 'UNKNOWN_AGENT_SESSION' }),
      Object.assign(new Error('Agent Session is closing.'), { code: 'SESSION_CLOSING' })
    ]
    let next = 0
    api.onRequest(async () => { throw failures[next++]! })
    for (const [index] of failures.entries()) listeners[0]!({ requestId: `r-${index}` })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = responses.map((response) => (response.ok ? '' : response.error.message))
    // 先钉住"五条都结算了"。否则微任务没排干时 messages 是短数组，下面的循环会少跑几轮却依然全绿。
    expect(messages).toHaveLength(failures.length)
    // 每种寻址失败都带上了能直接跑的下一步，而不只是"发生了什么"。
    expect(messages[0]).toContain("agentmux send --to-region='region:1'")
    // 这三条拿不到 tab/region id，给的是 Session 旁路——它带子命令，真能跑。原来这里断言的是
    // `toContain('agentmux inspect')`，而裸 inspect 跑不了，那句话分不清能跑与不能跑。
    for (const index of [1, 2, 3]) expect(messages[index]).toContain('agentmux list sessions')
    // 原始 message 不能被恢复文本顶掉——"怎么办"是附加，不是替代。
    expect(messages[2]).toContain('Tab target is not currently open.')
    // 不是寻址失败的码保持原样：一句通用套话会盖住真正的原因。
    expect(messages[4]).toBe('Agent Session is closing.')
  })

  it('未通过校验的 candidates 不会被拿去生成命令', async () => {
    // 带换行的 id 会把恢复文本切成两段假命令。既有校验已经挡下这类响应，恢复不得绕过它。
    const { createRendererControlApi } = await import('../src/renderer/src/lib/control-api.js')
    const responses: DesktopControlResponse[] = []
    const listeners: ((request: { requestId: string }) => void)[] = []
    const api = createRendererControlApi({
      onRequest: (listener) => {
        listeners.push(listener as (request: { requestId: string }) => void)
        return () => {}
      },
      onCancellation: () => () => {},
      respond: (response) => responses.push(response)
    } as never)
    api.onRequest(async () => {
      throw Object.assign(new Error('ambiguous'), {
        code: 'MESSAGE_TARGET_NOT_UNIQUE',
        candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1\nrm -rf /'] }]
      })
    })
    listeners[0]!({ requestId: 'r-evil' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(responses).toHaveLength(1)
    const response = responses[0]!
    if (response.ok) throw new Error('校验应当把这次响应判为失败，它却成功了')
    expect(response.error.code).toBe('CONTROL_FAILED')
    expect(response.error.message).not.toContain('rm -rf')
  })
})
