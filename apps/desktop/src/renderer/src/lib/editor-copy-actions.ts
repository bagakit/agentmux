/**
 * 编辑器右键「复制」动作的**定义层**：每个动作是什么、菜单里排第几、什么时候能点、点了产出什么文本。
 *
 * 为什么抽出来：动作真正注册在 Monaco 的 `onMount` 回调里，而本仓的 desktop 测试用
 * `renderToStaticMarkup`（react-dom/server）——它不跑 effect、也不会替我们点一次右键菜单。写在回调
 * 里的分支没有断言够得着（与 `editor-save-shortcut` 同构的老问题）。所以把「产出什么文本」做成纯
 * 函数、把「有哪些动作、各自的门槛」做成纯数据，让它们能被直接断言；壳（EditorPane）只负责把编辑器
 * 里的选区/光标读出来、把文本交给共用的剪贴板出口。
 *
 * 复制路径不在这里重造：绝对 / 相对路径一律走 `clipboard-copy` 的 `formatPathsForCopy`（复制路径的
 * 唯一出口），本模块只是把它接到编辑器语境上，并补两个编辑器独有的形状——「路径:行号」与「面向
 * Agent 的上下文块」。写盘则统一走 `copyTextToClipboard`，本模块不碰剪贴板。
 */
import { formatPathsForCopy } from './clipboard-copy'

/**
 * 「选区跨了多行」这个上下文键的名字。
 *
 * 它是 Agent 上下文块动作的**唯一门槛**：Monaco 用 `precondition`（一个上下文键表达式）决定菜单项
 * 显不显示，壳在 `onMount` 里 `createContextKey(此名, false)` 并在选区变化时按 `hasMultilineSelection`
 * 刷新它。定义侧（下面动作的 `precondition`）与壳侧（`createContextKey`）必须用**同一个**名字，所以
 * 收成这一个常量——两处各写一遍字面量迟早漂移，而漂移那天菜单项会静默地永远不出现（或永远出现）。
 */
export const MULTILINE_SELECTION_CONTEXT_KEY = 'agentmuxEditorHasMultilineSelection'

/** 这几个复制动作在右键菜单里自成一组，不掺进 Monaco 默认的剪切/复制/粘贴组。 */
export const EDITOR_COPY_MENU_GROUP = 'agentmux'

/**
 * 一个复制动作产出文本所需的全部原料。每个动作各取所需——路径类不看行号，行号类不看选中文本，
 * 上下文块四样都要。壳每次都把整份原料备齐，动作自己挑，这样壳只有一条通用的 run，不需要按动作
 * 分叉的 switch。
 */
export type CopyActionInput = {
  /** 文件在工作区内的相对路径（用户在标题栏看到的那个）。 */
  relativePath: string
  /** 工作区根的绝对路径，用于拼出绝对路径。 */
  workspaceRoot: string
  /** 选区（或光标）起始行，1 起。 */
  startLine: number
  /** 选区结束行，1 起；无选区时等于 startLine。 */
  endLine: number
  /** 当前选中的文本；无选区时为空串。 */
  selectedText: string
  /** 上下文块围栏用的语言标识（由壳按文件名探测后传入）。 */
  fenceLang: string
}

/**
 * 一个复制动作的定义。`buildText` 是纯函数——期望产出可以锚成写死的字面量来断言，绝不由被测对象
 * 自己算。`precondition` 缺席表示「总是可点」；给出上下文键名表示「只在该键为真时出现」。
 */
export type EditorCopyActionDef = {
  id: string
  label: string
  order: number
  precondition?: string
  buildText: (input: CopyActionInput) => string
}

/** 选区是否跨了多行——Agent 上下文块动作是否该出现的唯一判据。单行（含无选区）为 false。 */
export function hasMultilineSelection(startLine: number, endLine: number): boolean {
  return endLine > startLine
}

/**
 * 面向 Agent 的上下文块：一行「相对路径:起-止」定位，紧跟一段带语言围栏的选中代码。
 *
 * 这是本产品最贴合定位的一项——用户选一段代码，一键得到可以直接粘给 agent 的上下文：既告诉 agent
 * 这段代码在哪个文件的哪几行，又把代码本身用围栏框好。路径用相对形式（相对工作区根），因为那才是
 * 能跨机器、跨人复述的稳定身份。格式在这里写死，是这个概念的唯一出口。
 */
export function formatAgentContextBlock(input: CopyActionInput): string {
  const { relativePath, startLine, endLine, selectedText, fenceLang } = input
  return `${relativePath}:${startLine}-${endLine}\n\`\`\`${fenceLang}\n${selectedText}\n\`\`\`\n`
}

/**
 * 全部编辑器复制动作，按菜单顺序排列。
 *
 * - 绝对 / 相对路径：直接复用 `formatPathsForCopy`（复制路径唯一出口），本模块不重写拼接。
 * - 路径:行号：取选区（或光标）起始行，产出 `相对路径:行号`，方便丢给别人或 agent 定位。
 * - Agent 上下文块：只在多行选区时出现（`precondition` 指向多行上下文键），产出可直接粘贴的上下文。
 */
export const EDITOR_COPY_ACTIONS: readonly EditorCopyActionDef[] = [
  {
    id: 'agentmux.copyAbsolutePath',
    label: 'Copy Absolute Path',
    order: 1,
    buildText: ({ relativePath, workspaceRoot }) =>
      formatPathsForCopy([relativePath], 'absolute', workspaceRoot)
  },
  {
    id: 'agentmux.copyRelativePath',
    label: 'Copy Relative Path',
    order: 2,
    buildText: ({ relativePath, workspaceRoot }) =>
      formatPathsForCopy([relativePath], 'relative', workspaceRoot)
  },
  {
    id: 'agentmux.copyPathWithLine',
    label: 'Copy Path with Line',
    order: 3,
    buildText: ({ relativePath, startLine }) => `${relativePath}:${startLine}`
  },
  {
    id: 'agentmux.copyAgentContext',
    label: 'Copy as Agent Context',
    order: 4,
    precondition: MULTILINE_SELECTION_CONTEXT_KEY,
    buildText: formatAgentContextBlock
  }
]
