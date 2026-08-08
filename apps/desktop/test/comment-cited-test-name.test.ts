import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 注释里**指名引用**另一条用例时，那个名字必须真的是某条用例的标题。
 *
 * 来由（#744）：`67ee9f7` 把四个文件里「多条断言挤一个 it」拆成 `it.each`，其中
 * `fanout-naming-single-source.test.ts` 有一行注释用引用标记指着一条名叫
 * "recognises the reduction" 的用例（这里刻意不用引用标记的写法，否则本文件自己会被这条判据抓住）。
 * 那条 it 在同一个提交里被拆掉了，注释留在原地，指向一个不存在的名字。读注释的人会去找那条用例，
 * 找不到，然后要么放弃、要么误以为自己在读一个坏掉的文件。同族问题此前记过一次
 * （记忆 tracker-gate-commands-name-nonexistent-tests：验收引用指向不存在的测试）。
 *
 * 为什么需要**检测器**而不只是那一次修正：拆 it 是这个仓库的常规动作（#742 一轮就拆了四个文件），
 * 每拆一次都会把「上一版的名字」留在注释里，而这件事对现有一切工具全盲——注释不影响类型，
 * `tsc` 干净，全部测试照旧全绿。没有任何东西会在下一次改名时说话。
 * 常驻规则的交付物是守卫，不是那一次清理（记忆 cleanup-without-a-detector-is-not-cleanup）。
 *
 * ── 判据为什么是「引用标记」而不是「反引号里的字符串」 ──
 *
 * 这条判据的取值面收得很窄，是量出来的。四个更宽的候选各自实测过，全部不可用：
 *   - 「注释里所有带空格的反引号串」：455 条候选，450 条不是任何标题。本仓注释大量逐字引用 git
 *     与 gh 的输出、错误消息、命令行（`not a git repository`、`gh pr create`、`Test Files 1 failed`），
 *     它们本来就不该是用例名。
 *   - 「散文形状的反引号串」：46 条命中里 44 条是假的，而且它对 CJK 标题**完全失明**——正是本轮
 *     真正搁浅的两个形状之一。
 *   - 「含全角冒号的反引号串」：103 条命中里 102 条是假的，两个真靶子一个都不认。
 *
 * 有信号的那一条是**引用标记**：注释用「见 / 参见 / 详见」把读者**指向**某个地方时，它才是在
 * 声明「那里有一条叫这个名字的用例」。逐字引用一段 git 输出不会写「见」。
 *
 * `见` 必须落在**标记位**上。在「看见 / 看得见 / 看不见 / 可见」里它是复合动词的词尾，后面跟的
 * 反引号串是被描述的散文而不是被引用的用例——这一族实测吃掉 5 个命中里的 3 个
 * （记忆 lexical-boundaries-need-a-real-lexer：词法边界不能靠字符出现推断）。
 *
 * 怎么排除它们，也是量出来的。第一版要求 `见` 前面是**行首或分隔符**——那一版把三条假的排掉了，
 * 同时**也排掉了真的**：本仓的引用大量写成「这一轮的存活靶子见 `…`」，`见` 紧跟在名词后面，没有
 * 任何分隔符。那一版实测让 #744 的原始靶子（把那行指着 "recognises the reduction" 的注释放回文件里）
 * **静默存活**。所以这里改成排除那几个**复合动词词尾**：判据要认的是「`见` 在这里是不是动词
 * 『参照』」，而分隔符与它无关。这一族天然是拒绝清单会漏的形状（记忆
 * forbidden-list-guard-always-leaks），代价是漏判而非误判——漏一个新的复合词只是少报一条引用，
 * 不会对正确的注释打假红。下面的前提自检把两个方向各钉一条。
 *
 * ── 通配符为什么必须带字面锚点 ──
 *
 * `it.each` 的标题里有 `$why` 这类插值，注释引用时通常写成 `…`，所以两侧都要把通配符当
 * 「某段文本」来配。第一版直接把通配符换成 `.+` 就配——**那一版是假绿**：本仓有一条 `it.each`
 * 的标题整体就是 `` `$why` ``，展开后是 `^.+$`，它匹配任何字符串。于是 9 条命中里 7 条「解析成功」
 * 都解析到了它身上，连「这是一个不存在的用例名字啊」这种明显的胡话也解析成功。
 * 修法：一侧的模式必须至少留一段 ≥4 字的**字面**文本，否则它证明不了任何事，直接跳过。
 * 下面「前提自检」里那三条胡话就是这个假绿的靶子——它们必须报 STALE。
 *
 * ── 这条判据**不**保证什么（诚实记录，不让注释许诺超过断言）──
 *   - 它只看**同一次扫描面**里的全部标题，不区分文件。跨文件引用（`见 startup-failure-exit.test.ts`
 *     那一类）会因为形状像路径而被排除在外，本判据不管它们指得对不对。
 *   - 序数式引用（「自检 3」＝「第 3 条自检」）不在取值面内：那类名字**故意**不含标题原文，
 *     判不了。它们另有一族脆弱性（中间插一条，后面全部错位），与本条无关，不在这里混判。
 *   - 它按标题文本匹配，不做作用域解析。两个文件里有同名 it 时它分不开，于是**偏向判活**。
 */

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))

