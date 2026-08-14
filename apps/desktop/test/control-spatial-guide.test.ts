import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  composeAgentLaunchPrompt
} from '../../../packages/core/src/agent-outbound-message.js'
import {
  AGENTMUX_CLI_HELP,
  AGENTMUX_CLI_SKILL
} from '../../../packages/core/src/agentmux-cli-help.js'
import {
  directionalNeighbor,
  type DirectionalNeighborInput
} from '../src/renderer/src/lib/directional-addressing.js'

// T-006「简短通用的空间操作引导」的验收。注入引导有两个面：**启动提示**（`AGENTMUX_RUNTIME_GUIDE`
// 经 `composeAgentLaunchPrompt` 注入，负责让 Agent **发现**这些能力存在），与 **skill**（`AGENTMUX_CLI_SKILL`
// 经 `agentmux --skill` 产出，负责**确切用法**）。目标的四件事各配一个会咬的守卫，且尽量从 SSOT 派生，
// 不把动词表手抄第二份——手抄的那份会与真正的动词注册表（`AGENTMUX_CLI_HELP` 的 Intents 块）漂移。
//
// 关键设计：内容守卫直接 import 源码常量，**不经 dist**——`@agentmux/core` 解析到 dist，而 dist 相对
// 本 lane 的源改动是陈旧的，重建 dist 是共享可变状态竞态（见仓库记忆 shared-dist-is-a-mutable-state-race）。
// 行为守卫走既有纯函数 `composeAgentLaunchPrompt` / `directionalNeighbor`：实现任务的变异必须让它们变红。

const CORE_SRC = new URL('../../../packages/core/src/', import.meta.url)
const clientSource = readFileSync(fileURLToPath(new URL('client.ts', CORE_SRC)), 'utf8')
const cliSource = readFileSync(fileURLToPath(new URL('agentmux.ts', CORE_SRC)), 'utf8')

/** 动词注册表的唯一真相：`AGENTMUX_CLI_HELP` 的 Intents 块。解析成 verb → 一句描述。 */
function intentRegistry(): Map<string, string> {
  const intents = AGENTMUX_CLI_HELP.split('Intents:')[1]?.split('Managed caller:')[0] ?? ''
  const rows = [...intents.matchAll(/^ {2}([a-z]+) {2,}(.+)$/gm)]
  return new Map(rows.map((m) => [m[1], m[2].trim()]))
}

/** skill 里代码块中真正教出来的动词（行首 `agentmux <verb>`）。 */
function taughtVerbs(): string[] {
  return [...new Set([...AGENTMUX_CLI_SKILL.matchAll(/^agentmux ([a-z]+)/gm)].map((m) => m[1]))]
}

/** 取 skill 里一个带右界的小节，避免只取左界让邻节顶上（见记忆 section-slice-without-right-bound）。 */
function skillSection(startHeader: string, endHeader: string): string {
  const start = AGENTMUX_CLI_SKILL.indexOf(startHeader)
  if (start < 0) return ''
  const end = AGENTMUX_CLI_SKILL.indexOf(endHeader, start + startHeader.length)
  return AGENTMUX_CLI_SKILL.slice(start, end < 0 ? undefined : end)
}

const launchGuide = composeAgentLaunchPrompt('do the work', true)

function splitView(): DirectionalNeighborInput {
  return {
    regionId: 'left',
    tabId: 'tab-2',
    tabOrder: ['tab-1', 'tab-2', 'tab-3'],
    regions: [
      { regionId: 'left', bounds: { x: 0, y: 0, width: 0.5, height: 1 } },
      { regionId: 'right', bounds: { x: 0.5, y: 0, width: 0.5, height: 1 } }
    ]
  }
}

function unsplitView(): DirectionalNeighborInput {
  return {
    regionId: 'only',
    tabId: 'tab-2',
    tabOrder: ['tab-1', 'tab-2', 'tab-3'],
    regions: [{ regionId: 'only', bounds: { x: 0, y: 0, width: 1, height: 1 } }]
  }
}

