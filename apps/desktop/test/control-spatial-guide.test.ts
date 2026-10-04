import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  composeAgentLaunchPrompt
} from '../../../packages/core/src/agent-outbound-message.js'
import {
  AGENTMUX_CLI_HELP,
  AGENTMUX_CLI_SKILL,
  agentMuxCommandHelp
} from '../../../packages/core/src/agentmux-cli-help.js'
import { AGENTMUX_CLI_COMMANDS, agentMuxCliArguments, agentMuxCliMatch, parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands.js'
import {
  directionalNeighbor,
  type DirectionalNeighborInput
} from '../src/renderer/src/lib/directional-addressing.js'

// T-006「简短通用的空间操作引导」的验收。注入引导有两个面：**启动提示**（`AGENTMUX_RUNTIME_GUIDE`
// 经 `composeAgentLaunchPrompt` 注入，负责让 Agent **发现**这些能力存在），与 **skill**（`AGENTMUX_CLI_SKILL`
// 经 `agentmux --skill` 产出，负责**确切用法**）。目标的四件事各配一个会咬的守卫，且尽量从 SSOT 派生，
// 不把命令表手抄第二份——命令名称、对象与描述都来自实际的 `AGENTMUX_CLI_COMMANDS`。
//
// 关键设计：内容守卫直接 import 源码常量，**不经 dist**——`@agentmux/core` 解析到 dist，而 dist 相对
// 本 lane 的源改动是陈旧的，重建 dist 是共享可变状态竞态（见仓库记忆 shared-dist-is-a-mutable-state-race）。
// 行为守卫走既有纯函数 `composeAgentLaunchPrompt` / `directionalNeighbor`：实现任务的变异必须让它们变红。

const CORE_SRC = new URL('../../../packages/core/src/', import.meta.url)
const clientSource = readFileSync(fileURLToPath(new URL('client.ts', CORE_SRC)), 'utf8')
const cliSource = readFileSync(fileURLToPath(new URL('agentmux.ts', CORE_SRC)), 'utf8')

function commandRegistry(): Map<string, string> {
  return new Map(AGENTMUX_CLI_COMMANDS.map(command => [command.method, command.summary]))
}

/** 匹配完整对象路径，避免把 browser run / browser task run 都误认成一个 browser 动词。 */
function taughtCommands() {
  return [...AGENTMUX_CLI_SKILL.matchAll(/^\s*agentmux ([^\n]+)/gm)].map(match => {
    const line = match[1]!
    // Discover the object path through the real global-option parser and registry matcher.
    // Argument syntax is checked separately on the runnable spatial examples below.
    const command = agentMuxCliMatch(agentMuxCliArguments(line.split(/\s+/)).args)?.command
    return { line, command }
  })
}

/** 取 skill 里一个带右界的小节，避免只取左界让邻节顶上（见记忆 section-slice-without-right-bound）。 */
function skillSection(startHeader: string, endHeader: string): string {
  const start = AGENTMUX_CLI_SKILL.indexOf(startHeader)
  if (start < 0) return ''
  const end = AGENTMUX_CLI_SKILL.indexOf(endHeader, start + startHeader.length)
  return end < 0 ? '' : AGENTMUX_CLI_SKILL.slice(start, end)
}

const launchGuide = composeAgentLaunchPrompt('do the work', true).text

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
  it('移动命令从实际注册表派生，skill 逐个教出对象语法和原执行身份保全', () => {
    const registry = commandRegistry()
    expect(registry.size).toBeGreaterThan(0)
    // 不写死 'promote'：从"某个 Region 搬进一个 Tab"这个语义在注册表里认出移动动词。
    const moveCommands = [...registry].filter(([, desc]) => /region[\s\S]*into[\s\S]*tab/i.test(desc)).map(([method]) => method)
    expect(moveCommands.length).toBeGreaterThan(0) // 扫描非空
    // 注入的确切用法面必须教出每一个移动动词——新增一个移动动词到注册表却不在 skill 教，这里红。
    for (const method of moveCommands) {
      expect(AGENTMUX_CLI_SKILL).toContain(`agentmux ${method.replaceAll('.', ' ')} --region`)
    }
    // 且它教的是"移动/搬出"，不是"再开一份"——promote 不碰 Run。
    const section = skillSection('## Move a Region into its own Tab', '## Read what is in a direction')
    expect(section.length).toBeGreaterThan(0)
    expect(section).toMatch(/never starts, stops, or restarts/i)
    expect(section).toMatch(/do not duplicate[\s\S]*cwd, Host, Session or Run/i)
    expect(section).toContain('--from-display-workspace')
    expect(section).toContain('--from-group')
    // 发现面也要点出它。上面三条全在 skill（确切用法）一侧：删掉启动提示里那句"可以把一格搬进独立
    // Tab"，Agent 压根不知道有这回事，就永远不会去 --skill 查它的语法——而上面三条照旧全绿（实测：
    // 删掉 launch guide 的该从句，11 条无一变红）。发现与用法是两个面，各自要有咬合。
    expect(launchGuide).toMatch(/move a region[\s\S]{0,40}own tab/i)
  })

  it('help 和 skill 消费实际命令表，教出的完整对象路径都有真实分发', () => {
    const registry = commandRegistry()
    expect(registry.size).toBeGreaterThan(0)
    const taught = taughtCommands()
    expect(taught.length).toBeGreaterThan(0) // 扫描非空
    for (const { line, command } of taught) expect(command, line).toBeDefined()
    for (const method of registry.keys()) {
      const syntax = `agentmux ${method.replaceAll('.', ' ')}`
      expect(AGENTMUX_CLI_HELP).toContain(syntax)
      expect(AGENTMUX_CLI_SKILL).toContain(syntax)
    }
  })

  it('自定义 Executor 可发现：启动提示点出按名配置，skill 指向实际 settings executors ls', () => {
    const registry = commandRegistry()
    expect(registry.size).toBeGreaterThan(0)
    expect(registry.has('settings.executors.ls')).toBe(true)
    // 启动提示（发现面）：让 Agent 知道自定义 executor 能按名开出来。
    expect(launchGuide).toMatch(/executor .*configured|configured .*executor|found by name/i)
    expect(AGENTMUX_CLI_SKILL).toMatch(/configured executor[\s\S]{0,120}agentmux settings executors ls[\s\S]{0,80}exact ID/i)
  })

  it('空间示例经实际 CLI parser 接受，不把旧 flag 或虚构目的地教给 Agent', async () => {
    const section = skillSection('## Choose a split from the visible layout', 'Agent-first workflow:')
    expect(section.length).toBeGreaterThan(0)
    const examples = [...section.matchAll(/^agentmux ([^\n]+)$/gm)].map(match => match[1]!)
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      const parsed = await parseAgentMuxCliInvocation(example.split(' '))
      expect(AGENTMUX_CLI_COMMANDS).toContain(parsed.command)
    }
  })

  it('驱动已开的 Browser 可发现：启动提示点出这件事，skill 教确切用法', () => {
    // 与上面「移动动词」同形的两面咬合。这个能力特别需要发现面：它挂在一个**顶层动词**上
    // （`agentmux browser run`），不像 open 的子命令那样会被顺带提到。Agent 不知道它存在，
    // 就只会退回去让用户自己看页面——或者更糟，去猜坐标点击。
    //
    // 发现面（启动提示）：说得出"已经开着的 Browser 可以被驱动"，且点出"按读到的元素动"。
    expect(launchGuide, '启动提示没提驱动已开的 Browser——Agent 不会知道有这回事，也就永远不会去 --skill 查')
      .toMatch(/Browser that is already open[\s\S]{0,200}driven/i)
    expect(launchGuide, '启动提示没说清是"读页面→按读到的元素动"，Agent 可能仍以为要靠坐标')
      .toMatch(/reads the page[\s\S]{0,120}elements/i)
    // 但发现面不许抄语法——确切用法的唯一真相在 skill，抄进来会在语法演进时立刻过期。
    expect(launchGuide, '启动提示抄了命令行语法，与 skill 争夺唯一真相').not.toContain('browser run --browser')

    // 用法面（skill）：教出确切命令与授权前提。
    expect(AGENTMUX_CLI_SKILL, 'skill 没教 browser run 的确切用法').toContain('agentmux browser run --browser')
    expect(AGENTMUX_CLI_SKILL, 'skill 没说授权开关在哪，Agent 撞到拒绝时无路可走').toContain('Settings › Browser')
  })

  it('两个 SSOT 常量都有真实生产消费者（排除定义文件后扫描非空）', () => {
    // 启动引导：client.ts 的 createAgent 经 composeAgentLaunchPrompt 注入，由 injectAgentMuxGuide 控制。
    const guideConsumers = [...clientSource.matchAll(/composeAgentLaunchPrompt\(/g)]
    expect(guideConsumers.length).toBeGreaterThan(0)
    expect(clientSource).toContain('injectAgentMuxGuide')
    // skill：CLI 的 main() 在 --skill 时把 AGENTMUX_CLI_SKILL **写到 stdout**。断言这个**产出形状**
    // 而非裸标识符——后者连 import 行都满足，不能证明真实 --skill 产出。
    const skillEmits = [...cliSource.matchAll(/process\.stdout\.write\(\s*AGENTMUX_CLI_SKILL\s*\+\s*['"]\\n['"]\s*\)/g)]
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
    const section = skillSection('## Read what is in a direction', '## Confirm the actual destination')
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
    const section = skillSection('## Confirm the actual destination', 'Agent-first workflow:')
    expect(section.length).toBeGreaterThan(0)
    expect(section).toMatch(/after any move inspect the result/i)
    expect(section).toContain('--display-workspace')
    expect(section).toContain('--group')
    expect(section).toContain('space inspect --operation-id OPERATION')
    expect(section).toMatch(/unknown[\s\S]*unconfirmed[\s\S]*do not blindly retry/i)
    const splitGuide = skillSection('## Choose a split from the visible layout', '## Move a Region into its own Tab')
    expect(splitGuide.length).toBeGreaterThan(0)
    expect(splitGuide).toMatch(/visible view[\s\S]*readable[\s\S]*least disturbance/i)
    for (const path of ['space', 'space.mv', 'space.promote', 'agent.open', 'file.open']) {
      const help = agentMuxCommandHelp(path)
      expect(help, path).not.toBeNull()
      expect(help).toContain(section.trim())
    }
  })
})

describe('T-006 不列窄宽特例（负向要求要真的咬）', () => {
  const directionSection = skillSection('## Read what is in a direction', '## Confirm the actual destination')
  const spatialText = `${launchGuide}\n${directionSection}`

  it('正向承重：引导把"拆哪格"委托给 Agent 对可见版面的判断，而不是按尺寸给规则', () => {
    // 这是承重的一半：把委托语删掉换成一条按尺寸的规则，这里红。
    expect(launchGuide).toMatch(/decide that from the visible view yourself|by the visible view/i)
  })

  it('负向边界：不枚举窄/宽尺寸特例、不要求面积相等', () => {
    // 两个扫描源各自非空。不能断言拼起来的 `spatialText.length > 0`——模板字面量里那个 `\n` 让它
    // 在两侧**都空**时仍然长度为 1，于是这条挡板恒真、下面的负向断言可以空跑而无人察觉（审计实测：
    // 把两个插值都换成 '' 后 11 条全绿）。挡板要量被扫的那两段本身。
    expect(launchGuide.length).toBeGreaterThan(0)
    expect(directionSection.length).toBeGreaterThan(0)
    // ponytail: 字面形状黑名单，只挡设计明确点名的那种回归（窄/宽/等面积）；换个措辞（"for thin panes"）
    // 仍可能漏——真正承重的是上一条的正向委托断言。upgrade: 若出现同义词绕过再补一条正向"决策依据恰是
    // 方向/可读性/最小扰动"的白名单断言。
    for (const forbidden of [/\bnarrow\b/i, /\bwide\b/i, /窄/, /宽/, /equal area/i, /same size/i, /面积相等/]) {
      expect(spatialText).not.toMatch(forbidden)
    }
  })
})
