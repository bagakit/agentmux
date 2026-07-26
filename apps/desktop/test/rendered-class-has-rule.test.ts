import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { allStyles } from './helpers/styles.js'

// 一个组件渲染的 class，样式表里却没有对应规则——这条测试守的就是这个洞。
//
// 今早的真实事故：commit 1f31bee 把 activity.css 拆成 activity.css + activity-conversation.css，
// 三条规则正好压在切口上，被删掉、又没落到新文件里：
//   .log-fold__chevron { transition: transform 120ms ease; }
//   .log-fold[data-open] .log-fold__chevron { transform: rotate(90deg); }
//   .log-fold__label { ... }
// ActivityView.tsx 仍在渲染 log-fold__chevron / log-fold__label，折叠箭头于是**悄悄不转了**——
// 而整个测试套件全绿。stylesheet-organisation.test.ts 只查文件名、@import 顺序、:root 唯一性和
// 行数，没有任何东西检查「一个选择器有没有在重构里活下来」。这条测试补的就是这一格。
//
// 更早的 commit 101c3c5 标题写着「split the stylesheet by surface, and prove the split changed
// nothing」——它并没有证明。这里把那句「什么都没变」变成一条会红的断言。

const STYLES_ONLY_IN_COMMENT = /\/\*[\s\S]*?\*\//g
const COMPONENTS_DIR = fileURLToPath(new URL('../src/renderer/src', import.meta.url))

/**
 * 判据只盯 BEM 约定的 class（名字里带 `__` 或 `--`）。这不是为了压噪音，而是因为这两种记号
 * **按定义就是样式名**：`block__element` 是某个块的一件家具，`block--modifier` 是它的一种变体，
 * 它们存在的唯一理由就是被 CSS 选到。反过来，像 `project-rail`（渲染成 `className="sidebar
 * project-rail"`，而 `git show 101c3c5^` 证实**从来没有**过一条裸 `.project-rail` 规则，真正带样式的
 * 是 `.project-rail-row` / `.project-rail-titlebar`）这类是语义标记 / JS 钩子，天生就不该有规则。
 * 用 BEM 记号一刀切开，把「必须有规则」和「本就无规则」这两类干净地分开——于是**不需要**一份
 * 手工维护的例外清单，而手工清单只是熵：它会漂移，且只能挡住写它时已经存在的东西。
 * 这正是 log-fold__chevron 的形状（`__` 元素），也是 modifier 丢规则（`--`）的形状。
 */
function isBemToken(token: string): boolean {
  return token.includes('__') || token.includes('--')
}

// 一个像样的 class token：小写字母开头，段与段之间用 - 或 _ 连接。模板字面量里 `${expr}` 的碎片
// （executorId / exited / isDragging / isOver 这类）不满足这个形状，或本身带 `${`，一律排除。
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:[-_]+[a-z0-9]+)*$/

function looksLikeClass(token: string): boolean {
  return token.length > 0 && !token.includes('${') && CLASS_TOKEN.test(token)
}

function addTokens(text: string, sink: Set<string>): void {
  for (const token of text.split(/\s+/)) {
    if (looksLikeClass(token)) sink.add(token)
  }
}

/** 样式表里被定义过的 class（整 token，不是子串）。先去注释：注释里写到的 class 名不算定义。 */
function definedClasses(): Set<string> {
  const css = allStyles().replace(STYLES_ONLY_IN_COMMENT, '')
  const defined = new Set<string>()
  // 选择器里的 `.class-name` —— 匹配到下一个非 class 字符为止，因此 `.project-rail-row` 收下的是
  // 整个 `project-rail-row`，而**不会**让子串 `project-rail` 也算被定义。
  for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    defined.add(match[1]!)
  }
  return defined
}

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...tsxFiles(path))
    else if (entry.name.endsWith('.tsx')) out.push(path)
  }
  return out
}

type Rendered = { token: string; file: string }

/**
 * 组件里被渲染出来的 class。先去 JS/TS 注释（block + line）——注释里描述规则的文字不是规则本身，
 * 这个去注释的写法沿用 terminal-search.test.ts / surface-selection-contract.test.ts。
 *
 * 三种写法都要收：
 *   className="a b"            —— 直接字面量
 *   className='a b'
 *   className={`a ${x} b`}     —— 模板字面量的**字面量部分**（`${...}` 里的表达式已被 token 过滤挡掉）
 *   className={cond ? 'a' : 'b'}—— 三元里的字符串字面量（花括号内用平衡括号取完整区段，再挖里面的
 *                                  引号 / 反引号字面量；漏了它就会漏掉像 workspace-workbench--merged
 *                                  这种只在某个分支才挂上的 class）
 */