describe('T-006 注入引导：可发现自定义 Executor 与移动命令', () => {
  it('移动动词从注册表结构派生（描述含 region→into→tab），且 skill 逐个教它——加个移动动词不教就红', () => {
    const registry = intentRegistry()
    expect(registry.size).toBeGreaterThan(0)
    // 不写死 'promote'：从"某个 Region 搬进一个 Tab"这个语义在注册表里认出移动动词。
    const moveVerbs = [...registry].filter(([, desc]) => /region[\s\S]*into[\s\S]*tab/i.test(desc)).map(([v]) => v)
    expect(moveVerbs.length).toBeGreaterThan(0) // 扫描非空
    // 注入的确切用法面必须教出每一个移动动词——新增一个移动动词到注册表却不在 skill 教，这里红。
    for (const verb of moveVerbs) {
      expect(AGENTMUX_CLI_SKILL).toContain(`agentmux ${verb} --region`)
    }
    // 且它教的是"移动/搬出"，不是"再开一份"——promote 不碰 Run。
    expect(skillSection('## Move a Region into its own Tab', '## Read what is in a direction'))
      .toMatch(/move, not to duplicate|never starts, stops, or restarts/i)
    // 发现面也要点出它。上面三条全在 skill（确切用法）一侧：删掉启动提示里那句"可以把一格搬进独立
    // Tab"，Agent 压根不知道有这回事，就永远不会去 --skill 查它的语法——而上面三条照旧全绿（实测：
    // 删掉 launch guide 的该从句，11 条无一变红）。发现与用法是两个面，各自要有咬合。
    expect(launchGuide).toMatch(/move a region[\s\S]{0,40}own tab/i)
  })

  it('skill 教的每个动词都在注册表里（不教一个 CLI 不分发的名字）', () => {
    const registry = intentRegistry()
    const taught = taughtVerbs()
    expect(taught.length).toBeGreaterThan(0) // 扫描非空
    for (const verb of taught) expect(registry.has(verb)).toBe(true)
  })

  it('自定义 Executor 可发现：启动提示点出"按名开配置好的 executor"，skill 指向 list agents 去解析', () => {
    const registry = intentRegistry()
    expect(registry.has('list')).toBe(true) // 发现走既有 list 动词
    // 启动提示（发现面）：让 Agent 知道自定义 executor 能按名开出来。
    expect(launchGuide).toMatch(/executor .*configured|configured .*executor|found by name/i)
    // skill（用法面）：开自定义 Agent 前先 list agents 解析稳定 id 与可用性。
    expect(AGENTMUX_CLI_SKILL).toMatch(/custom Agent[\s\S]{0,220}agentmux list agents/i)
  })

  it('两个 SSOT 常量都有真实生产消费者（排除定义文件后扫描非空）', () => {
    // 启动引导：client.ts 的 createAgent 经 composeAgentLaunchPrompt 注入，由 injectAgentMuxGuide 控制。
    const guideConsumers = [...clientSource.matchAll(/composeAgentLaunchPrompt\(/g)]
    expect(guideConsumers.length).toBeGreaterThan(0)
    expect(clientSource).toContain('injectAgentMuxGuide')
    // skill：CLI 的 main() 在 --skill 时把 AGENTMUX_CLI_SKILL **写到 stdout**。断言这个**产出形状**
    // （模板插值 ${AGENTMUX_CLI_SKILL}）而非裸标识符——后者连 import 行都满足，把 emit 改成写别的常量
    // 也不会红（实测过这个洞）。这里要求它真的被送进 stdout。
    const skillEmits = [...cliSource.matchAll(/process\.stdout\.write\(`\$\{AGENTMUX_CLI_SKILL\}/g)]
    expect(skillEmits.length).toBeGreaterThan(0)
  })
})

describe('T-006 区分"导航到 Tab"与"可见的 Region"', () => {
  it('行为：分栏时方向落在可见 Region，没分栏才退到相邻 Tab——两种不同的位置', () => {
    // 分了栏，"右边"是眼睛看得见的那一格 Region。
    expect(directionalNeighbor(splitView(), 'right')).toEqual({ kind: 'region', regionId: 'right' })
    // 没分栏，"右边"退到 Tab 条上相邻的那张 Tab（导航到另一张完整 View）。
    expect(directionalNeighbor(unsplitView(), 'right')).toEqual({ kind: 'tab', tabId: 'tab-3' })
  })

  it('行为：上/下永远不指 Tab（Tab 条是一维水平序列）', () => {
    expect(directionalNeighbor(unsplitView(), 'up')).toEqual({ kind: 'none' })
    expect(directionalNeighbor(unsplitView(), 'down')).toEqual({ kind: 'none' })
  })

  it('引导教出这个区分而非混为一谈：分栏→可见 Region，无分栏→相邻 Tab，上下不指 Tab', () => {
    const section = skillSection('## Read what is in a direction', '## Send without guessing')
    expect(section.length).toBeGreaterThan(0) // 扫描非空
    expect(section).toMatch(/split[\s\S]*visible Region/i)
    expect(section).toMatch(/nothing is split[\s\S]*adjacent Tab/i)
    expect(section).toMatch(/not the\s+same/i) // 明说是两个不同的位置
    expect(section).toMatch(/Up and down never name a Tab/i)
    // 启动提示也点出这个区分——查看方向得到的是可见 Region 或相邻 Tab，不是同一处。
    expect(launchGuide).toMatch(/visible region[\s\S]*adjacent tab|adjacent tab[\s\S]*visible region/i)
  })
})

describe('T-006 以方向、可读性、最小扰动决策并回读', () => {
  it('启动提示：保留可读性、最小扰动、事后回读实际落点', () => {
    expect(launchGuide).toMatch(/readable/i)
    expect(launchGuide).toMatch(/least disturbance|minimal/i)
    expect(launchGuide).toMatch(/confirm where it landed|read.?back|inspect the result/i)
  })

  it('skill：任何搬动之后回读/inspect 结果确认落点', () => {
    expect(AGENTMUX_CLI_SKILL).toMatch(/after any move inspect the result|inspect the result to confirm/i)
  })
})

describe('T-006 不列窄宽特例（负向要求要真的咬）', () => {
  const spatialText = `${launchGuide}\n${skillSection('## Read what is in a direction', '## Send without guessing')}`

  it('正向承重：引导把"拆哪格"委托给 Agent 对可见版面的判断，而不是按尺寸给规则', () => {
    // 这是承重的一半：把委托语删掉换成一条按尺寸的规则，这里红。
    expect(launchGuide).toMatch(/decide that from the visible view yourself|by the visible view/i)
  })

  it('负向边界：不枚举窄/宽尺寸特例、不要求面积相等', () => {
    expect(spatialText.length).toBeGreaterThan(0) // 扫描非空，负向断言不至于空跑
    // ponytail: 字面形状黑名单，只挡设计明确点名的那种回归（窄/宽/等面积）；换个措辞（"for thin panes"）
    // 仍可能漏——真正承重的是上一条的正向委托断言。upgrade: 若出现同义词绕过再补一条正向"决策依据恰是
    // 方向/可读性/最小扰动"的白名单断言。
    for (const forbidden of [/\bnarrow\b/i, /\bwide\b/i, /窄/, /宽/, /equal area/i, /same size/i, /面积相等/]) {
      expect(spatialText).not.toMatch(forbidden)
    }
  })
})
