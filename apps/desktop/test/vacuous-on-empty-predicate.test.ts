import ts from 'typescript'
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTsx, readAndParse } from './helpers/effect-reachability.js'

/**
 * `expect(xs.every(p)).toBe(true)` 必须证明 `xs` 非空。
 *
 * `[].every(p)` 是 **true**，`[].some(p)` 是 **false**——对空数组，这两条断言都恒成立，而且成立的
 * 理由与被测性质无关。于是判据的形状是：
 *
 * ```ts
 * const lanes = buildLanes(…)                              // 生产代码今天返回 2 条
 * expect(lanes.every((lane) => lane.sessions.length === 0)).toBe(true)
 * ```
 *
 * 这条今天是绿的，也确实在检查东西。但 `buildLanes` 哪天开始返回 `[]`——投影被跳过、过滤条件写反、
 * 上游换了字段名——它**照样绿**。测试名说「不泄漏别的 Project 的 Session」，而绿的理由变成了
 * 「一条 lane 都没投影出来」，那是一个严重得多的缺陷，却由这条判据替它盖着。
 *
 * 这是 AGENTS.md:88 第三种白绿（扫到空内容）在**运行期集合**上的同一支。切片那一支（锚点取空）
 * 由 `sliced-scan-surface-not-empty.test.ts` 守；这一支守的是谓词遍历了一个空集合。两者的共同点：
 * 只有**负向/全称**断言会中招，而它们恰恰是最常写的那种。
 *
 * ── 判据的取值面 ──
 *
 * 只认 `expect(<population>.every(…)).toBe(true)` 与 `expect(<population>.some(…)).toBe(false)`
 * 这两种**空集合恒真**的形状。`.every(…)).toBe(false)` 与 `.some(…)).toBe(true)` 不在内：它们对空
 * 集合恒**假**，集合空了当场就红，不需要守。
 *
 * 「证明非空」认下面任意一种，都在同一个 `it()` 块里：
 *
 *   - `expect(xs).toHaveLength(n)` / `expect(xs.length)` 的任意断言（`toBe`、`toBeGreaterThan`…）
 *   - `expect(xs).toEqual([...])` / `toContainEqual` / `toMatchObject` —— 拿整个集合比对内容
 *   - `expect(xs.map(…))` / `filter(…).length` 之类派生后的比对
 *   - `expect(fn).toHaveBeenCalledTimes(n)` —— population 是 `fn.mock.calls` 时，次数就是长度
 *
 * 宁可漏报不误伤：一条被误判的判据会让人给守卫加豁免，而豁免会把守卫吃掉。
 */