/** 扫描面：test/ 下所有 TS/TSX。 */
function testSourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...testSourceFiles(path))
    else if (/\.tsx?$/u.test(entry)) found.push(path)
  }
  return found
}

/**
 * 一个文件里所有 `it` / `test` / `describe` 的标题。
 *
 * 走 AST 而不是正则，是因为 `it.each(TABLE)('标题', …)` 的 callee 是一次调用的返回值，
 * 按 `it(` 这种文本形状去数会漏掉整张表——而 `it.each` 恰好是本仓拆 it 之后的主要形状。
 */
function testTitlesIn(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const titles: string[] = []
  const runnerName = (callee: ts.Expression): string | null => {
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return callee.expression.text
    // it.each(TABLE)('…') —— callee 本身是 it.each(TABLE) 这次调用。
    if (ts.isCallExpression(callee)) {
      const inner = callee.expression
      if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) return inner.expression.text
    }
    return null
  }
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const runner = runnerName(node.expression)
      if (runner === 'it' || runner === 'test' || runner === 'describe') {
        const first = node.arguments[0]
        if (first !== undefined && ts.isStringLiteralLike(first)) titles.push(first.text)
        // 模板字符串标题（`… $why …`）取原文去掉反引号，插值原样留着，由下面的通配符配平。
        else if (first !== undefined && ts.isTemplateExpression(first)) {
          titles.push(first.getText(source).slice(1, -1))
        }
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(source, walk)
  return titles
}

/** `…` 与 `$why` / `${why}` 都表示「这里省略了一段文本」。 */
const WILDCARD = /…|\$\{?[A-Za-z_$][\w$]*\}?/gu

/**
 * 把一个可能带通配符的串编成正则；同时回答它**有没有字面锚点**。
 *
 * 没有锚点的模式（整体就是一个 `$why`）展开后是 `^.+$`，对任何输入都成立。它不是一个宽松的
 * 判据，而是**一个恒真的判据**——上面文件头记的那次假绿就是它。所以这里把「有没有锚点」
 * 一起返回，让调用方跳过，而不是让它去背书。
 */
function patternOf(text: string): { regex: RegExp; anchored: boolean } {
  const escape = (part: string): string => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const parts = text.split(WILDCARD)
  const anchored = parts.some((part) => part.trim().length >= 4)
  return { regex: new RegExp(`^${parts.map(escape).join('.+')}$`, 'u'), anchored }
}

/** 这个引用能不能在标题清单里找到落点。 */
function resolvesToTitle(citation: string, titles: readonly string[]): boolean {
  if (titles.includes(citation)) return true
  // 标题带插值、引用写全：用标题当模式去配引用。
  const titleSide = titles.some((title) => {
    const { regex, anchored } = patternOf(title)
    return anchored && regex.test(citation)
  })
  if (titleSide) return true
  // 引用写了省略号、标题是全文：用引用当模式去配标题。
  const { regex, anchored } = patternOf(citation)
  return anchored && titles.some((title) => regex.test(title))
}

