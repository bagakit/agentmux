import { describe, expect, it } from 'vitest'
import {
  MAX_STEP_SUMMARY_LENGTH,
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

describe('折叠行标题', () => {
  it('取得到就带上参数', () => {
    expect(stepTitle('Bash', 'Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('Bash pnpm test')
  })

  it('取不到就只显示工具名，不显示空括号之类的空壳', () => {
    // 空壳会让人以为参数是空的，而事实是我们没读到。
    expect(stepTitle('Bash', 'Bash', '{bad')).toBe('Bash')
    expect(stepTitle('Mystery', 'Mystery', JSON.stringify({ a: 1 }))).toBe('Mystery')
    expect(stepTitle('Bash', undefined, undefined)).toBe('Bash')
  })
})
