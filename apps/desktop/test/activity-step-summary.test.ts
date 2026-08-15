import { describe, expect, it } from 'vitest'
import {
  MAX_STEP_SUMMARY_LENGTH,
  clampStep,
  stepSummary,
  stepTitle
} from '../src/renderer/src/lib/activity-step-summary.js'

// 用户要的是：折叠状态本身可读——不展开就知道那步干了什么。三行裸 `Bash` 满足不了这件事。

describe('参数摘要', () => {
  it('跑命令取命令本身', () => {
    expect(stepSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test')
  })

  it('读文件取路径', () => {
    expect(stepSummary('Read', JSON.stringify({ file_path: '/repo/src/a.ts' }))).toBe('/repo/src/a.ts')
  })

  it('按工具种类取该取的那个字段，而不是碰上哪个算哪个', () => {
    // 同一份入参喂给两个工具，取出来的必须是不同的字段。若实现改成"取第一个字符串值"，
    // 两边会返回同一个东西，这条会红。
    const input = JSON.stringify({ command: 'rm -rf /', file_path: '/repo/a.ts' })
    expect(stepSummary('Bash', input)).toBe('rm -rf /')
    expect(stepSummary('Read', input)).toBe('/repo/a.ts')
  })

  it('工具名大小写不影响查表', () => {
    expect(stepSummary('bash', JSON.stringify({ command: 'ls' }))).toBe('ls')
    expect(stepSummary('BASH', JSON.stringify({ command: 'ls' }))).toBe('ls')
  })

  it('不认识的工具如实返回 null，不去猜一个字段', () => {
    // 猜错的摘要比没有摘要更坏：它看起来像已核实的事实。
    expect(stepSummary('MysteryTool', JSON.stringify({ command: 'ls', anything: 'x' }))).toBeNull()
  })

  it('坏 JSON 返回 null 而不抛——读不懂入参不等于这一行该消失', () => {
    expect(stepSummary('Bash', '{not json')).toBeNull()
    expect(stepSummary('Bash', '"a string"')).toBeNull()
    expect(stepSummary('Bash', '[1,2]')).toBeNull()
  })

  it('字段缺失或不是字符串时返回 null', () => {
    expect(stepSummary('Bash', JSON.stringify({ notCommand: 'ls' }))).toBeNull()
    expect(stepSummary('Bash', JSON.stringify({ command: 42 }))).toBeNull()
    expect(stepSummary('Bash', JSON.stringify({ command: '   ' }))).toBeNull()
  })

  it('toolName 或入参缺失时返回 null——不拿展示标题去凑', () => {
    expect(stepSummary(undefined, JSON.stringify({ command: 'ls' }))).toBeNull()
    expect(stepSummary('Bash', undefined)).toBeNull()
  })

  it('候选字段按顺序取第一个非空的', () => {
    expect(stepSummary('Read', JSON.stringify({ path: '/b.ts' }))).toBe('/b.ts')
    // file_path 排在 path 前面，两个都在时取前者。
    expect(stepSummary('Read', JSON.stringify({ file_path: '/a.ts', path: '/b.ts' }))).toBe('/a.ts')
  })

  it('换行与制表符压成单个空格——标题只占一行', () => {
    expect(stepSummary('Bash', JSON.stringify({ command: 'a\n\tb   c' }))).toBe('a b c')
  })

  it('超长命令被截断，不把时间偏移挤出可视区', () => {
    const long = 'x'.repeat(200)
    const summary = stepSummary('Bash', JSON.stringify({ command: long }))
    expect(summary).not.toBeNull()
    expect(summary!.length).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
    expect(summary!.endsWith('…')).toBe(true)
  })

  it('刚好等于上界的不被截断', () => {
    const exact = 'y'.repeat(MAX_STEP_SUMMARY_LENGTH)
    expect(stepSummary('Bash', JSON.stringify({ command: exact }))).toBe(exact)
  })
})

// 补齐高频工具的行：表原本只覆盖 12 个工具，于是 8.4% 的真实调用折叠成裸工具名。补完之后，
// 在本机 ~/.claude/projects 全部 transcript（7.76 万次 tool_use，2026-09-14）上实测
// 覆盖率 91.6% → 99.2%；剩下的 612 次里 335 次是 AskUserQuestion——它的 `questions` 是嵌套数组，
// 没有顶层字符串字段，扁平的表够不着，故有意留白（见下方「故意不收」）。
// 每条都刻意塞一个"陷阱字段"——更长、或更靠前、或是内部枚举/agent id——把这一行改成取陷阱字段、
// 或把整张表换成任何通用规则（取第一个短串 / 取最长串 / 一张通用优先表），这些断言就会红。
// 这正是"表胜过任何谓词"的肯定证据：同一个字段名的角色是逐工具的，不通用。
describe('新增工具行：取声明的那个字段，而不是通用规则蒙出来的', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    // 高价值：既有简洁的识别字段，通用规则又恰好在这里取错。
    ['Agent', { description: 'Digest crawler snapshot', prompt: 'Y'.repeat(200) }, 'Digest crawler snapshot'], // 不是 645c prompt
    ['TaskCreate', { subject: '写纯函数与测试', description: 'X'.repeat(200), activeForm: 'a' }, '写纯函数与测试'], // 不是详情 blob
    ['SendMessage', { to: 'ad10e88e542eac233', summary: '交付完成', message: 'M'.repeat(200) }, '交付完成'], // 不是 agent id / 1KB
    ['Workflow', { description: 'Diagnose launcher', script: 'export const meta'.repeat(50) }, 'Diagnose launcher'], // 不是 6.7KB 源码
    ['Monitor', { command: 'while true; do sleep 1; done', description: 'packaging done' }, 'packaging done'], // 不是原始 shell
    ['Skill', { skill: 'bagakit-supervisor', args: 'x' }, 'bagakit-supervisor'],
    ['PushNotification', { message: '磁盘告急', status: 'proactive' }, '磁盘告急'], // 不是枚举 'proactive'
    ['ScheduleWakeup', { reason: '兜底心跳', prompt: 'P'.repeat(200) }, '兜底心跳'], // 不是 1KB prompt
    ['SendFeedback', { type: 'bug', title: 'AskUserQuestion bug', details: 'D'.repeat(200) }, 'AskUserQuestion bug'], // 不是枚举/1KB
    // 低价值但诚实：id/动词就是区分两行同名调用的东西。
    ['CronCreate', { cron: '0 9 * * *', prompt: 'P'.repeat(200) }, '0 9 * * *'], // 不是 1KB prompt
    ['CronDelete', { id: 'job-123' }, 'job-123'],
    ['TaskGet', { taskId: '17' }, '17'],
    ['TaskStop', { task_id: 'a-xyz' }, 'a-xyz'],
    ['TaskOutput', { task_id: 'a-xyz', block: true }, 'a-xyz']
  ]
  it.each(cases)('%s 取声明字段而非陷阱字段', (tool, input, expected) => {
    expect(stepSummary(tool, JSON.stringify(input))).toBe(expected)
  })

  it('Artifact：title 优先，缺席退回 description', () => {
    // 两候选：实测真实调用里 title 常缺席、只有 description，所以 description 是有效兜底而非空取。
    expect(stepSummary('Artifact', JSON.stringify({ title: 'Ship gate', description: 'X'.repeat(200), favicon: '🚦' }))).toBe('Ship gate')
    expect(stepSummary('Artifact', JSON.stringify({ description: 'progress', favicon: '🚦' }))).toBe('progress')
  })

  it('TaskUpdate：有 status 取状态动词，无 status 退回 subject 标题', () => {
    // taskId 单独无意义；状态变更的识别位是 status。实测 1876 次里 208 次没有 status——
    // 其中带 subject 的取那个真标题，比裸名强（把行改成只 ['status'] 时第二条会红）。
    // 两者都在时 status 优先（实测 48 次 status+subject 并存）——把顺序反成 ['subject','status'] 第一条会红。
    // 计数语料：本机 ~/.claude/projects 全部 transcript，2026-09-14 当日；会随使用增长，
    // 断言钉的是取哪个字段，不是这些数。
    expect(stepSummary('TaskUpdate', JSON.stringify({ status: 'in_progress', subject: '建 feature', taskId: '1' }))).toBe('in_progress')
    expect(stepSummary('TaskUpdate', JSON.stringify({ subject: '建 feature 并写 review', description: 'X'.repeat(200), taskId: '2' }))).toBe('建 feature 并写 review')
  })
})

