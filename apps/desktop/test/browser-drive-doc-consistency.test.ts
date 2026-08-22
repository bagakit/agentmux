import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGENTMUX_CLI_SKILL } from '../../../packages/core/src/agentmux-cli-help.js'
import { BROWSER_PAGE_CAPABILITY_NAMES } from '@agentmux/core'
import { BROWSER_PAGE_FUNCTION_NAMES } from '../src/main/browser-script-runner.js'

/**
 * 仓里原有三处白纸黑字写着「不做这件事」，与 Agent 结构化驱动页面直接打架。这条守的是改写之后
 * 文档与实现自洽，而不是维护一份手写的「应该写了什么」清单。
 *
 * 断言从**文档来源**反推（AGENTS.md:85-88）：凡是「扫描一批文件找某个形状」的判据，都必须先证明
 * 扫描面非空。空扫描全绿是第三种白绿——两次实测都栽在这里（见 MEMORY「豁免表要配存活性自检」）。
 *
 * 本文件被 git 跟踪，所以**不能出现任何参考项目名**（守卫见 reference-name-containment.test.ts）。
 * 下面对 ideas/index.md 的断言一律按「结构/措辞」判，不按项目名判。
 */

const REPO_ROOT = new URL('../../../', import.meta.url)

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, REPO_ROOT), 'utf8')
}

/**
 * `ideas/` 被 `.git/info/exclude` 挡在版本库外，所以它在一份新 clone 里**不存在**。
 *
 * 这就要求「读不到」与「读到了但没改写」必须是两种结局，而不是同一种。若直接 `readFileSync` 然后
 * try/catch 成 skip，一次真的改丢了也会走同一条 skip 路径——判据被环境噪声伪造成阴性。
 * 所以这里先向 git 求证「它确实是被排除的」，只有确认排除且文件缺席才跳过；文件在场就必须判。
 */
function excludedDocOrSkip(relativePath: string): string | null {
  let excluded = false
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], { cwd: REPO_ROOT })
    excluded = true
  } catch {
    excluded = false
  }
  try {
    return read(relativePath)
  } catch {
    if (excluded) return null
    throw new Error(`${relativePath} 不在盘上，且 git 也不认为它被排除——这不是"本机没这份笔记"，是真丢了`)
  }
}