/**
 * 注释里被「见 / 参见 / 详见」指向的、用反引号或书名号括起来的串。
 *
 * 两个方向各排除一族，都是实测出来的：
 *   - `见` 不许是「看见 / 看得见 / 看不见 / 可见 / 未见」这类**复合动词的词尾**——那种位置上它不是
 *     「参照」的意思，后面的反引号串是被描述的散文。但**不**要求 `见` 前面有分隔符：本仓的引用常写成
 *     「存活靶子见 `…`」，`见` 紧跟名词，要求分隔符会连真引用一起漏掉（实测见文件头）。
 *   - `见` 前面是引号时，它是**被引用的那个词本身**（散文里写 `` `见` `` 讨论这个标记），此时紧跟其后的
 *     那个反引号是这对引号的**收尾**，不是下一段引用的开头。少了这一条，本文件自己的文件头就会被
 *     读成四条跨行的假引用（实测：本文件 4 条、fanout 0 条）。
 */
const COMPOUND_VERB_TAIL = /[看可未罕少不得难常预偶]/u
const QUOTE_OPENERS = '`「'
const CITATION = /(参见|详见|见)\s*[`「]([^`」]{4,200})[`」]/gu

/** 这次命中的 `见` 落在标记位上吗（不是复合动词词尾、也不是被引号括住的那个词本身）。 */
function isReferenceMarker(body: string, match: RegExpMatchArray): boolean {
  const before = (match.index ?? 0) > 0 ? body[(match.index ?? 0) - 1]! : ''
  if (QUOTE_OPENERS.includes(before)) return false
  if (match[1] !== '见') return true
  return before === '' || !COMPOUND_VERB_TAIL.test(before)
}

type Citation = { line: number; text: string }

function citedTestNames(sourceText: string, fileName: string): Citation[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Citation[] = []
  const scannedRanges = new Set<number>()

  const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) {
      // 同一段注释既是上一个节点的尾注释、又是下一个节点的先导注释，会被访问两次。
      if (scannedRanges.has(range.pos)) continue
      scannedRanges.add(range.pos)
      const body = sourceText.slice(range.pos, range.end)
      for (const match of body.matchAll(CITATION)) {
        if (!isReferenceMarker(body, match)) continue
        // 折行的注释里，一个名字可能跨行并带着 ` * ` 前缀，先归一成一行。
        const text = match[2]!.replace(/\s*\n\s*\**\s*/gu, ' ').trim()
        const line = sourceText.slice(0, range.pos + (match.index ?? 0)).split('\n').length
        found.push({ line, text })
      }
    }
  }
  const walk = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(sourceText, node.getFullStart()))
    collect(ts.getTrailingCommentRanges(sourceText, node.getEnd()))
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(source, walk)
  return found
}

/**
 * 被引用的串里，哪些**看起来像用例名**。
 *
 * 排除掉的三类都不是本条判据要管的：文件路径（`见 startup-failure-exit.test.ts`）、
 * 裸标识符（`见 stripCssComments`，那是在指一个函数）、带花括号的代码片段。
 * 序数式引用（`自检 3`）也排除——理由写在文件头「不保证什么」那一段。
 */
function looksLikeTestName(text: string): boolean {
  if (/\.(tsx?|mjs|json|css|md)$/u.test(text)) return false
  if (/^[\w$./@-]+$/u.test(text)) return false
  if (text.includes('/') || /[{}]/u.test(text)) return false
  if (/^(?:前提自检|在场自检|判据自检|反向自证|自检|自证)\s*\d+$/u.test(text)) return false
  // 代码片段：`见 `() => '_'`` 是在指一段替换物的写法，不是在指一条用例。
  if (/=>|\(\)|^function\b/u.test(text)) return false
  return true
}

describe('注释里指名引用的用例，名字必须真的存在', () => {
  const files = testSourceFiles(TEST_DIR)
  const allTitles = files.flatMap((path) => testTitlesIn(readFileSync(path, 'utf8'), path))

  it('前提自检：标题清单与引用清单都非空，否则主判据什么都不检查', () => {
    // 这两条挡板守的是「判据自己失效」：扫描根写错、AST 取标题的分支坏掉、正则不再命中，
    // 主判据都会因为清单为空而**静默全绿**（本仓最贵的一族假绿）。
    expect(files.length, 'test/ 一个源文件都没扫到，这条守卫是死代码').toBeGreaterThan(100)
    expect(allTitles.length, '一条用例标题都没取到——it.each 的取标题分支可能坏了')
      .toBeGreaterThan(1000)

    const citations = files.flatMap((path) => citedTestNames(readFileSync(path, 'utf8'), path))
    expect(citations.length, '一条「见 `…`」引用都没找到——正则或注释取值坏了，主判据无从落点')
      .toBeGreaterThan(0)
  })

  it('前提自检：判据认得出真标题，也不会把注释里的散文当成引用', () => {
    // 正向：一条真实标题必须解析成功。反向：`看不见 `X`` 这种复合动词词尾不是引用标记。
    expect(resolvesToTitle(allTitles[0]!, allTitles), '一条真实标题被判成不存在——匹配逻辑坏了')
      .toBe(true)

    const prose = citedTestNames(
      '// 文本守卫看得见「名字被引用了」，看不见极性被反转。\nconst a = 1\n',
      'probe.ts'
    )
    expect(prose, '「看得见 / 看不见」里的 `见` 被当成了引用标记——判据没有词法边界').toEqual([])

    const marked = citedTestNames('// 见 `某条用例的标题`。\nconst a = 1\n', 'probe.ts')
    expect(marked.map((one) => one.text), '标记位上的 `见 `…`` 没被认成引用').toEqual(['某条用例的标题'])
  })

  it.each([
    {
      why: '名词后紧跟的 `见` 是引用标记（不许要求分隔符）',
      comment: '// 这一轮的存活靶子见 `某条用例的标题` 的反向自证。',
      expected: ['某条用例的标题']
    },
    {
      why: '复合动词词尾的 `见` 不是引用标记',
      comment: '// 文本守卫看得见「名字被引用了」，看不见极性被反转。',
      expected: []
    },
    {
      why: '被引号括住的 `见` 本身不是引用标记（它后面那个反引号是收尾）',
      // 同一行必须还有第二对反引号：少了它，正则根本凑不出一次匹配，这条用例就退化成恒真。
      comment: '// 第一版要求 `见` 前面是分隔符，那一版把 `真引用` 也排掉了。',
      expected: []
    }
  ])('前提自检：$why', ({ comment, expected }) => {
    // 三条各钉住 isReferenceMarker 里的一个决策，方向互不相同：第一条要求「别收太紧」，
    // 后两条要求「别放太松」。三条各自都被真实注入验证过能独立打红（理由见文件头）。
    const found = citedTestNames(`${comment}\nconst a = 1\n`, 'probe.ts')
    expect(found.map((one) => one.text)).toEqual(expected)
  })

  it('前提自检：没有字面锚点的模式不许背书任何引用', () => {
    // 这条钉的是文件头记的那次假绿：`it.each` 标题整体是 `$why` 时，把通配符直接换成 `.+`
    // 会让它匹配任何字符串，于是胡话也「解析成功」。锚点要求就是为了挡住它。
    const titlesWithBareInterpolation = ['$why', '$kind', ...allTitles]
    for (const nonsense of ['这是一个不存在的用例名字啊', 'no such test title exists here']) {
      expect(
        resolvesToTitle(nonsense, titlesWithBareInterpolation),
        `胡话「${nonsense}」被一个没有字面文本的标题背书了——通配符退化成了恒真判据`
      ).toBe(false)
    }
    // 反向：带锚点的插值标题照旧要能配上写成省略号的引用。
    expect(resolvesToTitle('判据自检：…被认成一次分支名归一', ['判据自检：$why 被认成一次分支名归一']))
      .toBe(true)
  })

  it('test/ 里没有指向不存在用例名的注释', () => {
    const stranded: string[] = []
    for (const path of files) {
      const relative = path.slice(TEST_DIR.length)
      for (const citation of citedTestNames(readFileSync(path, 'utf8'), path)) {
        if (!looksLikeTestName(citation.text)) continue
        if (resolvesToTitle(citation.text, allTitles)) continue
        stranded.push(`${relative}:${citation.line}  见 \`${citation.text}\``)
      }
    }

    expect(stranded, [
      '有注释指名引用了一条不存在的用例。多半是拆 it / 改标题时只动了 it(，没动指向它的注释——',
      '读注释的人会去找这条用例，找不到（#744 的原始事故：`67ee9f7` 拆掉了',
      '`recognises the reduction`，而引用它的那行注释留在原地）。',
      '修法：把引用改指新的用例名或表名；名字带插值时用 `…` 代替插值，但两侧至少要留一段',
      '≥4 字的原文，否则这条判据配不上（理由见本文件头「通配符为什么必须带字面锚点」）。'
    ].join('\n')).toEqual([])
  })
})
