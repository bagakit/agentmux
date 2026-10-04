import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// WorkbenchTabContextMenu 现在经 clipboard-copy 引到 api，api 在模块加载时就要判断跑在哪个宿主里。
// 不先立起这个全局，动态 import 那个组件时就会撞 requireDesktopApi 的 window.agentmux。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})
import { AGENTMUX_CONTROL_ERROR_CODES } from '@agentmux/core/control'
import type { DesktopControlResponse } from '../src/shared/contracts.js'
import {
  addressingRecovery,
  formatRegionAddress,
  formatSessionAddress,
  formatTabAddress
} from '../src/renderer/src/lib/agent-address.js'
import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab.js'
import {
  addWorkbenchRegion,
  createWorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { createWorkspaceLayout } from '@agentmux/layout'

// Card hints and recovery commands must be executable, with a nonempty scan.
const RUNNABLE: readonly RegExp[] = [
  /^amux agent send --to-session=\S.* --text ./u,
  /^amux space inspect --(?:region|tab)=\S/u,
  /^amux agent ls$/u,
  /^amux --skill$/u
]
const LIST_SESSIONS_COMMAND = 'amux agent ls'
function assertEveryCommandRunnable(text: string, where: string): number {
  let seen = 0
  for (const raw of text.split('\n')) {
    const line = raw.startsWith('# ') ? raw.slice(2) : raw
    if (!line.startsWith('amux ')) continue
    seen += 1
    expect(RUNNABLE.some(shape => shape.test(line)), `${where}: ${line}`).toBe(true)
  }
  return seen
}

describe('object sharing links', () => {
  it('shares the semantic Agent without presentation metadata', () => {
    expect(formatSessionAddress('agent-7')).toBe('amux://agent/agent-7')
  })

  it('keeps exact Region and complete Tab identities distinct', () => {
    expect(formatRegionAddress('region:2')).toBe('amux://region/region%3A2')
    expect(formatTabAddress('tab:2')).toBe('amux://tab/tab%3A2')
  })

  it('encodes whitespace and separators without adding commands or annotations', () => {
    expect(formatSessionAddress('a b/c?d#e')).toBe('amux://agent/a%20b%2Fc%3Fd%23e')
    expect(formatRegionAddress('a b/c?d#e')).toBe('amux://region/a%20b%2Fc%3Fd%23e')
    expect(formatTabAddress('a b/c?d#e')).toBe('amux://tab/a%20b%2Fc%3Fd%23e')
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
    // 收件人按 SID 已确定；语义发送不猜第一个投影。
    expect(recovery).toContain("amux agent send --to-session='agent-a'")
    expect(recovery).toContain("amux agent send --to-session='agent-b'")
    // 判据是"能不能直接跑"，所以必须是完整命令而不是裸 id。
    expect(recovery).not.toMatch(/^\s*region:1\s*$/mu)
  })

  it('一个 Agent 都没有，与"有多个"是不同的下一步', () => {
    const recovery = addressingRecovery({ code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates: [] })
    // 没有目标可挑，给出的必须是"怎么才能有一个"，而不是一份空清单。
    expect(recovery).not.toContain('amux agent send --to-')
    expect(recovery).toMatch(/没有 Agent/u)
  })

  it('未打开的 Tab、目标不是 Agent、暂缺 Session 各自有自己的恢复入口', () => {
    // 码取自真实抛出点：TAB_NOT_OPEN 见 lib/control.ts，UNKNOWN_AGENT_SESSION 见 store.ts。
    const notAgent = addressingRecovery({ code: 'MESSAGE_TARGET_NOT_AGENT' })
    const stale = addressingRecovery({ code: 'TAB_NOT_OPEN' })
    const gone = addressingRecovery({ code: 'UNKNOWN_AGENT_SESSION' })
    // 三种失败的原因不同，下一步也不该是同一句话——否则等于没有分类。
    expect(new Set([notAgent, stale, gone]).size).toBe(3)
    // REGION_NOT_OPEN 与 TAB_NOT_OPEN 是同一件事的两个粒度，共用一条下一步是有意的。
    expect(addressingRecovery({ code: 'REGION_NOT_OPEN' })).toBe(stale)
  })

  it('暂缺 Session 不代签终局，未打开的位置使用 Tab 词根', () => {
    const unknown = addressingRecovery({ code: 'UNKNOWN_AGENT_SESSION' })
    const notOpen = addressingRecovery({ code: 'TAB_NOT_OPEN' })
    expect(unknown).toContain('当前未观察到')
    expect(unknown).toContain('不能据此确认它已退出或被回收')
    expect(unknown).toContain('amux agent ls')
    expect(notOpen).toContain('当前没有打开这个 Tab 或 Region')
    expect(notOpen).toContain('不代表其中的 Agent Session 已结束')
    expect(notOpen).not.toContain('View')
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
    // 抛（store.ts 里 `region.kind !== 'agent'` 那一处，全仓仅此一处），但 regionId 在抛出点就丢了。
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
      expect(recovery).toContain('amux agent ls')
      expect(recovery).not.toContain('agentmux settings executors ls')
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
      // Control owner未提供可选资源观测接口；换Agent/Tab地址不能补出能力，保留原始message。
      'METRICS_UNSUPPORTED',
      // 文件诊断及设置冲突/资源约束不由换Agent地址恢复，保留各owner的原始message。
      'CRASH_LOG_NOT_FILE',
      'UNSUPPORTED_SETTING',
      'INVALID_SETTING_VALUE',
      'CONFIG_CONFLICT',
      'SETTING_RESOURCE_NOT_FOUND',
      'SETTING_RESOURCE_EXISTS',
      'SETTING_IDENTITY_IMMUTABLE',
      'SETTING_RESOURCE_IN_USE',
      'SETTING_RESOURCE_REFERENCES_UNKNOWN',
      // Envelope身份与发送条件不成立不能教自动重发或改投其他收件人。
      'MESSAGE_SENDER_MISMATCH',
      'MESSAGE_RECIPIENT_MISMATCH',
      'MESSAGE_ENVELOPE_INVALID',
      // Prompt忙/未确认与Session store读未确认都不代表Agent终局，也不是换地址可恢复。
      'AGENT_PROMPT_INPUT_UNCONFIRMED',
      'AGENT_PROMPT_SUBMISSION_BUSY',
      'AGENT_SESSION_STORE_READ_UNCONFIRMED',
      'AGENT_EXECUTOR_NOT_CONFIGURED',
      'SESSION_CLOSING',
      'SESSION_NOT_RUNNING',
      'UNKNOWN_WORKSPACE',
      // 资源选择由原错误消息指向 Project/source-workspace，不改变语义收件人。
      'SPACE_RESOURCE_PROJECT_UNKNOWN',
      'SPACE_RESOURCE_SOURCE_REQUIRED',
      'REGION_WORKSPACE_MISMATCH',
      'REGION_TOPIC_MISMATCH',
      'LAUNCH_RESULT_MISMATCH',
      'LAUNCH_CLEANUP_FAILED',
      'LAYOUT_CAPACITY_EXCEEDED',
      'REGION_ALREADY_SOLE',
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
      'SIGNAL_UNSUPPORTED',
      // 不是寻址失败，而且它的原始 message 已经点名了唯一那条下一步（"Turn it on in
      // Settings › Browser."，可达性由 browser-automation-setting-reachable.test.ts 单独证明）。
      // 再叠一句 addressingRecovery 的"换个地址试试"只会盖掉那句真能走的。
      'BROWSER_AUTOMATION_DISABLED',
      // 同上一条的理由：都不是寻址失败，而且各自的 message 已经点名了唯一那条下一步。
      //
      // `BROWSER_SUBSCRIBE_UNSUPPORTED` 是能力协商的答案——这一端不提供进度订阅，换个地址不会让它
      // 提供。恢复动作在宿主那边（实现 `subscribeBrowserOperation`），不在调用方手上。
      //
      // `BROWSER_HUMAN_CONTROL_ACTIVE` 的恢复动作是**人明确交还控制**，这条由设计约束钉死
      // （「恢复只能由人明确发起；Agent 不得靠重试静默夺回页面」）。给它叠一句"换个地址试试"
      // 正好是在教 Agent 做那件被禁的事。
      'BROWSER_SUBSCRIBE_UNSUPPORTED',
      'BROWSER_HUMAN_CONTROL_ACTIVE'
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
    // 这条钉的是语义，不是形状。三个码今天都表示"我在哪"这个前提塌了。
    //
    // 但抛出面**不对称**，别照抄"三个码都只从 self 抛"这句话（本文件曾经就这么写，而它是错的）：
    // `CALLER_NOT_OPEN` 与 `AMBIGUOUS_TAB_TARGET` 的抛出点确实都在 self 分支之内，而
    // `AMBIGUOUS_REGION_TARGET` 在 `resolveWorkbenchControlRegion` 里**另有一处**，在显式 id
    // 那条路上（"Region target is ambiguous."）——view-focus.test.ts 的 "resolves Launcher
    // destinations through the open-only unique Region owner" 就用两张各持同一 regionId 的开着的
    // Tab 抛出了它，所以那不是死代码。
    //
    // 让那一处今天不可达的是**下一条测试**钉住的前提（regionId 不会同时留在两张开着的 Tab 里），
    // 不是"它不存在"。所以那条守卫是本条文案成立的前提，两条要一起读。
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

  it('唯一刻意复用 regionId 的路径：促升后源 Tab 不再持有它（上一条文案的前提）', () => {
    // 上一条恢复文案说 `AMBIGUOUS_REGION_TARGET` 表示"发起方同时显示在多处"，即断定它**不会**
    // 从显式 id 那条路抛出。而那条路真实存在（view-focus.test.ts 的
    // "resolves Launcher destinations through the open-only unique Region owner" 就用两张各持
    // 'duplicate-launcher' 的开着的 Tab 抛出了它）。所以文案成立靠的不是"分支不存在"，而是
    // **没有生产路径能造出跨 Tab 的重号**。这条把那个前提钉在唯一刻意复用 id 的路径上。
    //
    // 铸造侧本身不需要守卫：两种拼法（`region:${crypto.randomUUID()}` 与
    // `initialWorkbenchRegionId` 的 `region:${tabId}`，tabId 自己带 uuid）都各自唯一。危险的是
    // `promoteRegionToTab`——它是全仓**唯一**故意把一个已存在的 regionId 搬到另一张 Tab 上的
    // reducer（内容按 regionId 键控，重铸会让 browser/编辑器缓存找不回内容）。它不制造重号的
    // 全部理由就是：搬走的同时源 Tab 上那一格被 delete 掉。少了这一步，两张开着的 Tab 会同时
    // 持有同一个 regionId，显式 id 那条路当场可达，而上一条文案会对它说谎。
    const source = addWorkbenchRegion(
      createWorkbenchTab('view:source', { regionId: 'region:kept', kind: 'launcher', workspaceId: 'workspace' }),
      'region:kept',
      'right',
      { regionId: 'region:promoted', kind: 'launcher', workspaceId: 'workspace' }
    )
    // 前提自检：源 Tab 真的有两格（单格时促升是 no-op，那就测不到搬运）。
    expect(Object.keys(source.regions).sort()).toEqual(['region:kept', 'region:promoted'])

    const result = promoteRegionToTab({
      tabs: { 'view:source': source },
      layouts: { workspace: createWorkspaceLayout('group', ['view:source']) },
      workspaceId: 'workspace',
      tabId: 'view:source',
      regionId: 'region:promoted',
      mint: { tabId: 'view:promoted' }
    })
    expect(result.kind).toBe('promoted')
    if (result.kind !== 'promoted') throw new Error('unreachable')

    // 判据不是"新 Tab 拿到了它"（那是 promote 自己的不变量，promote-region-to-tab.test.ts 管），
    // 而是**跨 Tab 的持有者名单恰好是那一张**：把每张 Tab 的 regions 键摊平，同一个 id 不许出现两次。
    // 这个形状与 control.ts 显式 id 那条路的 `matches.length !== 1` 逐字对应——它数的正是
    // "有多少张开着的 Tab 持有这个 regionId"。名单相等同时排掉了"promote 把它整个丢了"
    // （那时名单是空的，也不等于 ['view:promoted']），所以不需要再补一条计数断言——补了是死代码。
    const holders = Object.values(result.tabs).filter((tab) => 'region:promoted' in tab.regions)
    expect(holders.map((tab) => tab.id)).toEqual(['view:promoted'])

    // 源 Tab 只剩没被搬走的那一格。
    expect(Object.keys(result.tabs['view:source']!.regions)).toEqual(['region:kept'])
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

describe('Core owns links and executable recovery commands', () => {
  it('a share is one link; ambiguity recovery still supplies complete semantic send commands', () => {
    expect(formatSessionAddress('agent-a')).toBe('amux://agent/agent-a')
    const recovered = addressingRecovery({
      code: 'MESSAGE_TARGET_NOT_UNIQUE',
      candidates: [{ agentSessionId: 'agent-a', regionIds: ['region:1', 'region:2'] }]
    })
    expect(recovered).toContain('amux agent send --to-session=\'agent-a\' --text "..."')
    expect(recovered).not.toContain('--to-region')
  })

  const RENDERER_SRC = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
  const CORE_OWNER = new URL('../../../packages/core/src/sharing.ts', import.meta.url)
  const ASSEMBLY = /(?:amux|agentmux)\s+(?:agent\s+send|space\s+inspect)\b/u
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = `${dir}/${entry.name}`
      return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/u.test(entry.name) ? [path] : []
    })
  }
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
  }
  it('Core owns command assembly and the nonempty renderer scan has no duplicate', () => {
    const owner = withoutComments(readFileSync(CORE_OWNER, 'utf8'))
    expect(owner.match(/amux agent send /gu)).toHaveLength(1)
    expect(owner.match(/amux agent ls/gu)).toHaveLength(1)
    expect(ASSEMBLY.test(owner)).toBe(true)
    const files = sourceFiles(RENDERER_SRC)
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(`${RENDERER_SRC}/lib/agent-address.ts`)
    const offenders = files.filter(file => ASSEMBLY.test(withoutComments(readFileSync(file, 'utf8'))))
    expect(offenders).toEqual([])
    const adapter = readFileSync(`${RENDERER_SRC}/lib/agent-address.ts`, 'utf8')
    expect(adapter.match(/from '@agentmux\/core\/sharing'/gu)).toHaveLength(2)
    expect(adapter).toContain('agentSessionSendCommand(candidate.agentSessionId)')
  })

})

describe('object-link menu consumers', () => {
  it.each([
    ['RegionContextMenu', 'region:pane-2'],
    ['WorkbenchTabContextMenu', 'view:x']
  ] as const)('%s exposes one clickable semantic Agent link', async (component, identity) => {
    const copied: string[] = []
    const writeClipboardText = async (text: string) => { copied.push(text) }
    const { createRegionCopyModel } = await import('../src/renderer/src/components/RegionContextMenu.js')
    const { createWorkbenchTabCopyModel } = await import('../src/renderer/src/components/WorkbenchTabContextMenu.js')
    const model = component === 'RegionContextMenu'
      ? createRegionCopyModel({ regionId: identity, agentSessionId: 'agent-7', writeClipboardText })
      : createWorkbenchTabCopyModel({ tabId: identity, agentSessionId: 'agent-7', writeClipboardText })
    const links = model.entries.filter(entry => entry.kind === 'action' && entry.action.label === 'Copy Agent Link')
    expect(links).toHaveLength(1)
    const link = links[0]!
    if (link.kind !== 'action') throw new Error('unreachable')
    await link.action.onSelect()
    expect(copied).toEqual(['amux://agent/agent-7'])
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
    expect(messages[0]).toContain("amux agent send --to-session='agent-a'")
    // 这三条拿不到 tab/region id，给的是 Session 旁路——它带子命令，真能跑。原来这里断言的是
    // `toContain('agentmux inspect')`，而裸 inspect 跑不了，那句话分不清能跑与不能跑。
    for (const index of [1, 2, 3]) expect(messages[index]).toContain('amux agent ls')
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
