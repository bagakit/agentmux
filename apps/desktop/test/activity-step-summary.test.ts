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

  it('经由 stepSummary 的真实路径也不吐半个字符', () => {
    // 判据要落在产品真正走的那条路上，而不只是直接调 clampStep。同样要让 🚀 骑在刀口上：
    // 尾切留 47 个码元，🚀 占 2 个，于是它后面须正好 46 个码元（37 个 x 加 `rocket.ts`）。
    const path = `/Users/somebody/proj/${'nested/'.repeat(6)}🚀${'x'.repeat(37)}rocket.ts`
    const out = stepSummary('Edit', JSON.stringify({ file_path: path }))!
    expect(hasLoneSurrogate(out), `真实路径吐出孤立代理项：${JSON.stringify(out)}`).toBe(false)
    expect(out).toContain('rocket.ts')
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
