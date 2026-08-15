import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { allStyleRules, allStyles } from './helpers/styles.js'

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
//
// 扫描面是**两半**：`.tsx` 的 className= 属性，以及 `.ts` 里拼 class 的取值函数（见 libClasses）。
// 第二半是后补的，因为第一半单独存在时，「把 class 名从 JSX 搬进一个 lib 函数」就是一条绕过整道
// 守卫的合法路径——b2909b7 真的这么搬过一次，此后删掉 agent.css 的基类规则 25 条全绿（实测）。

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
 *
 * `-button` 结尾的扁平名同样按定义是样式名，所以一并收进来。它们不带 BEM 记号，此前整族在
 * 扫描面之外——不是漏登记，是**结构性缺席**：判据只认 `__`/`--`，扁平名连被登记的机会都没有。
 * 实证代价：`.secondary-button`（密度合同里 Secondary 那一档的档位名，真正的落地类名是
 * `.small-button`）在启动页渲染了一次、全仓零规则，而 base.css 的全局 `button` 只重置
 * `font`/`color` **不重置 `background`**，于是它落到 macOS 原生按钮样式——深色主题里一颗浅灰
 * 实心药丸，比紧邻的品牌绿主操作还重。整族守卫全绿。
 *
 * 选 `-button` 而不是"所有扁平名"：控件档位的名字按定义必须有规则（它就是那一档的视觉），
 * 而 `project-rail` 那类语义标记按定义不必有。这条判据仍然从名字形状推出，不维护清单。
 */
function isBemToken(token: string): boolean {
  return token.includes('__') || token.includes('--') || token.endsWith('-button')
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

/** 只取 `.ts`（不含 `.tsx`，那些由 tsxFiles 收）。 */
function libFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...libFiles(path))
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

/**
 * 取值层（`.ts`）里拼出来的 class。
 *
 * 为什么必须有这一半：上面那半只扫 `.tsx` 的 `className=`，于是**把 class 名从 JSX 搬进一个
 * lib 函数，就等于把它搬出了这道守卫的视野**。实测过（b2909b7 之后）：
 * `permissionTierClassName` 把 `agent-interaction__tier` 从 AgentInteractionCard.tsx 的
 * className 模板里挪进 agent-interaction-plan.ts 的 `const base = '...'`，此后删掉 agent.css
 * 里那条基类规则（正是提供中性 `var(--text-3)` 底色、让「未声明风险档」这件事可见的那条），
 * 三个相关 suite **25 条全绿**。搬走内容的同时也搬走了守卫——记忆 extracting-to-lib-only-fixes-half
 * 的一个新形态。
 *
 * 判据用真 TS parser 取字符串字面量，不用正则：正则要么漏掉模板字面量的静态段，要么把注释里
 * 提到的 class 名也算进来（本文件上半已经因此要先 strip 注释）。parser 天然只看代码里的字面量，
 * 注释不是 AST 节点。
 */