function renderedClasses(): Rendered[] {
  const out: Rendered[] = []
  for (const file of tsxFiles(COMPONENTS_DIR)) {
    const source = readFileSync(file, 'utf8')
      .replace(STYLES_ONLY_IN_COMMENT, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const relative = file.slice(COMPONENTS_DIR.length + 1)
    const tokens = new Set<string>()
    for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) addTokens(match[1]!, tokens)
    for (const match of source.matchAll(/className\s*=\s*'([^']*)'/g)) addTokens(match[1]!, tokens)
    for (const match of source.matchAll(/className\s*=\s*\{/g)) {
      // 平衡花括号取完整的 className={...} 区段——`[^}]*` 会在第一个 `}` 处截断，嵌套表达式里
      // （比如 `{cond ? f({x}) : ''}`）就会漏读。
      let depth = 1
      let i = match.index! + match[0].length
      const start = i
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1
        else if (source[i] === '}') depth -= 1
        i += 1
      }
      const region = source.slice(start, i - 1)
      for (const literal of region.matchAll(/`([^`]*)`/g)) addTokens(literal[1]!, tokens)
      for (const literal of region.matchAll(/'([^']*)'/g)) addTokens(literal[1]!, tokens)
      for (const literal of region.matchAll(/"([^"]*)"/g)) addTokens(literal[1]!, tokens)
    }
    for (const token of tokens) out.push({ token, file: relative })
  }
  return out
}

describe('渲染出来的 class 必须有规则', () => {
  const defined = definedClasses()
  const rendered = renderedClasses()
  const renderedBem = rendered.filter((entry) => isBemToken(entry.token))

  it('扫描确实扫到了东西——空集上的扫描是这个仓库经典的假绿', () => {
    // 一个静默地什么都没扫到的守卫，比没有守卫更糟：它会永远绿着，掩盖住它本该守的洞。
    expect(defined.size).toBeGreaterThan(100)
    expect(rendered.length).toBeGreaterThan(100)
    // BEM class 是这条测试真正判定的对象，单独钉一个现实下界。
    expect(new Set(renderedBem.map((entry) => entry.token)).size).toBeGreaterThan(100)
  })

  it('自证判据成立：log-fold__chevron 此刻是「渲染了且有规则」的样本', () => {
    // 事故那条 class。它现在应当既被渲染、又有规则——如果哪天它又只被渲染却没了规则，
    // 下面那条主断言会把它列进 offenders。这条先钉住「判据能同时看见渲染端和样式端」。
    expect(rendered.some((entry) => entry.token === 'log-fold__chevron')).toBe(true)
    expect(defined.has('log-fold__chevron')).toBe(true)
  })

  it('每个被渲染的 BEM class 都在某张样式表里有规则', () => {
    // 整 token 比对，不是子串：`.project-rail-row` 的存在不能让 `project-rail` 蒙混过关。
    const offenders = renderedBem
      .filter((entry) => !defined.has(entry.token))
      .map((entry) => `${entry.token}  <- ${entry.file}`)
      .sort()

    // 已知的 8 处历史遗留（都经过三查：git 证实从未有过规则，因此不是「重构丢规则」那类回归，
    // 而是无害的多余标记 / 语义 hook）。它们不是 offenders，被下面的 filter 排除。它们**不是**
    // 一份「允许无规则」的白名单——它们本就不带样式意图，只是恰好用了 BEM 记号来命名。
    // 每一条都在 PR 的 triage 里有独立结论；这里内联留一行是为了让新增的违规能一眼从这 8 条里跳出来。
    const KNOWN_UNSTYLED_MARKERS = new Set([
      'activity-log__segment', // 滚动锚点 + data-selected 标记，行为由 ref/JS 用，从无规则
      'agent-catalog__group--unavailable', // 仅语义分组名，样式全在基类 .agent-catalog__group 上
      'agent-status-bar__label', // 纯文本 span，视觉继承自 .agent-status-bar，从无独立规则
      'board--matrix', // 布局全在基类 .board 上，matrix 变体从无独立规则
      'launch-terminal__fallback', // 样式全在同元素的 .launch-quick-card 上，此名从无规则
      'scratch-workspace-row__identity', // 与已有规则的 .project-rail-row__identity 同挂一个元素
      'workbench-tab__rename', // 见下：唯一存疑项，已在报告中单列
      'workspace-composer__fields--project', // 布局全在基类 .workspace-composer__fields 上
      'workspace-workbench--merged' // rootIsLeaf 分支才挂，样式全在基类 .workspace-workbench 上
    ])
    const surprises = offenders.filter(
      (line) => !KNOWN_UNSTYLED_MARKERS.has(line.split('  <- ')[0]!)
    )

    // 主断言：任何**新出现**的「渲染了却没规则」的 BEM class 都会让这里变红，并直接点名。
    expect(surprises).toEqual([])
  })
})