describe('空集合上恒真的谓词断言都带着非空证明', () => {
  const TEST_DIR = new URL('../test/', import.meta.url)
  const testFiles = readdirSync(TEST_DIR).filter((name) => /\.tsx?$/.test(name))

  /** `expect(<pop>.every(...)).toBe(true)` 或 `expect(<pop>.some(...)).toBe(false)` 的 population 文本。 */
  function vacuousPopulation(node: ts.Node): string | undefined {
    // 形状：CallExpression( PropertyAccess( CallExpression( expect, [inner] ), 'toBe' ), [true|false] )
    if (!ts.isCallExpression(node)) return undefined
    if (!ts.isPropertyAccessExpression(node.expression)) return undefined
    if (node.expression.name.text !== 'toBe') return undefined
    const expected = node.arguments[0]
    if (!expected) return undefined
    const expectsTrue = expected.kind === ts.SyntaxKind.TrueKeyword
    const expectsFalse = expected.kind === ts.SyntaxKind.FalseKeyword
    if (!expectsTrue && !expectsFalse) return undefined

    const expectCall = node.expression.expression
    if (!ts.isCallExpression(expectCall)) return undefined
    if (!ts.isIdentifier(expectCall.expression) || expectCall.expression.text !== 'expect') return undefined
    const inner = expectCall.arguments[0]
    if (!inner || !ts.isCallExpression(inner)) return undefined
    if (!ts.isPropertyAccessExpression(inner.expression)) return undefined

    const method = inner.expression.name.text
    // 只有这两组是「空集合恒成立」。every→false / some→true 空集合当场红，不需要守。
    if (!((method === 'every' && expectsTrue) || (method === 'some' && expectsFalse))) return undefined
    return inner.expression.expression.getText()
  }

  /**
   * 反向形状：`expect(xs.some(p)).toBe(true)` / `expect(xs.every(p)).toBe(false)` 的 population。
   *
   * 这两条**对空集合恒假**，所以它们一旦通过，集合必然非空——它们本身就是一份非空证明。
   * 同一个 population 上有一条这样的兄弟句时，被守的那条就已经有主了（实测：`workspace-files`
   * 的 `some(sh)===true` 与 `some(tee)===false` 正是这一对）。
   * 返回的是**整句调用文本**（`observed.some((x) => x.workspaceId === 'B')`）而不是接收者，
   * 因为判等价时谓词那一半也要比——见 {@link hasNonEmptyProof} 里的 `provesPopulation`。
   */
  function provingPopulation(node: ts.Node): { receiver: string; call: string } | undefined {
    if (!ts.isCallExpression(node)) return undefined
    if (!ts.isPropertyAccessExpression(node.expression)) return undefined
    if (node.expression.name.text !== 'toBe') return undefined
    const expected = node.arguments[0]
    if (!expected) return undefined
    const expectsTrue = expected.kind === ts.SyntaxKind.TrueKeyword
    const expectsFalse = expected.kind === ts.SyntaxKind.FalseKeyword
    if (!expectsTrue && !expectsFalse) return undefined
    const expectCall = node.expression.expression
    if (!ts.isCallExpression(expectCall)) return undefined
    if (!ts.isIdentifier(expectCall.expression) || expectCall.expression.text !== 'expect') return undefined
    const inner = expectCall.arguments[0]
    if (!inner || !ts.isCallExpression(inner)) return undefined
    if (!ts.isPropertyAccessExpression(inner.expression)) return undefined
    const method = inner.expression.name.text
    if (!((method === 'some' && expectsTrue) || (method === 'every' && expectsFalse))) return undefined
    return { receiver: inner.expression.expression.getText(), call: inner.getText() }
  }

  /**
   * 这个 `it()` 块里，有没有一处断言能证明 `population` 非空。
   *
   * 认三种见证方式，都是实测出来的——这三种各自对应一批**变异证明了其实有主**的判据，少认一种就是
   * 一批误报，而误报会让人给守卫加豁免，豁免会把守卫吃掉：
   *
   *   1. **反向谓词**（{@link provingPopulation}）：同一个集合上有 `some→true` / `every→false`。
   *   2. **主语文本里含这个集合**：`expect(actionIds(entries)).toEqual([...])`、
   *      `expect(new Set(names).size).toBe(1)`——派生一层再比对，集合空了同样会红。
   *   3. **一跳派生变量**：`const joined = paragraph.children.map(…).join('')` 之后断言 `joined`。
   *      只跳一跳，不做完整 def-use：再深就该让人自己写一句 `toHaveLength` 了。
   *
   * 反过来，两种东西**不算**证明，放过去等于自己拆自己：
   *
   *   - `.not.` 链：`expect(xs).not.toContain(y)` 自己就是空集合恒真的，拿它当证明是循环论证。
   *   - 断言「空」：`toHaveLength(0)` / `toEqual([])` / `toBe(0)`。
   */
  function hasNonEmptyProof(block: ts.Node, population: string): boolean {
    // `[...xs]` / `Array.from(xs)` 与 `xs` 同空同非空，所以证明挂在任一形态上都算数——
    // 摊平之后再遍历是本仓遍历 Set 的常规写法（`expect(xs.size).toBeGreaterThan(0)` 常在几行之上）。
    const spread = /^\[\s*\.\.\.(.+?)\s*\]$/.exec(population) ?? /^Array\.from\(\s*(.+?)\s*\)$/.exec(population)
    const aliases = spread ? [population, spread[1]!, `${spread[1]!}.size`, `${spread[1]!}.length`] : [population]
    // 会因「集合空了」而红的 matcher。
    const PROVING = new Set([
      'toHaveLength', 'toContain', 'toContainEqual', 'toMatchObject',
      'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toHaveBeenCalledTimes', 'toEqual', 'toBe'
    ])

    // 先收齐这个块里「由 population 派生出来的变量名」，供第 3 种见证方式用。
    const derived = new Set<string>()
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (aliases.some((alias) => node.initializer!.getText().includes(alias))) derived.add(node.name.text)
      }
      ts.forEachChild(node, collect)
    }
    collect(block)

    const witnesses = (subject: string): boolean => {
      if (aliases.some((alias) => subject.includes(alias))) return true
      const root = subject.split(/[.[(]/)[0]!
      if (derived.has(root)) return true
      // population 是 `<spy>.mock.calls` 时，`expect(<spy>).toHaveBeenCalledTimes(n)` 说的就是它的
      // 长度——同一个事实的另一种写法，n>0 即非空（`toHaveBeenCalledTimes(0)` 已被 assertsEmpty 挡掉）。
      const mockAt = population.indexOf('.mock.calls')
      return mockAt > 0 && subject === population.slice(0, mockAt)
    }

    /**
     * 反向谓词 `proof` 能不能证明 `population` 非空。
     *
     * 同一个集合当然算。另有一种**逐字相同**的情况也算，且只有逐字相同才算：population 是
     * `xs.filter(P)` 而 proof 是 `xs.some(P)`——同一个 `P`。这时 `some(P)===true` 恰好就是
     * 「`filter(P)` 至少有一个元素」，是等价命题，不是近似。
     *
     * 放宽到「同一个源集合」是不成立的：`xs.some(Q)===true` 只说明 xs 非空，`xs.filter(P)` 照样
     * 可以是空的。守卫宁可漏报也不能拿一条不等价的断言当证明——那会把这条判据自己变成它要防的东西。
     */
    const provesPopulation = (proof: { receiver: string; call: string }): boolean => {
      if (proof.receiver === population) return true
      const filterAt = population.indexOf('.filter(')
      if (filterAt < 0) return false
      const source = population.slice(0, filterAt)
      const predicate = population.slice(filterAt + '.filter('.length, -1)
      return (
        proof.call === `${source}.some(${predicate})` || proof.call === `${source}.every(${predicate})`
      )
    }

    let proved = false
    const visit = (node: ts.Node): void => {
      if (proved) return
      const proof = provingPopulation(node)
      if (proof !== undefined && provesPopulation(proof)) {
        proved = true
        return
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const matcher = node.expression.name.text
        if (PROVING.has(matcher)) {
          // `.not.` 链自己就是空集合恒真的那一族，不能拿来当证明。
          let chain = node.expression.expression
          let negated = false
          while (ts.isPropertyAccessExpression(chain)) {
            if (chain.name.text === 'not') negated = true
            chain = chain.expression
          }
          if (
            !negated &&
            ts.isCallExpression(chain) &&
            ts.isIdentifier(chain.expression) &&
            chain.expression.text === 'expect'
          ) {
            const subject = chain.arguments[0]?.getText() ?? ''
            // `.every(` / `.some(` 自己不作数：那正是被守的那一句（反向那支上面已单独认过）。
            const isThePredicate = /\.(every|some)\(/.test(subject)
            const arg = node.arguments[0]?.getText().replace(/\s/g, '') ?? ''
            const assertsEmpty =
              arg === '[]' ||
              arg === '{}' ||
              ((matcher === 'toBe' || matcher === 'toHaveLength' || matcher === 'toHaveBeenCalledTimes') &&
                arg === '0')
            if (!isThePredicate && !assertsEmpty && witnesses(subject)) proved = true
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(block)
    return proved
  }

  /**
   * 证明要在哪个范围里找。
   *
   * 默认是包着这条断言的 `it()`。但集合绑在 `describe` 上时（`describe(… , () => { const items = walk(…) }`），
   * 证明它非空的那句常常在**兄弟 `it()`** 里——`application-menu.test.ts` 就是这样：三条
   * `expect(items.some(…)).toBe(false)` 各在各的 `it()`，而「Edit 菜单还在」「Quit 还在」两条兄弟
   * 断言的是同一个 `items` 非空（实测：把那个 describe 级绑定改成空，红的正是这两条兄弟）。
   *
   * 所以范围按**绑定处**定：绑在 it() 里就在 it() 里找，绑在外面就整个 describe 里找。按 it() 一刀切
   * 会把这类判据全报成没主——而它们是有主的，只是主在隔壁。
   */
  function proofScope(node: ts.Node, population: string): ts.Node | undefined {
    const enclosing = (names: readonly string[]): ts.CallExpression | undefined => {
      for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
        if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && names.includes(cur.expression.text)) {
          return cur
        }
      }
      return undefined
    }
    const testCase = enclosing(['it', 'test'])
    if (!testCase) return undefined
    // 简单标识符才谈得上「绑在哪」；表达式（`foo().bar`）没有绑定处，就按 it() 算。
    if (!/^[A-Za-z_$][\w$]*$/.test(population)) return testCase
    let boundInside = false
    const scan = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === population) boundInside = true
      ts.forEachChild(n, scan)
    }
    scan(testCase)
    return boundInside ? testCase : (enclosing(['describe']) ?? testCase)
  }

  /**
   * 写下来的豁免。
   *
   * 集合**合法地可以是空**的情形确实存在：`needs-you-predicate-scope.test.ts` 那条遍历的是
   * 「登记在册但一个状态字面量都没有的文件」，而那个集合为空恰恰是干净状态。这种时候要求补一句
   * 非空证明，是在逼人写一句假话。
   *
   * 所以豁免走注释，且必须**紧贴**在断言上一行——不设集中式的豁免清单：清单会和代码漂开，
   * 而且一旦存在，下一个人遇到误报的第一反应就是往清单里加一行，守卫从此开始溶解。写在原地的
   * 理由会跟着那段代码一起被读到、一起被改。
   */
  const EXEMPTION = 'vacuous-ok:'

  function hasExemptionComment(sourceFile: ts.SourceFile, node: ts.Node): boolean {
    const text = sourceFile.getFullText()
    const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line
    const assertionLine = lineOf(node.getStart())
    // 往上找最近的非空行，看它是不是一条带豁免标记的注释。
    const lines = text.split('\n')
    for (let i = assertionLine - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim() ?? ''
      if (line === '') continue
      return line.startsWith('//') && line.includes(EXEMPTION)
    }
    return false
  }

  it('扫描面自检：test 目录读得到，且这两种形状真的存在', () => {
    // 守卫自己也是扫描式的，所以它自己也得证明扫到了东西——否则它正是它要防的那种东西。
    expect(testFiles.length, 'test 目录扫出来是空的').toBeGreaterThan(100)
    let found = 0
    for (const name of testFiles) {
      const { sourceFile } = readAndParse(new URL(name, TEST_DIR).pathname)
      const visit = (node: ts.Node): void => {
        if (vacuousPopulation(node) !== undefined) found += 1
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
    expect(
      found,
      '一处 `expect(xs.every(…)).toBe(true)` / `expect(xs.some(…)).toBe(false)` 都没扫到——' +
        '形状匹配的那段不认当前写法了，这条判据什么都没检查'
    ).toBeGreaterThan(20)
  })

  it('自证：匹配器认得出恒真形状，也放得过空集合会红的那种', () => {
    // 上一条只数了数量，数量对不代表**认的是对的东西**。这一条喂四段构造出来的源码，正反各两条：
    // 前两种空集合恒成立（必须被认出），后两种空集合当场红（必须放过，否则守卫会去要求一堆
    // 根本不需要的证明，而多余的要求正是让人给守卫加豁免的起点）。
    const probe = (code: string): string[] => {
      const sf = parseTsx('probe.tsx', code)
      const hits: string[] = []
      const visit = (node: ts.Node): void => {
        const pop = vacuousPopulation(node)
        if (pop !== undefined) hits.push(pop)
        ts.forEachChild(node, visit)
      }
      visit(sf)
      return hits
    }
    expect(probe('expect(xs.every((x) => x.ok)).toBe(true)'), 'every→true 没被认出').toEqual(['xs'])
    expect(probe('expect(a.b.some((x) => x.ok)).toBe(false)'), 'some→false 没被认出').toEqual(['a.b'])
    expect(probe('expect(xs.every((x) => x.ok)).toBe(false)'), 'every→false 空集合会红，不该被要求证明').toEqual([])
    expect(probe('expect(xs.some((x) => x.ok)).toBe(true)'), 'some→true 空集合会红，不该被要求证明').toEqual([])
  })

  it('每一处都在同一个 it() 里证明了集合非空', () => {
    const offenders: string[] = []
    let checked = 0
    for (const name of testFiles) {
      const path = new URL(name, TEST_DIR).pathname
      const { sourceFile } = readAndParse(path)
      const visit = (node: ts.Node): void => {
        const population = vacuousPopulation(node)
        if (population !== undefined) {
          const scope = proofScope(node, population)
          // 不在 it() 里（辅助函数、describe 层裸语句）就判不了范围，跳过——宁可漏报不误伤。
          if (scope) {
            checked += 1
            if (!hasNonEmptyProof(scope, population) && !hasExemptionComment(sourceFile, node)) {
              const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
              offenders.push(`${name}:${line} — \`${population}\` 空了这条照样绿`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }

    expect(checked, '一处都没核到——形状匹配失效了，这条判据什么都没检查').toBeGreaterThan(20)
    expect(
      offenders,
      '这些断言在集合为空时恒成立，而集合为空本身是个更严重的缺陷，却被它们盖住了。\n' +
        '在同一个 it() 里补一句非空证明（`expect(xs).toHaveLength(n)` 或对内容的比对）：\n' +
        offenders.join('\n')
    ).toEqual([])
  })
})