function libClasses(): Rendered[] {
  const out: Rendered[] = []
  for (const file of libFiles(COMPONENTS_DIR)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const relative = file.slice(COMPONENTS_DIR.length + 1)
    const tokens = new Set<string>()
    const visit = (node: ts.Node): void => {
      // 三种承载静态文本的字面量：普通串、无插值反引号、以及带插值模板的每一个静态段
      // （`${base}--${tier}` 这种拼法里，`--` 段本身不是 class token，会被 looksLikeClass 挡掉；
      // 而 `agent-interaction__tier` 作为 TemplateHead 的文本能被收到）。
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        addTokens(node.text, tokens)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
    for (const token of tokens) out.push({ token, file: relative })
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

/**
 * 一个**在场标志**：`data-x={cond ? '' : undefined}` —— 取值只有"空串"与"不在场"两种。
 *
 * 这个记号和 BEM 一样是**按定义**成立的，所以同样不需要手工例外清单：一个只在空串与不在场之间
 * 切换的属性对 JS 携带零信息（`el.dataset.x` 拿到的是 `''` 或 `undefined`，两者都不是数据），
 * 它存在的唯一理由就是被 `[data-x]` 选中。反过来，带真实取值的
 * `data-status={item.status}` / `data-tree-path={path}` 这些既可能是样式钩子、也可能是 JS 或
 * 测试的抓手，不在本判据范围内。
 *
 * 判定必须**逐元素**成对，不能只问"这个属性名在样式表里出现过吗"：那正是事故那条的形状——
 * 删掉 `.log-fold[data-open] .log-fold__chevron` 之后，`[data-open]` 因为
 * `.log-row__chevron[data-open]` 还在而依然"出现过"，于是按属性名判的检查全绿，而折叠箭头永久
 * 不转。所以这里取「同一个 JSX 元素上的 class」×「该元素的在场标志」，去样式表里找
 * `.那个class[data-那个标志]`（同一段选择器内，不跨越逗号与空格）。
 */
type PresenceFlag = { attribute: string; classes: string[]; file: string }

const PRESENCE_FLAG = /data-([a-z][a-z0-9-]*)\s*=\s*\{[^{}]*\?\s*''\s*:\s*undefined\s*\}/g

function presenceFlags(): PresenceFlag[] {
  const out: PresenceFlag[] = []
  for (const file of tsxFiles(COMPONENTS_DIR)) {
    const source = readFileSync(file, 'utf8')
      .replace(STYLES_ONLY_IN_COMMENT, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const relative = file.slice(COMPONENTS_DIR.length + 1)
    for (const match of source.matchAll(PRESENCE_FLAG)) {
      // 同一个 JSX 元素的 class：从这个属性往前回溯到最近的 `<`，那一段就是该元素的属性表。
      const openTag = source.lastIndexOf('<', match.index!)
      const attributes = source.slice(openTag, match.index!)
      const classes = new Set<string>()
      for (const literal of attributes.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{[^{}]*`([^`]*)`)/g)) {
        addTokens(literal[1] ?? literal[2] ?? literal[3]!, classes)
      }
      out.push({ attribute: match[1]!, classes: [...classes], file: relative })
    }
  }
  return out
}

/** 样式表里是否有一段选择器同时选中这个 class 与这个在场标志。 */
function hasPairedRule(css: string, className: string, attribute: string): boolean {
  return new RegExp(
    `\\.${className}\\[data-${attribute}(?:[\\]=]|$)|\\[data-${attribute}[^\\]]*\\]\\.${className}(?![\\w-])`
  ).test(css)
}

describe('渲染出来的 class 必须有规则', () => {
  const defined = definedClasses()
  // 两半合起来才是完整的产出面：`.tsx` 的 className= 与 `.ts` 里拼 class 的取值函数。
  // 只取前者，就等于「把 class 名搬进 lib」是一条绕过这道守卫的合法路径。
  const rendered = [...renderedClasses(), ...libClasses()]
  const renderedBem = rendered.filter((entry) => isBemToken(entry.token))

  // 历史遗留（都经过三查：git 证实从未有过规则，因此不是「重构丢规则」那类回归，而是无害的
  // 多余标记 / 语义 hook）。它们不是 offenders，被主断言的 filter 排除。它们**不是**一份
  // 「允许无规则」的白名单——它们本就不带样式意图，只是恰好用了 BEM 记号来命名。
  //
  // 提到 describe 层是为了让下面那条存活性自检能读到同一份集合。豁免表若不逐条复验，就是一个
  // 永久的洞：条目对应的 class 哪天不再被渲染、或长出了规则，这张表都不会有任何反应，而那两种
  // 情况恰好是这道守卫本该抓的两类漂移。本仓在 core-export-reachability / lib-export-reachability
  // 里都为豁免表配了存活性自检，这里此前是唯一的例外（实测两个变异都存活，见下面那条 it）。
  const KNOWN_UNSTYLED_MARKERS = new Set([
    'activity-log__segment', // 滚动锚点，位置由 ref/IntersectionObserver 用，从无规则
    'agent-catalog__group--unavailable', // 仅语义分组名，样式全在基类 .agent-catalog__group 上
    'agent-status-bar__label', // 纯文本 span，视觉继承自 .agent-status-bar，从无独立规则
    'board--matrix', // 布局全在基类 .board 上，matrix 变体从无独立规则
    'launch-terminal__fallback', // 样式全在同元素的 .launch-quick-card 上，此名从无规则
    'scratch-workspace-row__identity', // 与已有规则的 .project-rail-row__identity 同挂一个元素
    'workbench-tab__rename', // 见下：唯一存疑项，已在报告中单列
    'workspace-composer__fields--project', // 布局全在基类 .workspace-composer__fields 上
    'workspace-workbench--merged' // rootIsLeaf 分支才挂，样式全在基类 .workspace-workbench 上
  ])

  it('扫描确实扫到了东西——空集上的扫描是这个仓库经典的假绿', () => {
    // 一个静默地什么都没扫到的守卫，比没有守卫更糟：它会永远绿着，掩盖住它本该守的洞。
    expect(defined.size).toBeGreaterThan(100)
    expect(rendered.length).toBeGreaterThan(100)
    // BEM class 是这条测试真正判定的对象，单独钉一个现实下界。
    expect(new Set(renderedBem.map((entry) => entry.token)).size).toBeGreaterThan(100)
  })

  it('`-button` 那一支确实有产出——判据放宽了却扫到空，等于没放宽', () => {
    // isBemToken 多收了 `-button` 结尾的扁平名。这条钉住那一支真的在扫描面里有东西：
    // 若哪天 className 的写法变了（比如档位名全搬进 lib 的常量、或改成模板拼接），这一支会
    // 静默退化成空集，而主断言依旧全绿——正是它本该守住的那个洞的形状。
    //
    // 同时钉住"扁平"这一半：只数带 `__`/`--` 的 `-button` 名字不算数，那些名字原判据就收得到，
    // 放宽与否都一样。必须有**只有放宽之后才看得见**的 token，这条才有区分力。
    const flatButtons = new Set(
      renderedBem
        .map((entry) => entry.token)
        .filter((token) => token.endsWith('-button') && !token.includes('__') && !token.includes('--'))
    )
    expect(flatButtons.size, '没有任何扁平 `-button` 类名被扫到，放宽判据失去了区分力').toBeGreaterThan(0)
  })

  it('取值层（.ts）也在扫描面里——否则把 class 搬进 lib 就能绕过整道守卫', () => {
    // 这条不是凑数：b2909b7 之前 `agent-interaction__tier` 在 AgentInteractionCard.tsx 的
    // className 模板里，之后只在 agent-interaction-plan.ts 的字符串字面量里。若扫描面只有 `.tsx`，
    // 删掉 agent.css 那条基类规则是 25 条全绿（实测）。所以这里钉住 lib 侧真的有产出，
    // 且**至少有一个 BEM token 只有 lib 侧才看得见**——纯粹「lib 扫到了东西」还不够，
    // 那可能全是 .tsx 也各自渲染过的重复项，删掉 libClasses() 仍然全绿。
    const fromTsx = new Set(renderedClasses().filter((e) => isBemToken(e.token)).map((e) => e.token))
    const onlyInLib = libClasses()
      .filter((entry) => isBemToken(entry.token) && !fromTsx.has(entry.token))
      .map((entry) => `${entry.token}  <- ${entry.file}`)
      .sort()
    expect(onlyInLib.length, 'lib 侧没有任何独有的 BEM class，这条自检失去了区分力').toBeGreaterThan(0)
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

    const surprises = offenders.filter(
      (line) => !KNOWN_UNSTYLED_MARKERS.has(line.split('  <- ')[0]!)
    )

    // 主断言：任何**新出现**的「渲染了却没规则」的 BEM class 都会让这里变红，并直接点名。
    expect(surprises).toEqual([])
  })

  it('豁免表的每一条都仍然成立：仍被渲染、且仍然没有规则', () => {
    // 豁免的前提是「这个 class 被渲染了，但它本就不带样式意图」。前提有两半，各自都会过期：
    //   - 不再被渲染 → 这条豁免从此指向一个不存在的 class，是一个永久的死条目；
    //   - 长出了规则 → 那条注释（「从无独立规则」）成了假话，而它是别人判断要不要动这个
    //     class 的依据。更要紧的是：规则今天有、明天被重构删掉，这个 class 会静默回到
    //     「渲染了却没规则」，而主断言因为豁免永远看不见它——正是这道守卫存在的理由。
    //
    // 一条断言同时报两种漂移，而不是拆成两条：拆开后先抛的那条会让后面成为死代码（本仓
    // subsuming-assertion / two-throws-in-one-it 两次踩过），而这里两种漂移是独立发生的。
    const renderedTokens = new Set(rendered.map((entry) => entry.token))
    const drifted = [...KNOWN_UNSTYLED_MARKERS]
      .map((token) => {
        if (!renderedTokens.has(token)) return `${token}: 已经没有任何地方渲染它——删掉这条豁免`
        if (defined.has(token)) return `${token}: 现在有规则了——删掉这条豁免，让它回到主断言的守备范围`
        return null
      })
      .filter((line): line is string => line !== null)
      .sort()
    expect(drifted, '豁免表有条目的前提已不成立').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 上面那族只判**选择器名在不在**。它看不见规则体：删掉
// `.log-fold[data-open] .log-fold__chevron { transform: rotate(90deg); }`（:162 那条 transition
// 保留），折叠箭头永久不转，而上面 3 条 + stylesheet-organisation 8 条**全绿**（实测）。
//
// 最刺的是：这条测试自己的事故叙事（本文件开头）讲的就是"折叠箭头悄悄不转了"——那正是一次
// 声明体层面的丢失，恰恰是名字存在性检查看不见的形态。守卫写的是它自己那次事故防不住的形状。
//
// 这里补上按元素成对的判定。它不试图解析所有声明体（那需要一份"哪些声明承重"的手工清单，而
// 手工清单只是熵），而是抓住**在场标志**这一类按定义必须成对的东西。
// ---------------------------------------------------------------------------

describe('在场标志必须有选中它的规则', () => {
  const css = allStyles().replace(STYLES_ONLY_IN_COMMENT, '')
  const flags = presenceFlags()

  it('扫描确实扫到了东西——空集上的扫描是这个仓库经典的假绿', () => {
    expect(flags.length).toBeGreaterThan(5)
    // 每一处都认出了它所在元素的 class，否则下面的配对判定会因为"没有 class 可配"而恒绿。
    expect(flags.every((flag) => flag.classes.length > 0)).toBe(true)
  })

  it('自证判据认得出成对与不成对：按元素判，不按属性名判', () => {
    // 成对的样本：事故那一对。
    expect(hasPairedRule(css, 'log-fold', 'open')).toBe(true)
    // 不成对的样本，且**属性名在样式表里确实存在**（`.log-row__chevron[data-open]` 就在
    // activity.css:198）。一个按属性名判的检查会在这里错误地返回 true——那正是事故的形状。
    expect(css).toContain('[data-open]')
    expect(hasPairedRule(css, 'activity-log__segment', 'open')).toBe(false)
    // 类名前缀不算：`.log-fold[data-open]` 不能让 `log-fol` 蒙混过关。
    expect(hasPairedRule(css, 'log-fol', 'open')).toBe(false)
  })

  it('每个在场标志都在样式表里被它自己那个元素的选择器选中', () => {
    const offenders = flags
      .filter((flag) => !flag.classes.some((className) => hasPairedRule(css, className, flag.attribute)))
      .map((flag) => `data-${flag.attribute} on .${flag.classes.join('.')}  <- ${flag.file}`)
      .sort()

    // 无例外清单：一个只有空串与不在场两种取值的属性，没有第二种存在理由。渲染了它却没有
    // `[data-x]` 规则，要么是规则在重构里丢了（那就是回归），要么这个属性本就是多余的（那就该删）。
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 上面两族判「这个 class 有没有规则」「这条规则有没有选中它」。第三族再深一层：规则在场、
// 也选中了它，但**少一条承重声明**。Portal 浮层的 z-index 就是这一格。
//
// 为什么是 z-index 而不是别的声明：Radix 的 Portal 把内容挂到 `document.body` 下，那个容器
// 自己没有 z-index，于是这一层完全由浮层自己那条规则决定——不写就是 `auto`，只按文档顺序排，
// 输给任何定位过的邻居。#468 的实测形状：`.agent-roster` 与 `.resource-usage` 都没写 z-index，
// z-index 36 的 `.terminal-service-window` 整块盖在面板上。而"点开的面板被别的东西盖住"这件事
// 没有任何行为测试看得见——本仓没有布局引擎，Portal 在 renderToStaticMarkup 下根本不渲染。
//
// 顺便记一个当时差点得出反向结论的判据错误：第一版探针用 `elementFromPoint` 判遮挡，它报告
// "一切正常"。真因是终端链接预览带 `pointer-events: none`（terminal.css:35），命中测试会跳过它。
// 换成截图取色（`capturePage().toBitmap()`）才看见真相。判遮挡要看画出来的像素，不看命中测试。
// ---------------------------------------------------------------------------

/** 一条 Portal 浮层：它自己的 class 们、来自哪个文件、Radix 的哪套原语。 */
type PortalLayer = { classes: string[]; file: string; primitive: string }

/**
 * 每个 `*.Portal` 里最外层带静态 className 的元素——那一层就是浏览器眼里的浮层根。
 *
 * 判据按**结构**取（"Portal 下最外那层"），不按 `*.Content` 这个标签名取：标签名是 Radix 的
 * 命名，换一版库或换一套原语（Dialog 还有 `*.Overlay`）就漏。取到第一层带 className 的就停，
 * 不往里钻——里面的元素在浮层根建立的层里，各自的 z-index 与遮挡无关。
 */
function portalLayers(): PortalLayer[] {
  const out: PortalLayer[] = []
  for (const file of tsxFiles(COMPONENTS_DIR)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const relative = file.slice(COMPONENTS_DIR.length + 1)
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source).endsWith('.Portal')) {
        const primitive = node.openingElement.tagName.getText(source).split('.')[0]!
        const descend = (inner: ts.Node): void => {
          if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner)) {
            const opening = ts.isJsxElement(inner) ? inner.openingElement : inner
            const attribute = opening.attributes.properties.find(
              (property) => ts.isJsxAttribute(property) && property.name.getText(source) === 'className'
            ) as ts.JsxAttribute | undefined
            if (attribute) {
              const initializer = attribute.initializer
              out.push({
                classes:
                  initializer && ts.isStringLiteral(initializer)
                    ? initializer.text.split(/\s+/).filter(Boolean)
                    : [],
                file: relative,
                primitive
              })
              return // 到浮层根就停
            }
          }
          ts.forEachChild(inner, descend)
        }
        ts.forEachChild(node, descend)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
  }
  return out
}

/**
 * 这些 class 合起来最终生效的 z-index；一条都没写时 null。
 *
 * 三处都是实测过的坑：
 *  1. 选择器必须**整条相等**。`/\.agent-roster\s*\{/` 这种子串正则会被
 *     `.branch-row .selector-row__leading` 那样的**兄弟规则**满足——删掉 selector.css 里那条
 *     `.selector-row__leading`，正则仍命中 source-control.css 的后代选择器，兄弟规则替被删的
 *     规则作了保（本轮实测存活的变异 M5）。所以只认裸类选择器 `.foo`，`.a .foo` / `.a.foo` 都不算：
 *     后者要多一个祖先或另一个类同时在场才生效，兑现不了"这一层无条件有 z-index"。
 *  2. 取**最后**一条而不是第一条：同特异度的裸类规则按层叠顺序后来者胜，而 allStyleRules() 就是
 *     按 index.css 的 @import 顺序拼的。注意这一条**今天没有断言守着**——全表只有
 *     `.board-matrix__corner` 一个类被两条裸规则各写了一次 z-index，而它不是 Portal 浮层，所以
 *     "取第一条"与"取最后一条"对本判据的每个输入都同值（实测：改成 first-wins 仍 10 条全绿）。
 *     不为它编一个更聪明的测试：循环里直接覆写本就是最短写法，改成 first-wins 反而要**多加**
 *     一个条件，所以这里不存在"没人守的多余分支"，只是这条正确语义暂时不可观测。
 *  3. 走 allStyleRules()（已剥注释）。一条规则解释自己为何存在的注释里往往逐字写着声明，
 *     按原文判"在不在场"会被自己的注释满足（见 helpers/styles.ts 的 stripCssComments）。
 */
function resolvedZIndex(classes: string[]): number | null {
  let resolved: number | null = null
  for (const [, selectors, body] of allStyleRules().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectsBareClass = selectors!.split(',').some((one) => {
      const bare = one.trim().match(/^\.([\w-]+)$/)
      return bare !== null && classes.includes(bare[1]!)
    })
    if (!selectsBareClass) continue
    const declared = body!.match(/(?:^|;)\s*z-index\s*:\s*([^;]+)/)?.[1]?.trim()
    if (declared !== undefined) resolved = Number(declared)
  }
  return resolved
}

describe('Portal 浮层必须自己声明层级', () => {
  const layers = portalLayers()
  // 菜单档的锚点。取 `.tab-context-menu` 而不是写死一个数字：它是被六个菜单复用的那条基类，
  // 是这一档事实上的 SSOT。数字写死在测试里就是把同一个常量抄到第三个地方。
  const MENU_FLOOR_ANCHOR = 'tab-context-menu'

  it('扫描确实扫到了东西——空集上的扫描是这个仓库经典的假绿', () => {
    expect(layers.length).toBeGreaterThan(10)
    // 每一层都认出了它自己的 class，否则下面的判定会因为"没有 class 可查"而恒绿。
    expect(layers.every((layer) => layer.classes.length > 0)).toBe(true)
    // 两套原语都在扫描范围内：菜单（DropdownMenu/ContextMenu）与对话（Dialog）各自的层级规矩不同，
    // 少扫一套就等于那一套完全无人守。
    const primitives = new Set(layers.map((layer) => layer.primitive))
    expect([...primitives].some((one) => one.endsWith('Menu'))).toBe(true)
    expect(primitives.has('Dialog')).toBe(true)
  })

  it('自证判据认得出「写了」与「没写」，且不接受后代选择器代劳', () => {
    // 写了的样本：本轮 #468 修的那两个，加上菜单基类。
    expect(resolvedZIndex(['agent-roster'])).not.toBeNull()
    expect(resolvedZIndex(['resource-usage'])).not.toBeNull()
    expect(resolvedZIndex([MENU_FLOOR_ANCHOR])).not.toBeNull()
    // 没写的样本，且它**有一条自己的裸类规则**——一个只查"选择器名在不在"的检查会在这里
    // 错误地放行。`.branch-context-menu` 只补菜单基类之外的细节，层级由基类给。
    expect(allStyleRules()).toContain('.branch-context-menu')
    expect(resolvedZIndex(['branch-context-menu'])).toBeNull()
    // 后代/复合选择器不算：`.workspace-topic-item.dragging` 里有 z-index，但单独一个
    // `dragging` 在场兑现不了任何层级。
    expect(allStyleRules()).toMatch(/\.dragging[^{,]*\{[^}]*z-index/)
    expect(resolvedZIndex(['dragging'])).toBeNull()
    // 多个 class 里只要有一个写了就算这一层写了——菜单们正是靠基类拿到层级的。
    expect(resolvedZIndex(['branch-context-menu', MENU_FLOOR_ANCHOR])).toBe(
      resolvedZIndex([MENU_FLOOR_ANCHOR])
    )
  })

  it('每个 Portal 浮层都有自己的 z-index——不写就是 auto，输给任何定位过的邻居', () => {
    const offenders = layers
      .filter((layer) => resolvedZIndex(layer.classes) === null)
      .map((layer) => `.${layer.classes.join('.')}  <- ${layer.file} (${layer.primitive})`)
      .sort()
    // 无例外清单：Portal 挂到 body 下就没有祖先能替它决定层级，所以"这一层不需要 z-index"
    // 不存在成立的情形。#468 正是这条断言当时会报出的那两行。
    expect([...new Set(offenders)]).toEqual([])
  })

  it('菜单档不低于菜单基类——菜单是"点开就该压住一切"的那一档', () => {
    // 只对菜单立地板，不对 Dialog 立：Dialog 有自己的遮罩+内容阶梯（讨论画布 60/61 就刻意排在
    // 设置页 90 之下，它开在 Board 里而非全窗之上），把它们一起量会把一个刻意的取舍报成缺陷。
    // 菜单不同：它由一次点击唤出、瞬时、盖住底下任何东西才是对的，所以同一档共用一个地板。
    const floor = resolvedZIndex([MENU_FLOOR_ANCHOR])
    expect(floor, `${MENU_FLOOR_ANCHOR} 不再声明 z-index 了，这一档的锚点没了`).not.toBeNull()
    const tooLow = layers
      .filter((layer) => layer.primitive.endsWith('Menu'))
      .map((layer) => ({ layer, z: resolvedZIndex(layer.classes) }))
      .filter(({ z }) => z !== null && z < floor!)
      .map(({ layer, z }) => `.${layer.classes.join('.')} z-index:${z} < ${floor}  <- ${layer.file}`)
      .sort()
    expect([...new Set(tooLow)]).toEqual([])
  })
})