// 截断方向不是风格问题，是这条摘要有没有识别力的问题。绝对路径在同一个仓库里**前缀全同**
// （工具收到的就是绝对路径），保留头部会把 48 格全花在机器名和仓库路径上，两个不同的文件截出来
// 一模一样——而摘要存在的唯一理由就是「不展开也认得出是哪个」。
describe('路径保留尾部：同仓两个不同文件必须长得不一样', () => {
  // 两条路径共享 62 字符前缀，只在最后一段分岔——正是真实仓库里的形状。
  const A = '/Users/somebody/proj/priv/bagakit/agentmux/apps/desktop/src/renderer/src/lib/session-recency.ts'
  const B = '/Users/somebody/proj/priv/bagakit/agentmux/apps/desktop/src/renderer/src/lib/activity-step-summary.ts'

  it('两条同仓路径的摘要互不相同', () => {
    const a = stepSummary('Edit', JSON.stringify({ file_path: A }))
    const b = stepSummary('Edit', JSON.stringify({ file_path: B }))
    // 断言的是**互不相同**，不是「以 .ts 结尾」：后者对「全都截成同一个前缀」也能过，是恒真的。
    expect(a).not.toBe(b)
    expect(a).toContain('session-recency.ts')
    expect(b).toContain('activity-step-summary.ts')
  })

  it('拼上工具名之后仍然互不相同——这是用户真正看到的那个串', () => {
    // stepSummary 各自合规、拼完超界再被下游截一刀，识别位照样会没——所以必须在 stepTitle 这一层断言。
    const a = stepTitle('Edit', 'Edit', JSON.stringify({ file_path: A }))
    const b = stepTitle('Edit', 'Edit', JSON.stringify({ file_path: B }))
    expect(a).not.toBe(b)
    expect(a).toContain('session-recency.ts')
    expect(b).toContain('activity-step-summary.ts')
  })

  it('stepTitle 的结果不超上界——下游因此不需要、也不该再截一刀', () => {
    // 这条是上一条的前提：只要 stepTitle 可能溢出，调用方就必然会再截，而它那一刀不认得字段名。
    expect(stepTitle('Edit', 'Edit', JSON.stringify({ file_path: A })).length)
      .toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
  })

  it('工具名自己就超界时也守住上界——这条承诺不能只是「通常成立」', () => {
    // `title` 是 hook 载荷里的 tool_name 原样，MCP 工具名形如 mcp__<server>__<tool>，轻易过 48。
    // 这一路没有摘要可拼，但仍然是同一个函数的返回值；放它裸奔，下游就得自己补一刀——
    // 而那一刀正是「一个预算只截一次」要消灭的东西。
    const huge = `mcp__${'server'.repeat(8)}__do_the_thing`
    expect(huge.length).toBeGreaterThan(MAX_STEP_SUMMARY_LENGTH)
    // 两条路都要守：有入参但没格子放，和压根没有入参。
    expect(stepTitle(huge, 'Bash', JSON.stringify({ command: 'ls' })).length)
      .toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
    expect(stepTitle(huge, undefined, undefined).length)
      .toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
  })

  it('省略号在头部，说明被砍掉的是前缀', () => {
    expect(stepSummary('Read', JSON.stringify({ file_path: A }))!.startsWith('…')).toBe(true)
  })

  it('notebook_path 同样保尾', () => {
    const nb = `${'/very/long/prefix'.repeat(4)}/analysis.ipynb`
    expect(stepSummary('NotebookEdit', JSON.stringify({ notebook_path: nb }))).toContain('analysis.ipynb')
  })

  it('非路径字段仍然保头——识别位在动词那一头', () => {
    // command 的识别位是动词：`rm -rf …` 的危险、`pnpm exec vitest …` 的意图都在开头。
    // 若这里也改成保尾，用户读到的会是最后一个文件参数，反而认不出这一步在干什么。
    const long = `rm -rf ${'/a/deep/path'.repeat(10)}`
    const summary = stepSummary('Bash', JSON.stringify({ command: long }))!
    expect(summary.startsWith('rm -rf ')).toBe(true)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('url 保头——身份是域名，不是查询串', () => {
    const url = `https://example.com/${'segment/'.repeat(20)}?q=1`
    const summary = stepSummary('WebFetch', JSON.stringify({ url }))!
    expect(summary.startsWith('https://example.com/')).toBe(true)
  })

  it('短路径不加省略号', () => {
    expect(stepSummary('Read', JSON.stringify({ file_path: '/a.ts' }))).toBe('/a.ts')
  })
})

// `slice()` 数的是 UTF-16 码元，会把 emoji 的代理对劈成两半，留下一个孤立代理项——渲染成 `�`。
// 这不是假想：项目目录带 emoji、文件名带中日韩都很常见。同一个提交里给首字母用了 Intl.Segmenter，
// 却在隔壁文件按码元切，那是同一个缺陷换了个位置。
describe('按字素簇切，不吐半个字符', () => {
  /** 有没有落单的代理项——它就是那个会渲染成 `�` 的东西。 */
  const hasLoneSurrogate = (s: string): boolean =>
    [...s].some((ch) => {
      const code = ch.codePointAt(0)!
      return code >= 0xd800 && code <= 0xdfff
    })

  it('尾切不劈开代理对', () => {
    // pad=43 是实测会让切点正好落在 🚀 中间的那个长度。
    const value = `${'/x'.repeat(60)}/🚀${'a'.repeat(43)}.ts`
    const out = clampStep(value, 'tail')
    expect(hasLoneSurrogate(out), `尾切吐出了孤立代理项：${JSON.stringify(out)}`).toBe(false)
    expect(out.length).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
  })

  it('头切不劈开代理对', () => {
    const value = `${'a'.repeat(46)}🚀${'b'.repeat(50)}`
    const out = clampStep(value, 'head')
    expect(hasLoneSurrogate(out), `头切吐出了孤立代理项：${JSON.stringify(out)}`).toBe(false)
    expect(out.length).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
  })

  it('带 ZWJ 的家族 emoji 不被拆散——一个簇里好几个码点', () => {
    // 👨‍👩‍👧 是 3 个 emoji + 2 个 ZWJ，共 8 个码元。要让这条有判别力，簇必须**正好骑在刀口上**：
    // 尾切留最后 47 个码元，所以簇后面得有 40..46 个码元，刀才落进簇内部。取 43（40 个 a 加 `.ts`），
    // 刀落在簇的第 4 个码元——劈开中间那个 👩。簇若离刀口远，整簇要么全留要么全丢，怎么切都不会红。
    const value = `${'/deep/path'.repeat(8)}/👨‍👩‍👧${'a'.repeat(40)}.ts`
    const out = clampStep(value, 'tail')
    expect(hasLoneSurrogate(out), `家族被劈开了：${JSON.stringify(out)}`).toBe(false)
    // 要么整簇都在，要么整簇都不在——不许出现残缺的家族。
    if (/[👨👩👧]/u.test(out)) expect(out).toContain('👨‍👩‍👧')
  })

  it('扫一遍所有切点：两个方向都不许出现孤立代理项', () => {
    // 单个 case 只证得了那一个偏移。必须让簇相对**各自那一刀**逐格移动，才覆盖得到「正好劈开」
    // 那一格——两刀的落点不在同一头：尾切的刀从右边数，头切的刀从左边数，所以两组输入分别构造。
    // 用同一组输入扫两个方向，等于其中一个方向压根没骑到刀口上，那一半是恒真的。
    // 两种簇都扫：代理对（2 码元）与 ZWJ 序列（8 码元）劈开的方式不同，只扫前者对后者失明。
    for (const cluster of ['🚀', '👨‍👩‍👧']) {
      for (let offset = 0; offset < 80; offset += 1) {
        const fromTail = `${'/x'.repeat(60)}/${cluster}${'a'.repeat(offset)}.ts` // 簇距右端 offset+3
        const fromHead = `${'a'.repeat(offset)}${cluster}${'b'.repeat(120)}` //     簇距左端 offset
        for (const [keep, value] of [
          ['tail', fromTail],
          ['head', fromHead]
        ] as const) {
          const out = clampStep(value, keep)
          const where = `${keep} 在 ${cluster} offset=${offset}`
          expect(hasLoneSurrogate(out), `${where} 吐出孤立代理项：${JSON.stringify(out)}`).toBe(false)
          expect(out.length, `${where} 超上界`).toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
        }
      }
    }
  })

  it('切口落在空格上时两头都不漏空白——`…␠file` 看起来像少了一截', () => {
    // 尾切此前只有 `…${slice}`，没有对称的 trimStart，于是切点落在空格上就吐出 `… zzz.md`。
    // 走的是产品真实路径：file_path 是保尾字段，flatten 保留单个内部空格，而 macOS 上带空格的
    // 目录（`My Notes`、`Application Support`）很常见。
    const withSpace = `/Users/me/proj/My Notes ${'z'.repeat(43)}.md`
    const tail = stepSummary('Edit', JSON.stringify({ file_path: withSpace }))!
    expect(tail.startsWith('… '), `省略号后漏了空格：${JSON.stringify(tail)}`).toBe(false)
    expect(tail).toContain('.md')

    // 头切的对称面：`trimEnd()` 此前没有判据，删掉它全绿。
    const head = clampStep(`${'a'.repeat(46)} ${'b'.repeat(50)}`, 'head')
    expect(head.endsWith(' …'), `省略号前漏了空格：${JSON.stringify(head)}`).toBe(false)
  })

  it('单个簇就超预算时有界退化成一个省略号，而不是原样吐回整串', () => {
    // 两处 `?? value.length` 兜底是承重的，不是防御性写法：换成 `?? 0`，尾切会返回整串 65 个码元，
    // 超上界 17 格。基字母加 60 个组合重音是一个字素簇，比预算宽——这条既钉住下界，也钉住兜底。
    const oneHugeCluster = `xxxe${'́'.repeat(60)}`
    expect(oneHugeCluster.length).toBeGreaterThan(MAX_STEP_SUMMARY_LENGTH)
    expect(clampStep(oneHugeCluster, 'tail')).toBe('…')
  })

  it('经由 stepSummary 的真实路径也不吐半个字符', () => {
    // 判据要落在产品真正走的那条路上，而不只是直接调 clampStep。同样要让 🚀 骑在刀口上：
    // 尾切留 47 个码元，🚀 占 2 个，于是它后面须正好 46 个码元（37 个 x 加 `rocket.ts`）。
    const path = `/Users/somebody/proj/${'nested/'.repeat(6)}🚀${'x'.repeat(37)}rocket.ts`
    const out = stepSummary('Edit', JSON.stringify({ file_path: path }))!
    expect(hasLoneSurrogate(out), `真实路径吐出孤立代理项：${JSON.stringify(out)}`).toBe(false)
    expect(out).toContain('rocket.ts')
  })
})

// 截断是有损的，缩短不是——所以先缩短。本仓 400 条真实源文件路径实测：原样尾切后**零条**能完整
// 显示，剥掉仓根之后 31% 完整显示，平均 97 → 53 个码元。省掉的正好是零识别力的那一段。
describe('路径先缩短再截断', () => {
  const ROOT = '/Users/somebody/proj/priv/bagakit/agentmux'

  it('仓内路径剥成相对路径，于是根本不用截', () => {
    const abs = `${ROOT}/apps/desktop/src/main/agent-notifier.ts`
    expect(abs.length, '这条判据要求原路径确实超界，否则截不截都一样').toBeGreaterThan(MAX_STEP_SUMMARY_LENGTH)
    const out = stepSummary('Edit', JSON.stringify({ file_path: abs }), MAX_STEP_SUMMARY_LENGTH, ROOT)
    // 完整、无省略号——而不是 `…gentmux/apps/desktop/src/main/agent-notifier.ts`。
    expect(out).toBe('apps/desktop/src/main/agent-notifier.ts')
  })

  it('仓外路径折叠家目录', () => {
    const out = stepSummary(
      'Read',
      JSON.stringify({ file_path: '/Users/somebody/proj/priv/bagakit/agentmux/package.json' }),
      MAX_STEP_SUMMARY_LENGTH,
      '/Users/somebody/other-repo'
    )
    expect(out).toBe('~/proj/priv/bagakit/agentmux/package.json')
  })

  it('仓根必须整段匹配到 `/`——`/repo-backup` 不是 `/repo` 的子路径', () => {
    // 裸 startsWith(root) 会把它剥成 `-backup/src/a.ts`，一条不存在的路径。
    const out = stepSummary('Edit', JSON.stringify({ file_path: '/w/repo-backup/src/a.ts' }), MAX_STEP_SUMMARY_LENGTH, '/w/repo')
    expect(out).toBe('/w/repo-backup/src/a.ts')
  })

  it('没有 workspaceRoot 时行为不变——缩短不了就原样，不猜', () => {
    const abs = `${ROOT}/apps/desktop/src/main/agent-notifier.ts`
    // 与改动之前逐字相同：仍是保尾截断的绝对路径。
    expect(stepSummary('Edit', JSON.stringify({ file_path: abs }))).toBe('…gentmux/apps/desktop/src/main/agent-notifier.ts')
  })

  it('家目录折叠只在**折叠后能塞下**时才看得出效果', () => {
    // 上一条是同一个输入没有 root 的样子：`~` 折叠确实发生了，但路径折叠后仍有 68 个码元，
    // 尾切留最后 47 个，于是折不折叠尾巴一模一样。这不是 bug，是 `~` 的受益窗口只有 15 格宽——
    // 只有长度落在 49..63 的路径才会因它从「被截」变成「完整」。写这条是为了让下一个人别把
    // 「上面那条没出现 `~`」读成折叠没生效。
    expect(stepSummary('Read', JSON.stringify({ file_path: '/Users/somebody/proj/priv/one/two/module.ts' })))
      .toBe('~/proj/priv/one/two/module.ts')
  })

  it('只缩短路径字段——命令是要执行的字面文本，一个字都不许改写', () => {
    // 判据必须让命令**自己就以仓根/家目录开头**，否则 shortenPath 本来就匹配不上，
    // 「只缩短路径字段」这条就成了恒真的——我第一版写的 `ls /Users/...` 正是如此：把实现改成
    // 对所有字段都缩短，它照样绿。这一版直接跑一个绝对路径的可执行文件，那是真实命令的形状。
    const cmd = '/Users/somebody/bin/deploy.sh --now'
    expect(cmd.length, '要求命令塞得下，否则看到的是截断而不是「原样」').toBeLessThanOrEqual(MAX_STEP_SUMMARY_LENGTH)
    expect(stepSummary('Bash', JSON.stringify({ command: cmd }), MAX_STEP_SUMMARY_LENGTH, ROOT)).toBe(cmd)
    // 仓根那一侧同样要守：命令以仓根开头时也不许被剥成相对路径。
    const inRepo = `${ROOT}/s.sh`
    expect(stepSummary('Bash', JSON.stringify({ command: inRepo }), MAX_STEP_SUMMARY_LENGTH, ROOT)).toBe(inRepo)
  })

  it('缩短发生在截断之前——反过来就白做了', () => {
    // 先截后缩：尾切已经把前缀切掉，`…`开头的串不再以仓根起始，缩短匹配不上，识别位补不回来。
    const abs = `${ROOT}/apps/desktop/electron.vite.config.ts`
    const out = stepTitle('Edit', 'Edit', JSON.stringify({ file_path: abs }), ROOT)
    expect(out).toBe('Edit apps/desktop/electron.vite.config.ts')
    expect(out.startsWith('Edit …'), '前缀没被剥掉，说明缩短没在截断之前发生').toBe(false)
  })
})

describe('折叠行标题', () => {
  it('取得到就带上参数', () => {
    expect(stepTitle('Bash', 'Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('Bash pnpm test')
  })

  it('承诺只有长度一条，不含压平空白——契约写到哪，测试就钉到哪', () => {
    // stepTitle 的文档只承诺 `<= MAX`。`title` 原样透传协议里的 tool_name，本函数不 flatten 它。
    // 钉住这条是为了守住**边界本身**：若日后有人顺手加上 flatten，这里会红，逼他去改那句承诺——
    // 而不是让注释与行为悄悄分家。反过来，若注释写成「保证单行」，它就成了一句没人验的空话。
    expect(stepTitle('Web  Search', undefined, undefined)).toBe('Web  Search')
  })

  it('格子只够放一个省略号时不拼空壳——那正是本函数要消灭的东西', () => {
    // `budget <= 1` 这道门槛此前没有判别器：改成 `<= 0` 全绿。因为要让两者分岔，工具名必须**正好**
    // 落在 budget === 1 那一格（长度 46）——短一格走 `<= 2` 之外的普通路，长一格两边都直接截标题。
    //
    // 变异体在这一格拼出 `…range …`：省略号是 clampStep 在预算 1 上的退化产物（一个真字符都留不下），
    // 拼上去看起来像「参数是空的」，而事实是格子不够。这与 `Bash ()` 是同一种谎，只是标点不同。
    const name = 'mcp__filesystem-readonly__read_text_file_range'
    expect(name.length, '这条判据依赖 budget 正好为 1，工具名必须是 46 字').toBe(46)
    const out = stepTitle(name, 'Bash', JSON.stringify({ command: 'pnpm exec vitest run' }))
    expect(out).toBe(name)
    expect(out.endsWith('…'), `拼了个只有省略号的空壳：${JSON.stringify(out)}`).toBe(false)
  })

  it('格子只够放一个真字符时仍然拼——薄不等于空', () => {
    // 门槛的另一侧：budget === 2（工具名 45 字）留得下一个字符加省略号。把门槛提到 `<= 2` 会把这一档
    // 也丢掉，用户就少看见一个字节的识别力。薄摘要仍是摘要，空壳才不是。
    const name = 'mcp__filesystem-readonly__read_text_file_rang'
    expect(name.length).toBe(45)
    expect(stepTitle(name, 'Bash', JSON.stringify({ command: 'pnpm exec vitest run' }))).toBe(`${name} p…`)
  })

  it('取不到就只显示工具名，不显示空括号之类的空壳', () => {
    // 空壳会让人以为参数是空的，而事实是我们没读到。
    expect(stepTitle('Bash', 'Bash', '{bad')).toBe('Bash')
    expect(stepTitle('Mystery', 'Mystery', JSON.stringify({ a: 1 }))).toBe('Mystery')
    expect(stepTitle('Bash', undefined, undefined)).toBe('Bash')
  })
})
