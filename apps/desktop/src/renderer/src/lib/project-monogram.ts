/**
 * 没有图标的项目，画一枚**认得出是哪个**的字母牌。
 *
 * 今天所有取不到图标的项目共用同一枚灰色 `GitBranch`／`Folder`（ProjectIcon.tsx）。Rail 上十个项目
 * 就是十枚一模一样的字形——这一列不提供任何识别力，只占宽度。Rail 的既有规矩正是这条：本机 host
 * 不占位，因为「每行都写 `This Mac` 的一列区分不了任何东西」（见 WorkspaceSidebar 那条注释）。
 * 同一条规矩用在图标上，结论就是这个文件。
 *
 * 两件事都必须**确定性**：同一个项目每次渲染、每次重启、每个窗口都得是同一个字母同一个颜色。
 * 颜色若随渲染顺序变，这枚牌子就不是身份而是噪声——那正是设计明令禁止的「按渲染顺序取色」。
 *
 * 纯函数、不读时钟、不读 DOM：本仓测试用 `renderToStaticMarkup`，effect 不跑，写在组件里的分支
 * 没有断言够得着。
 */

import { speakerColorHue } from './conversation-avatar-color'

/**
 * 取首个**字素簇**，不是首个 UTF-16 码元。
 *
 * `name[0]` 在两类真实项目名上直接出错，且错得难看：
 * - `"🚀 deploy"` → 取到孤立的高代理项（`\ud83d`），渲染成 `�`。
 * - `"  spaced"` → 取到一个空格，牌子上空无一物。
 * 家族 emoji（`👨‍👩‍👧`，带 ZWJ 的多码点簇）同理会被劈开。
 *
 * `Intl.Segmenter` 是平台自带的正确答案，Electron 43 的 V8 早已支持（ECMA-402，Chrome 87+），
 * 因此不引库、不手写代理对拼接——爬梯子到「原生平台能力」这一级就停。
 *
 * 先 `trim()` 再取：前导空白是名字的排版噪声，不是它的首字母。
 */
function firstGrapheme(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return [...segmenter.segment(trimmed)][0]?.segment ?? ''
}

/**
 * 牌面上的那一个字。取不到就是空串——**不编一个 `?` 或 `#`**：那些字符看起来像一个真的首字母，
 * 而事实是这个名字没给我们任何可显示的东西。空串让调用方退回原本的图形字形，如实表示
 * 「这里没有可用的字母」。
 *
 * 大写只对有大小写概念的书写系统生效；中日韩与 emoji 经 `toLocaleUpperCase` 原样通过。
 */
export function projectMonogram(name: string): string {
  return firstGrapheme(name).toLocaleUpperCase()
}

/**
 * 牌面的色相。直接复用说话人头像那套派生，**不新造一份调色板**。
 *
 * 复用是对的，因为两处要解的是同一道题：开放集身份要稳定上色，且**不能撞上语义色**——
 * amber 专表「需要你」、red 表失败、green 表成功、blue 表人类说话人。一枚落在 40° 的项目图标
 * 会被读成「这个项目在等你」，而它其实只是名字散列到了那里。身份色误报状态，比撞色难查得多。
 * 那套推理与实现（FNV-1a + avalanche + 保留弧补集）在 conversation-avatar-color.ts 里已经完整
 * 论证并被测试钉住，原样拿来用即可。
 *
 * 键取 `workspaceId` 而不是项目名：改个名字不该换一枚颜色——身份没变。
 */
export function projectIconHue(workspaceId: string): number {
  return speakerColorHue(workspaceId)
}