describe('Agent 驱动页面：文档与实现自洽', () => {
  // ── 一、设计 SSOT 的两处「不新增 Browser Runtime」────────────────────────────────
  //
  // 这两条原判断在「不另建浏览器运行时」这个意义上仍然成立，要精确化不是删除。所以判据是
  // **原句还在** 且 **补上了区分**，两半都要判：只判后者的话，把原句整条删掉也会绿。

  const PLAN_DOC = 'docs/plans/agentmux-agent-native-browser-workspace.md'

  it('设计 SSOT 里两处 Browser Runtime 约束都保留原判断并补上了区分', () => {
    const plan = read(PLAN_DOC)

    // 先证扫描面非空：这两句是被测主题，找不到就说明文档被重排过，断言在对空气生效。
    const runtimeClauses = plan.split('\n').filter((line) => line.includes('Browser Runtime'))
    expect(runtimeClauses.length, '设计 SSOT 里找不到 Browser Runtime 约束句——断言没有作用对象').toBe(2)

    // 每一句都要既保留原约束、又说清新增的是什么。逐句判，不是「整份文档里出现过」——
    // 后者会被另一句的措辞满足，让漏改的那句蒙混过关（MEMORY「在场判据在形状重复时失明」）。
    for (const clause of runtimeClauses) {
      expect(clause, `这句没说清「浏览器仍归 Desktop Main 持有」：${clause.slice(0, 40)}`)
        .toMatch(/Desktop Main/)
      expect(clause, `这句没区分出「新增的是执行脚本的子进程，不是浏览器」：${clause.slice(0, 40)}`)
        .toMatch(/子进程/)
    }
  })

  it('设计 SSOT 的非目标里写明了不做坐标模拟、改做结构化驱动', () => {
    const plan = read(PLAN_DOC)
    expect(plan, '非目标里没有「不做坐标级键鼠模拟」这条').toMatch(/不做坐标级的键鼠模拟/)
    expect(plan, '只说了不做什么、没说改做什么——那就还是单纯的不干').toMatch(/结构化 ref 寻址/)
  })

  // ── 二、CLI help 的禁令位置：citation 必须指向真正的禁令行 ──────────────────────
  //
  // 这条不读文档，读**代码**，因为要证的恰恰是「文档里引的行号对不对」。行号从源码现算，
  // 不手抄——手抄一个数字就是下一次漂移的种子（MEMORY「构建图之外的手抄常量」）。

  it('CLI help 的键鼠自动化禁令确实在文档新引的那两行上', () => {
    const help = read('packages/core/src/agentmux-cli-help.ts').split('\n')
    // 禁令有两种拼法，两种都要认：T-009 把投递那条从「Do not simulate either payload with keyboard
    // or UI automation.」改写成了「no keystroke synthesis into a terminal」——改写是对的（它把禁令
    // 收窄到"投递 payload"，不再误伤 browser run 驱动页面），但只认 `UI automation` 的判据会看不见
    // 改写后的那一条，于是「笔记引的行号对不对」这件事在那一行上无人可核。
    const prohibitionLines = help
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => /UI automation|keystroke\s*$|keystroke synthesis/.test(entry.line))
      .map((entry) => entry.number)

    // 扫到有收获：禁令句一条都找不到时，下面的比对会拿两个空集相等，恒真。
    expect(prohibitionLines.length, 'CLI help 里一条 UI automation 禁令都没有——citation 无从核对').toBeGreaterThan(0)

    const ideas = excludedDocOrSkip('ideas/index.md')
    if (ideas === null) return

    // 只判 computer use 那一行的 citation。全文件里别的行也引这个源文件（C 段引的是 skill 常量），
    // 它们与本任务无关，一起判会把无关的行号也要求成禁令——那是判据管太宽，不是文档错了。
    const stanceRow = ideas
      .split('\n')
      .find((line) => line.includes('| computer use |'))
    expect(stanceRow, 'F 段 computer use 行不在场——被测的 citation 没有作用对象').toBeDefined()

    // **按句子锚点核，不按行号核。** 这一格的行号引法被改写了九次，每次都只是被禁令上方新加的
    // 文字顶下去了，禁令本身一次没动——判据盯着一个必然漂移的东西，于是它响的时候说的是"文档错了"，
    // 而真相是"文件长高了"。句子锚点只在禁令本身被改写时才需要更新，那正是该更新的时候。
    // 历史行号仍留在那格的散文里（记着这九次），所以这里**不能**再去正文里捞数字。
    // 锚点的取法**不能按内容挑**（比如只认含 keystroke/automation 的那些）：那样一个写错的锚点
    // （`no mouse coordinates`）会因为不含关键词而被静默跳过，于是"引错了"与"没引"在判据眼里一样。
    // 取法改成形状：紧跟在「不按行号：」之后、到该句结束为止的所有反引号片段，全都要能在禁令里找到。
    // 两端都钉：起锚点是「不按行号：」，止锚点是那对括号的开头（括号里是九次历史行号的散文，
    // 不是引用）。任一端不在场就当场红——起锚点没了 indexOf 给 -1，slice 会切出整行；止锚点没了
    // 会把历史散文一起吃进来。两种都会让这条判据看起来仍在工作，实际上在核错误的东西。
    const zoneStart = stanceRow!.indexOf('不按行号：')
    expect(zoneStart, '「不按行号：」这个起锚点不在场').toBeGreaterThan(-1)
    const zoneEnd = stanceRow!.indexOf('（**此格此前反复引行号', zoneStart)
    expect(zoneEnd, '历史行号那段的止锚点不在场——锚点区会把散文一起吃进来').toBeGreaterThan(zoneStart)
    const anchorZone = stanceRow!.slice(zoneStart, zoneEnd)
    const citedAnchors = [...anchorZone.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim())
    expect(citedAnchors.length, 'computer use 行没有引 CLI help 的禁令句锚点——被测的 citation 不在场').toBeGreaterThan(0)
    const prohibitionText = help.filter((_, index) => prohibitionLines.includes(index + 1)).join('\n')
    for (const anchor of citedAnchors) {
      expect(prohibitionText, `笔记引了句锚点「${anchor}」，但 CLI help 的禁令句里没有这句话`).toContain(anchor)
    }
  })

  // ── 三、「绝不抄代码」已废止，但两类真约束必须留下 ─────────────────────────────

  it('照抄禁令已废止，且无 LICENSE 与 copyleft 两类真约束原样保留', () => {
    const ideas = excludedDocOrSkip('ideas/index.md')
    if (ideas === null) return

    expect(ideas, '没有写明「绝不抄代码」已废止').toMatch(/废止/)

    // 废止必须是**有条件**的废止：两条真约束要写在**废止那一段里**，不是全文件某处出现过。
    // 「全文件 toMatch」在这里必假绿——这两个词在下方许可证表里各自还有一行，把废止段落里的
    // 豁免条款整条删掉，全文件判据照样绿（实测变异存活，MEMORY「在场判据在形状重复时失明」）。
    const disciplineHeading = '**参考项目纪律**'
    const disciplineStart = ideas.indexOf(disciplineHeading)
    expect(disciplineStart, '顶部《参考项目纪律》不在场——废止段落没有作用对象').toBeGreaterThan(-1)
    // 右界必须取到：切到文件末尾会让下方许可证表顶上来，等于没有收窄（MEMORY「只取左界的 section 判据」）。
    const disciplineEnd = ideas.indexOf('\n---', disciplineStart)
    expect(disciplineEnd, '《参考项目纪律》之后没有分节线——切片会一路吃到文件末尾').toBeGreaterThan(disciplineStart)
    const discipline = ideas.slice(disciplineStart, disciplineEnd)

    expect(discipline, '废止段落里没保留「无 LICENSE 仅可读机制」这条真约束').toMatch(/无 LICENSE/)
    expect(discipline, '废止段落里没保留 copyleft 这条真约束').toMatch(/copyleft/)

    // 消化要求：拿实现不拿世界观。这是废止之后唯一保留的方法论约束。
    expect(ideas, '没写消化要求——照抄而不消化会把人家的错误模型一起搬进来').toMatch(/消化/)
    expect(ideas, '消化要求里没点名错误模型要换成我方四分类').toMatch(/StepOutcome/)
  })

  it('「结构化 ref 寻址 ≠ 键鼠模拟」被写成了一句成文的线，而不是散落的暗示', () => {
    const ideas = excludedDocOrSkip('ideas/index.md')
    if (ideas === null) return

    // 判的是「成文」——它必须是一个**小节标题**，不是正文里顺带提一句。
    // 只判 `toMatch(/结构化 ref 寻址 ≠ 键鼠模拟/)` 会被别处的交叉引用满足：F 段那行正文里就写着
    // 「见 F 段末《结构化 ref 寻址 ≠ 键鼠模拟》」，于是把标题整条删掉判据照样绿（实测变异存活）。
    const HEADING = '#### 结构化 ref 寻址 ≠ 键鼠模拟'
    const headingStart = ideas.indexOf(HEADING)
    expect(headingStart, '这条线没有成文——正文里提过不算，它得是自己的小节').toBeGreaterThan(-1)

    // 右界取下一个小节，否则切片会一路吃到文件末尾，让隔壁小节的字顶上来充数。
    const nextHeading = ideas.indexOf('\n### ', headingStart)
    expect(nextHeading, '这一节之后没有下一个小节——切片没有右界').toBeGreaterThan(headingStart)
    const section = ideas.slice(headingStart, nextHeading)

    // 成文要能立得住：必须说清两者在**失败可判定性**上的区别，那才是它们不是同类的理由。
    // 只写一句口号而不给判据，下一个读者仍然只能当它是同一件事的两种说法。
    expect(section, '没说清坐标模拟的失败是不可判定的').toMatch(/不可判/)
    expect(section, '没说清 ref 寻址的失败是可判定的').toMatch(/可判。/)
  })

  it('F 段 computer use 行收窄为「不做坐标模拟」，且汇总计数句跟着一起改了', () => {
    const ideas = excludedDocOrSkip('ideas/index.md')
    if (ideas === null) return

    // 撤回要应用到每一处：表里那行改了、而上面两句汇总仍把它当「有意不做」举例，
    // 同一份文件就给出了相反的两个说法（MEMORY「撤回要应用到每一处」）。
    const stanceMentions = ideas.split('\n').filter((line) => line.includes('computer use「有意不做」'))
    expect(stanceMentions.length, '汇总计数句里找不到这一项——断言没有作用对象').toBeGreaterThan(0)
    for (const mention of stanceMentions) {
      expect(mention, `这句仍把它当作无条件的「有意不做」，与表里那行矛盾：${mention.slice(0, 30)}`)
        .toMatch(/坐标模拟/)
    }
  })

  // ── 四、skill 里那份页面函数清单不许落后于真正注入的那份 ──────────────────────
  //
  // **f-27c8fr4x2 之后这条判据换了地基。** 此前清单有三份手抄（注入那份、接管要拒的动作子集、
  // skill 散文），分属两个包、不在同一条构建图上，所以这条测试只能**用正则去源码里抠**：
  // 从 `BROWSER_PAGE_FUNCTION_NAMES = [` 切到 `] as const`，再 `matchAll` 取引号里的名字。
  //
  // 那种写法是本仓反复踩过的两族白绿的合体：
  //   1. 抠空了——数组一搬走，`split` 拿到 undefined、`block` 成空串，`names` 成空数组，
  //      下面的 `for` 一条不跑（`expect(names.length).toBeGreaterThan(10)` 是当时唯一的活口，
  //      正是它在本次搬迁时红了，说明那个自检是对的）；
  //   2. indexOf 锚点没了——`help.indexOf('## Drive an open Browser')` 返回 -1 时，
  //      `slice(-1, …)` 切出的段之后每条 `toContain` 恒真。
  //
  // 现在清单是 core 的一个真导出（`BROWSER_PAGE_CAPABILITIES`），所以判据直接 import 它：
  // **没有可抠空的源码文本，也没有可改名的锚点。** 名字对不上是 tsc 红或断言红，不是静默通过。
  it('skill 教出的页面函数清单与真正注入的那份一致', () => {
    // SSOT 本身，不是从源码正则出来的影子。
    const names = BROWSER_PAGE_CAPABILITY_NAMES
    // 扫描面非空自检仍然留着：万一表被改空，下面的循环会一条不跑。
    expect(names.length, '页面能力表是空的——判据失效，这条什么都不检查').toBeGreaterThan(10)

    // 注入点消费的就是这一份：这条等式是「Desktop 没有偷偷另建一份」的判据。
    expect(
      [...BROWSER_PAGE_FUNCTION_NAMES],
      '注入子进程的清单与 core 的能力表不是同一份——手抄又回来了'
    ).toEqual([...names])

    // skill 是渲染出来的，所以判「每个名字都在场」，而不是判源码里有没有字面量。
    const skill = AGENTMUX_CLI_SKILL
    for (const name of names) {
      expect(skill, `skill 没教 \`${name}\`——它注入进了子进程，但 Agent 无从知道它存在`).toContain(name)
    }

    // 反向的一半：skill 里的名字不许比表多。少了会被上面那个循环抓住，多了此前没人管——
    // 一个被教了却不存在的能力，Agent 会照着规划，然后在半途撞上 `not defined`。
    // 从渲染出来的那一段里取反引号包着的标识符，与表比对；两边都不是手抄的。
    //
    // 锚点先判在场再切（两端都判），否则 -1 会让 slice 切出个宽到没有意义的段，
    // 而下面的 `toContain` 在那种段上恒真——这条测试此前就是这么失明的。
    const start = skill.indexOf('## Drive an open Browser')
    expect(start, 'skill 里没有「Drive an open Browser」这一节——判据的范围落空').toBeGreaterThan(-1)
    const section = skill.slice(start)
    const sentenceEnd = section.indexOf('Write one program')
    expect(sentenceEnd, '这一节里没有「Write one program」——右界锚点没了，切片没有右界').toBeGreaterThan(0)
    const injectedSentence = section.slice(0, sentenceEnd)
    expect(injectedSentence.length, '「注入了哪些函数」那句话切出来是空的').toBeGreaterThan(80)
    const taught = new Set([...injectedSentence.matchAll(/`([a-zA-Z]+)`/g)].map((match) => match[1]!))
    expect(taught.size, '那句话里一个反引号名字都没解析出来——判据失效').toBeGreaterThan(10)
    for (const name of taught) {
      expect(names, `skill 教了 \`${name}\`，但它不在能力表里——Agent 会调到一个不存在的名字`).toContain(name)
    }
  })

  // ── 四、被人接管之后那句话点名的下一步，skill 里真教过（T-012）─────────────────────
  //
  // 房规见 browser-automation-setting-reachable.test.ts：拒绝点名的东西要被单独证明够得着。
  // 那一条点的是 Settings 里的一个位置，这一条点的是**一个结局和一个动作**——「这次报 stopped，
  // 下一步是等页面空出来再跑一次」。Agent 照着做的前提是它读过这套说法；skill 里没有的话，
  // 它拿到一个 `stopped` 只会按「跑太久被截断」去理解，于是把程序改小再跑一遍——而页面还是
  // 人家的，它会再撞一次。
  //
  // 判据两半：文案确实点了名（从源码取，不手抄），以及 skill 与 CLI help 都教了这件事。
  it('接管拒绝点名的「重跑」在 CLI 与 skill 里都教过', () => {
    const manager = read('apps/desktop/src/main/browser-view-manager.ts')
    // 前提自检：那句话还在。整句被改写时下面按它取词会得到空，而空在"没点名"与"判据坏了"
    // 之间不可区分——先把在场判掉。
    expect(manager, '接管拒绝文案不见了——这条判据失去靶子').toMatch(/took control of this Browser/)
    expect(manager, '拒绝没点名下一步能干什么').toMatch(/run the program again/)

    const help = read('packages/core/src/agentmux-cli-help.ts')
    for (const [where, start] of [['CLI browser.run', "['browser.run'"], ['skill', '## Drive an open Browser']] as const) {
      const from = help.indexOf(start)
      expect(from, `${where} 这一节不在——判据的范围落空`).toBeGreaterThan(-1)
      const end = help.indexOf(where === 'skill' ? '\n## ' : "],\n  ['", from + 1)
      const section = help.slice(from, end < 0 ? undefined : end)
      expect(section.length, `${where} 切出来是空的`).toBeGreaterThan(200)
      expect(section, `${where} 没说人可以把页面抢回去——Agent 读到 stopped 会当成"跑太久被截断"`)
        .toMatch(/took? (?:the )?(?:page|control)|takes? (?:the )?page|take the page back|theirs/i)
      expect(section, `${where} 没教被接管之后该干什么`).toMatch(/run (?:it|the program) again/i)
    }
  })
})
