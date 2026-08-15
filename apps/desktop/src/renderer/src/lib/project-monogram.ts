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
 * 先剥前缀再取。剥的是**两类**东西，它们都会让牌面空无一物，但 `trim()` 只认识其中一类：
 * - 空白：前导空格是名字的排版噪声，不是它的首字母。`trim()` 认识普通空格、NBSP、表意空格
 *   `　`、BOM（实测四者都被剥掉）。
 * - **零宽字符**：`trim()` **不**认识 U+200B。实测 `projectMonogram('​project')` 返回
 *   U+200B——一枚完全看不见的牌子，正是本函数存在要消灭的那个结果。零宽空格是富文本复制粘贴
 *   的常见污染物，会跟着项目名一路进来。
 *
 * 只剥**前导**的零宽字符，不做全串替换：U+200D 在串中间是承重的（`👨‍👩‍👧` 靠它连成一个簇），
 * 全局剥掉会把家族 emoji 拆散——那正好是上面那条要守的东西。
 */
const LEADING_ZERO_WIDTH = /^[​-‍⁠﻿]+/u

function firstGrapheme(value: string): string {
  const trimmed = value.replace(LEADING_ZERO_WIDTH, '').trim()
  if (!trimmed) return ''
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return [...segmenter.segment(trimmed)][0]?.segment ?? ''
}

/**
 * 牌面上的那一个字。取不到就是空串——**不编一个 `?` 或 `#`**：那些字符看起来像一个真的首字母，
 * 而事实是这个名字没给我们任何可显示的东西。空串让调用方退回原本的图形字形，如实表示
 * 「这里没有可用的字母」。
 *
 * 大写钉死 `'en-US'`，**不跟随宿主 locale**。这看起来很小，但它正是这个函数的立身之本：牌子要
 * 表达「身份」，而身份不能因为谁的机器语言设置不同就变样。实测无参 `toLocaleUpperCase()` 在
 * 土耳其语环境下把 `istanbul` 变成 `İSTANBUL`（带点的 I），英语环境下是 `ISTANBUL`——同一个项目
 * 在两台机器上两个字。渲染层没有统一 locale（`LC_ALL=C` 只钉在 main 进程的 git 子进程上），所以
 * 这不是假想。与色相取 `workspaceId` 而不是项目名是同一条道理：同一个身份，到哪儿都得长一样。
 *
 * 大写后再取一次首簇，因为大写可能**把一个字变成两个**：`ß` → `SS`、`ﬁ` → `FI`。牌面只有一格，
 * 与其让 `overflow:hidden` 裁掉半个字母，不如如实只画第一个。
 *
 * 中日韩与 emoji 经 `toLocaleUpperCase` 原样通过——它们没有大小写概念。
 */
export function projectMonogram(name: string): string {
  return firstGrapheme(firstGrapheme(name).toLocaleUpperCase('en-US'))
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
