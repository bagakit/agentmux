import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { fanOutSlug } from '../src/shared/fanout-naming.js'

// ---------------------------------------------------------------------------------------------------
// 扇出分支名的 slug 只有一份，而它的安全性判据是**幂等**而不是「两份实现的不动点」(#644/#659)。
//
// 一个扇出分支名此前被 slug 两次：surface 侧从 prompt 派生一个 stem（`fanOutStemFromPrompt`），
// main 侧作为权威对 `baseName` 再 slug 一次（模块私有的 `slugify`）。两份实现几乎一样但不完全一样：
// surface 那份在 `.slice(0, 40)` **之后**多清一次尾部连字符，main 那份没有。于是整条链的正确性挂在
// 一个从未被写出来、也从未被断言的不动点上——`authoritySlug(surfaceStem(x)) === surfaceStem(x)`。
// 它今天成立只是两份实现恰好对当下的输入一致的巧合。
//
// 修法不是「抽取加断言不动点」，而是删到只剩一个函数：那样同一件事就退化成单函数的幂等性
// `slug(slug(x)) === slug(x)`——单个函数自己的保证，再也不可能与第二份副本漂移。取的是**较严**的
// 那份实现（带截断后尾部清理的），因为「截断正好切在连字符上」时，只有它给出的才是合法分支名。
// ---------------------------------------------------------------------------------------------------

// 覆盖面像样的语料，逐个断言幂等。每一条都标了它想踩的形状。
//
// 关键的一条是 `truncation-lands-on-hyphen`：把单字符 token 用空格串起来，归一后成 `x-x-x-…`，奇数
// 位是连字符。第 40 个字符（index 39）恰好是连字符，于是 `.slice(0, 40)` 切出一个以连字符结尾的名字。
// **较严**的实现在截断后再清一次尾巴，得到合法名字且幂等；**较松**的（surface 那份没有截断后清理，或
// 权威那份从来没有）会留下那个尾部连字符——第一次 slug 出 40 字符、第二次又被开头的 `/^-+|-+$/` 清成
// 39 字符，两次不相等，幂等当场破。这正是两份实现唯一分岔的地方，也是选错实现方向会红的那一条。
const HYPHEN_AT_40 = Array.from({ length: 30 }, () => 'x').join(' ')

const IDEMPOTENCE_CORPUS: ReadonlyArray<{ label: string; input: string }> = [
  { label: 'empty', input: '' },
  { label: 'only-hyphens', input: '----' },
  { label: 'pure-punctuation', input: '!!!@@@###' },
  { label: 'leading-and-trailing-separators', input: '  --Add Retry-- ' },
  { label: 'consecutive-separators', input: 'add   retry!!!to___the   uploader' },
  { label: 'cjk-only', input: '你好世界' },
  { label: 'cjk-mixed-with-ascii', input: '你好 hello 世界 world' },
  { label: 'ordinary', input: 'Add retry to the uploader' },
  // 截断落点不在连字符上（第 40 位是字母）：与上面那条成对，证明「幂等」不是靠所有输入都短于 40。
  { label: 'truncation-lands-on-alnum', input: 'a'.repeat(60) },
  { label: 'truncation-lands-on-hyphen', input: HYPHEN_AT_40 }
]

describe('the fan-out slug is idempotent — a single function, not a fixed point between two copies', () => {
  it('slug(slug(x)) === slug(x) across punctuation, CJK, empties, and the truncation boundary', () => {
    // 逐条比 slug(slug(x)) 与 slug(x)，把破幂等的输入连同它落在的那一步收集起来——这样报的是「哪条
    // 语料破了」，而不是只知道「有一条破了」。
    const nonIdempotent = IDEMPOTENCE_CORPUS.filter(({ input }) => {
      const once = fanOutSlug(input)
      const twice = fanOutSlug(once)
      return once !== twice
    }).map(({ label, input }) => `${label}: slug(${JSON.stringify(input)})=${JSON.stringify(fanOutSlug(input))} but slug(slug(x))=${JSON.stringify(fanOutSlug(fanOutSlug(input)))}`)

    expect(nonIdempotent, [
      '这些输入不是幂等的——slug 一次和 slug 两次给出不同结果。',
      '最常见的成因是取错了实现方向：截断后不清尾部连字符，于是切在连字符上的名字第二次又被清短了。'
    ].join('\n')).toEqual([])
  })

  it('anchors the truncation-on-hyphen result on an independent literal, so picking the looser impl reds', () => {
    // 独立锚点，不由 fanOutSlug 自己算出——否则期望值会跟着变异一起漂而恒真。
    // 较严实现：截断到 40 字符（末位是连字符）后清掉那个尾巴，得到 20 个 `x` 以连字符相连、共 39 字符。
    // 较松实现（删掉最后那次 `.replace(/-+$/gu, '')`，或把它与 `.slice` 对调）：留下那个尾部连字符，
    // 得到 40 字符。所以这个字面量在选错实现方向时立刻红。
    expect(fanOutSlug(HYPHEN_AT_40)).toBe(Array.from({ length: 20 }, () => 'x').join('-'))
    // 且确实以字母结尾、不以连字符结尾——合法分支名的直接判据。
    expect(fanOutSlug(HYPHEN_AT_40).endsWith('-')).toBe(false)
  })

  it('collapses to the conservative branch-name alphabet the authority relied on', () => {
    // 保守字母表本身：小写、a-z0-9 与连字符之外一律折成连字符，且长度受 40 约束。这几条钉住的是
    // 「换成较松/较宽的字母表」这类变异，而不只是幂等。
    expect(fanOutSlug('Add Retry')).toBe('add-retry')
    expect(fanOutSlug('a'.repeat(60)).length).toBeLessThanOrEqual(40)
  })
})

// ---------------------------------------------------------------------------------------------------
// 结构层（SSOT）：这套 slug 归一只许长在 src/shared/fanout-naming.ts 一个文件里。
//
// 上面的幂等语料只覆盖「今天在场的这一个函数」。它证明不了「没有第二份自己写的 slug 悄悄回来」——
// 一份新副本对今天的输入是对的（幂等也成立），要等到某天它与这份漂移才出问题，而那正是 #644 的形态：
// 两份实现今天一致、明天分岔。所以再钉一层结构判据。
//
// 判据不是「不许出现某个函数名」（换个名字、内联一份就绕过），也不是「文件里出现过某段文本」（注释、
// docstring 里提到这个正则会误报）。判据用 **TS 自己的解析器** 找**取值位**：一个把「除小写字母数字外
// 一律折成连字符」这个分支名归一动作落到语法树上的那一处 `.replace(<regex>, '-')`。
//
// 加固（本轮）：第一版用 `arg0.getText().includes('[^a-z0-9]')` 做**子串**判定，于是同一个字符类的
// 别的等价拼法全部绕过——`[^0-9a-z]`（换序）、`[^a-z\d]`（`\d` 代 `0-9`）、以及 `new RegExp('[^a-z0-9]')`
// （不是正则字面量，`arg0.getText()` 拿到的是 `new RegExp(...)` 整段）——review agent 各测 `5/5 green`
// （记忆 counting-a-symbol-misses-other-spellings：数一种拼法漏掉别的拼法）。现在把字符类**归一成集合**
// 再比：展开范围、把 `\d` 当 `0-9`、顺序无关，得到 `0-9|a-z` 这个规范形，与分支名 slug 的签名相等才算。
// 这个否定字符类**恰好是** {a-z, 0-9}，是分支名 slug 独有的签名：仓库别处的 slug 用
// `[^A-Za-z0-9._-]`（workspace 路径段）或 `[^A-Za-z0-9_-]`（provider id），集合里含大写字母与额外符号，
// 规范形不同，所以不会被误伤。
//
// 加固（后续一轮）：#659 只归一了**字符类**的拼法，方法名仍硬钉在 `replace` 上，于是把同一个归一
// 改写成 `.replaceAll(/[^a-z0-9]+/gu, '-')` 就整条绕过——既不算 slug 也不算 unclassified，静默返回
// `[]`（记忆 counting-a-symbol-misses-other-spellings：这次换的是**方法名**不是字符类）。现在方法名
// 放宽到 `replace|replaceAll`；`arg[1] === '-'` 那道闸保证仓库现有的 `.replaceAll`（agent-address 与
// providers/shared 的引号转义、bracketed-paste 的 ESC 转义，替换实参都不是 '-'）不会被误报。存活变异的靶子见下面
// `判据自检：$why 被认成一次分支名归一` 那张表里的 `replaceAll 换了方法名`。
//
// 加固（本轮）：前两轮归一了**字符类拼法**与**方法名**，但「折成什么」仍硬钉在字面量 `'-'` 上
// （`arg[1] === '-'`）。于是把同一个归一改写成**函数替换物**——`.replace(/[^a-z0-9]+/gu, () => '-')`、
// `(m) => '-'`、`function () { return '-' }`——就整条静默绕过：既不算 slug 也不算 unclassified，直接返回
// `[]`（记忆 counting-a-symbol-misses-other-spellings：这次换的是**替换物的写法**）。它与 SSOT 那份
// `.replace(/[^a-z0-9]+/gu, '-')` 逐字节等价，正是 #644 第二份副本「今天一致、明天漂移」的形状。
// 曾经存活、现在会死的变异：把 `replacementFoldsToHyphen` 里的 `isArrowFunction || isFunctionExpression`
// 分支整段删掉（对函数替换物一律返回 'unknown'）——`() => '-'` 不再折成 'hyphen'，`slugText(… () => '-')`
// 从 1 掉到 0。本轮实测：该变异打红 `判据自检：…被认成一次分支名归一` 表里三条函数替换物用例
// （箭头 / 带参箭头 / 函数表达式），`3 failed | 25 passed (28)`。
// 现在把**替换物**也归一（`replacementFoldsToHyphen`）：字面量按值判；单表达式箭头体或单条 return 的函数体
// 若能静态求值成字符串就按那个值判；求不出（用到 match 参数、有分支、调别的函数）返回 unknown——正则**恰是
// slug 类**时把它标成 unclassified 响亮报出，正则不是 slug 类时则静默（避免全仓合法的 map/transform 式
// .replace 制造噪声）。这一轮的存活靶子见 `判据自检：…被认成一次分支名归一` 表里三条 `() => '-'` / `(m) => '-'` /
// `function () { return '-' }`，反向靶子见 `() => '_'` / `() => ''`（folds to 'other'，不认成 slug）。
//
// 仍不覆盖（诚实记录）：
// 1) `Array.prototype.reduce` 之类手写的逐字符归一、或把归一藏进一个具名 helper 再从别处调用
//    （跨函数数据流）——本文件是 createSourceFile 词法/语法走查，判不出「某函数的返回值等价于分支名 slug」，
//    要 TypeChecker 做过程间分析才够得到。这是有意接受的边界，不是遗漏。
// 2) 函数替换物里**有分支/用到 match 参数/调用别的函数**再折成连字符（例如 `(m) => m ? '-' : m`）：静态求不出
//    折成什么，故只在正则恰是 slug 类时标 unclassified 响亮，无法直接判成 slug。这也是有意的——静态求值只走
//    单表达式/单 return 且求得出字符串常量的那一档，再深就是过程间分析。
// 3) **正整类反演**——不带否定字符类、而是用 `.replace(/[a-z0-9]+|(.)/gu, (m, g) => g ? '-' : m)` 这类
//    正类捕获 + 回调把「非 alnum」折成连字符。它没有 `[^…]`，`negatedClassCanonical` 返回 null，故不认成 slug；
//    今天三个扫描根里没有这种写法（见下面主扫描的 unclassified 一侧为空）。这一族与 #1 同源（回调里的语义要
//    过程间才判得出），一并记为有意接受的边界。
//
// 另一半是**归类不了的可疑形状要响亮**（记忆 forbidden-list-guard-always-leaks）：一个
// `.replace(<动态>, '-')`——正则从变量/函数/`new RegExp(变量)` 来，静态解析不出——可能正是第二份 slug
// 用运行期构造的正则伪装起来。它被标成 unclassified，主扫描一律响亮失败并指名，绝不静默放过。
// 今天三个扫描根里一处这种写法都没有（每个折成连字符的 `.replace` 第一参都是内联正则字面量），
// 见 `反向自证：…不制造 unclassified 噪声` 那张表。
//
// 允许出现分支名 slug 取值位的文件只有 SSOT 一个；其余任何文件出现同形取值就报红并指名。
// ---------------------------------------------------------------------------------------------------

// 落点唯一允许的文件（相对各扫描根去比对时用它的 basename 判定）。
const SSOT_BASENAME = 'fanout-naming.ts'

// 扫描根：main、renderer、shared——main 与 renderer 都是执行面，shared 是它们共同的落点。
const SCAN_ROOTS: ReadonlyArray<{ label: string; url: string }> = [
  { label: 'src/main', url: '../src/main/' },
  { label: 'src/renderer', url: '../src/renderer/src/' },
  { label: 'src/shared', url: '../src/shared/' }
]

function walk(rootUrl: string): string[] {
  const root = new URL(rootUrl, import.meta.url)
  const recur = (relative: string): string[] =>
    readdirSync(new URL(relative, root), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? recur(`${relative}${entry.name}/`)
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [`${relative}${entry.name}`]
          : []
    )
  return recur('')
}

/**
 * 一个否定字符类 `[^...]` 的内容，归一成与写法无关的规范形。
 *
 * 展开范围（`a-z`）、把 `\d` 当作 `0-9`、`\w`/`\s` 等其它转义原样留字面，顺序无关。返回排序后用 `|`
 * 连起来的原子串，如 `[^a-z0-9]` / `[^0-9a-z]` / `[^a-z\d]` 都归一成 `0-9|a-z`。找不到否定字符类返回 null。
 *
 * 这是把「子串匹配一种拼法」换成「比较归一后的值」的那一步（本轮的修法一）。
 */
function negatedClassCanonical(pattern: string): string | null {
  const match = /\[\^([^\]]*)\]/u.exec(pattern)
  if (!match) return null
  const body = match[1]!
  const atoms = new Set<string>()
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (ch === '\\') {
      const next = body[i + 1]
      if (next === 'd') atoms.add('0-9')
      else if (next !== undefined) atoms.add(next) // 其它转义（\w \s \. …）留字面原子，绝不当作 0-9/a-z
      i += 1
      continue
    }
    // 范围 X-Y：中间是 '-' 且两侧都在
    if (body[i + 1] === '-' && body[i + 2] !== undefined && body[i + 2] !== ']') {
      atoms.add(`${ch}-${body[i + 2]}`)
      i += 2
      continue
    }
    atoms.add(ch)
  }
  return [...atoms].sort().join('|')
}

// 分支名 slug 的签名：否定字符类恰好等于 {a-z, 0-9}。
const BRANCH_SLUG_CANONICAL = '0-9|a-z'

/**
 * 从 `.replace(...)` 调用的第一个实参里解析出正则的 **pattern 源码**（不含分隔符与 flag）。
 *
 * 认三种可静态解析的形状：正则字面量 `/.../flags`、`new RegExp('...')`（字符串字面量或字面量的 `+`
 * 拼接）、以及把字符串直接传给 `.replace`（此时是字面量替换，不是正则）。解析不出（变量、`new RegExp(变量)`、
 * 模板插值、函数返回）时返回 undefined——由调用方标成 unclassified 并响亮，而不是静默当成「不是 slug」。
 */
function staticStringOf(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringOf(node.left)
    const right = staticStringOf(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

function regexSourceOfReplaceArg(arg: ts.Expression): { source: string } | { unresolved: true } {
  if (ts.isRegularExpressionLiteral(arg)) {
    const literal = arg.getText()
    const m = /^\/(.*)\/[a-z]*$/su.exec(literal)
    return { source: m ? m[1]! : literal }
  }
  if (ts.isNewExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'RegExp') {
    const first = arg.arguments?.[0]
    if (first) {
      const literal = staticStringOf(first)
      if (literal !== null) return { source: literal }
    }
    return { unresolved: true } // new RegExp(变量 / 拼了插值的东西)——解析不出，可疑
  }
  if (staticStringOf(arg) !== null) return { source: '' } // 字面量字符串替换：不是正则，无否定字符类
  return { unresolved: true }
}

/**
 * 把 `.replace(...)` 的**第二个**实参（替换物）归一到三态：折成 `'-'` / 折成别的 / 认不出。
 *
 * 加固（本轮，记忆 counting-a-symbol-misses-other-spellings 的第二面）：早先这道闸只认字面量字符串
 * `'-'`（`staticStringOf(arg1) === '-'`）。于是把归一改写成**函数替换物**——`.replace(<slug 类>, () => '-')`、
 * `(m) => '-'`、`function () { return '-' }`——就整条静默绕过（连 unclassified 都不算，直接返回 []）。
 * 它与 SSOT 那份逐字节等价，正是 #644「第二份副本今天一致、明天漂移」的形状。现在把「折成什么」也
 * 归一：字面量按值判；单表达式箭头体、或单条 `return` 的函数体，若能**静态求值**成字符串就按那个值判；
 * 求不出（用到 match 参数、有分支、调别的函数）返回 `unknown`——由调用方在**正则恰是 slug 类**时标成
 * unclassified 响亮报出（伪装成动态替换物的第二份 slug），正则不是 slug 类时则静默（不制造噪声）。
 */
function replacementFoldsToHyphen(arg: ts.Expression): 'hyphen' | 'other' | 'unknown' {
  const direct = staticStringOf(arg)
  if (direct !== null) return direct === '-' ? 'hyphen' : 'other'
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    let body: ts.Expression | undefined
    if (ts.isArrowFunction(arg) && !ts.isBlock(arg.body)) body = arg.body
    else if (ts.isBlock(arg.body) && arg.body.statements.length === 1) {
      const only = arg.body.statements[0]!
      if (ts.isReturnStatement(only) && only.expression) body = only.expression
    }
    if (body) {
      const value = staticStringOf(body)
      if (value !== null) return value === '-' ? 'hyphen' : 'other'
    }
    return 'unknown' // 函数体求不出静态字符串——可疑，交给调用方按正则是否 slug 类决定响不响亮
  }
  return 'unknown' // 变量 / 调用返回等：认不出
}

/**
 * Every place in one source that reduces text to the branch-name alphabet, via TypeScript's own parser.
 *
 * A candidate is a `.replace(<x>, <r>)` or `.replaceAll(<x>, <r>)` call whose replacement `<r>` folds to
 * `'-'` (a literal `'-'`, or a function replacer that statically returns `'-'`). Its first argument is
 * resolved to a regex pattern; the negated class is canonicalised and compared to the lowercase-alnum
 * signature (`0-9|a-z`) — so `[^0-9a-z]`, `[^a-z\d]`, and `new RegExp('[^a-z0-9]')` all match, while the
 * repo's uppercase-keeping slugs do not. A candidate whose regex cannot be resolved statically, or whose
 * slug-class regex is paired with a replacer that does not statically resolve, is returned as
 * `unclassified` so the whole-repo scan fails loudly on it rather than silently treating it as "not a slug".
 *
 * 方法名认 `replace` 与 `replaceAll` 两种：早先只钉 `replace`，把归一改写成 `.replaceAll(…, '-')` 就整条
 * 绕过（静默返回 []）。替换物也不再只认字面量 `'-'`：函数替换物若静态求值成 `'-'` 也算，见
 * `replacementFoldsToHyphen`——那把 `.replace(<slug 类>, () => '-')` 这个静默 bypass 关上。
 */
const REDUCE_METHODS = new Set(['replace', 'replaceAll'])
type Reduction = { kind: 'slug'; text: string } | { kind: 'unclassified'; text: string }

function branchSlugReductions(source: string, label: string): Reduction[] {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Reduction[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      REDUCE_METHODS.has(node.expression.name.text) &&
      node.arguments.length >= 2
    ) {
      // 只看「折成连字符」这一动作——替换物折成 '-'（字面量，或静态返回 '-' 的函数替换物）。别的替换
      // （去尾斜杠成 ''、加前缀、返回别的字符）不是它，直接跳过；求不出的替换物先留着，下面按正则定夺。
      const fold = replacementFoldsToHyphen(node.arguments[1]!)
      if (fold !== 'other') {
        const resolved = regexSourceOfReplaceArg(node.arguments[0]!)
        if ('unresolved' in resolved) {
          // 折成连字符、正则又静态解析不出——可疑。替换物求不出（unknown）但正则也认不出时不再叠加噪声。
          if (fold === 'hyphen') found.push({ kind: 'unclassified', text: node.getText() })
        } else {
          const canonical = negatedClassCanonical(resolved.source)
          // 正则恰是 slug 类：替换物静态折成 '-' 就是第二份 slug；替换物求不出（unknown）则响亮报出——
          // 可能正是第二份 slug 用运行期替换物伪装（记忆 forbidden-list-guard-always-leaks）。
          if (canonical === BRANCH_SLUG_CANONICAL) {
            found.push({ kind: fold === 'hyphen' ? 'slug' : 'unclassified', text: node.getText() })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(file, visit)
  return found
}

describe('the branch-name slug lives in exactly one file', () => {
  // 没有这些自检，下面的全仓扫描可以靠「悄悄不再匹配任何东西」而恒绿——那正是让全仓守卫看起来
  // 周全、其实什么都没查的形状。
  //
  // 为什么拆成四张 it.each 表而不是挤在一个 it 里（#742 同族，本轮实测）：原先这 24 条断言同住一个
  // it，正向识别排在最前、反向自证（合法的 map/transform 式 .replace 不许被误报）排在最后。任何一条
  // 正向失败都让全部反向自证变成**死代码**，于是「收窄了识别面」和「误伤了合法代码」这两类相反的
  // 缺陷会被同一条红掩盖成一件事（记忆 two-throws-in-one-it-mask-each-other）。而且 24 条共用一个
  // 用例名时，红了也说不出是哪种拼法丢的——判据比缺陷粗（记忆 mutation-must-change-one-thing）。
  const slugText = (source: string): string[] =>
    branchSlugReductions(source, 'x.ts').filter((r) => r.kind === 'slug').map((r) => r.text)
  const unclassified = (source: string): Reduction[] =>
    branchSlugReductions(source, 'x.ts').filter((r) => r.kind === 'unclassified')

  // 分支名 slug 的等价拼法都要被认出——这几条正是 review agent 测得 5/5 green 的 bypass。
  it.each([
    { why: '基准拼法', code: "const s = v.toLowerCase().replace(/[^a-z0-9]+/gu, '-')" },
    { why: '换序的否定类 [^0-9a-z]', code: "const s = v.replace(/[^0-9a-z]+/gu, '-')" },
    { why: '\\d 代 0-9', code: "const s = v.replace(/[^a-z\\d]+/gu, '-')" },
    { why: 'new RegExp 构造', code: "const s = v.replace(new RegExp('[^a-z0-9]', 'gu'), '-')" },
    // replaceAll 与 replace 是同一件事的两种方法名。曾经的守卫把方法名硬钉在 replace 上，于是把这行
    // 改写成 replaceAll 就整条绕过（静默返回 []）——这一条正是那个存活变异的靶子。
    { why: 'replaceAll 换了方法名', code: "const s = v.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')" },
    // 函数替换物也要认：早先只认字面量 '-'，于是把归一改写成 `() => '-'` / `(m) => '-'` /
    // `function () { return '-' }` 就整条静默绕过（连 unclassified 都不算，直接 []）——它与 SSOT 逐字节
    // 等价，正是 #644 第二份副本的形状。这三条正是那个曾经存活的变异靶子（见文件尾说明）。
    { why: '箭头函数替换物折成 -', code: "const s = v.replace(/[^a-z0-9]+/gu, () => '-')" },
    { why: '带参箭头替换物折成 -', code: "const s = v.replaceAll(/[^0-9a-z]+/gu, (m) => '-')" },
    { why: '函数表达式替换物折成 -', code: "const s = v.replace(/[^a-z\\d]+/gu, function () { return '-' })" }
  ])('判据自检：$why 被认成一次分支名归一', ({ code }) => {
    expect(slugText(code), `这种拼法没被认出，它就是一条现成的绕过路：${code}`).toHaveLength(1)
  })

  // 近似但不同形的 .replace / .replaceAll，必须**不**被认成分支名 slug。误报久了必被加豁免、
  // 豁免再吃掉真缺陷，所以每一条都单独可观测。
  it.each([
    // 去尾部斜杠（workspace 路径归一），替换实参是 '' 不是 '-'，也没有否定小写字母数字类。
    { why: '去尾部斜杠', code: "const s = root.replace(/[\\\\/]+$/u, '')" },
    // 保留大写字母的 slug（workspace 路径段 / provider id）——集合含大写字母，规范形不同。
    { why: '保留大写的路径段 slug', code: "const s = b.replace(/[^A-Za-z0-9._-]+/g, '-')" },
    { why: '保留大写的 provider id slug', code: "const s = p.replace(/[^A-Za-z0-9_-]/g, '-')" },
    { why: '普通字符串替换', code: "const s = v.replace('a', 'b')" },
    // 合法的 replaceAll——替换实参不是 '-'（仓库现有的引号/ESC 转义都是这形状）。放宽方法名到
    // replaceAll 不能把它们误报成分支名 slug。
    { why: '替换实参不是连字符的 replaceAll 链', code: "const s = text.replaceAll(DATA_CLOSE, 'x').replaceAll(DATA_OPEN, 'y')" },
    { why: '保留大写的 replaceAll', code: "const s = b.replaceAll(/[^A-Za-z0-9._-]+/g, '-')" },
    // 函数替换物折成**别的**字符（不是 '-'）不是分支名 slug——反向钉住 replacementFoldsToHyphen 的
    // 'other' 那一支：把它误当 'hyphen' 会误报，把 slug 类 + `() => '-'` 漏掉会假绿。
    { why: '函数替换物折成下划线', code: "const s = v.replace(/[^a-z0-9]+/gu, () => '_')" },
    { why: '函数替换物折成空串', code: "const s = v.replace(/[^a-z0-9]+/gu, () => '')" }
  ])('反向自证：$why 不是分支名归一', ({ code }) => {
    expect(slugText(code), `合法代码被误报成分支名归一，这条门会发假红：${code}`).toEqual([])
  })

  // 归类不了的可疑形状要响亮，不能静默当成「不是 slug」（记忆 forbidden-list-guard-always-leaks）。
  it.each([
    // 折成连字符、但正则来自运行期构造，静态解析不出——可能正是第二份 slug 用变量正则伪装。
    { why: '动态正则 + 折连字符', code: "const rx = buildIt(); const s = v.replace(rx, '-')" },
    { why: 'new RegExp(变量) + 折连字符', code: "const s = v.replace(new RegExp(dyn), '-')" },
    // 另一副可疑形状：正则**恰是 slug 类**、但替换物静态求不出（用到 match 参数、有分支、调别的函数）——
    // 可能正是第二份 slug 用运行期替换物伪装。它必须响亮，而不是被 'other' 静默吞掉。
    { why: 'slug 类 + 求不出的函数替换物', code: "const s = v.replace(/[^a-z0-9]+/gu, (m) => transform(m))" },
    { why: 'slug 类 + 变量替换物', code: "const s = v.replace(/[^0-9a-z]+/gu, dyn)" }
  ])('判据自检：$why 被标成 unclassified 而不是静默放过', ({ code }) => {
    expect(unclassified(code), `这种可疑形状被静默吞掉了，它是藏第二份 slug 的天然去处：${code}`).toHaveLength(1)
  })

  // 反向自证的两半判的是**不同**的事，所以分两张表：内联字面量正则**是**一次合法归一（会产出
  // 一条 slug），只是不该被额外标成可疑；而非 slug 类的求不出替换物应当整个结果为空。本轮拆分时
  // 正是这条差别把两者挤进一张表的错误当场打红了——粗判据连"什么都没查"和"查错了"都分不开。
  it.each([
    { why: '内联字面量正则', code: "const s = v.replace(/[^a-z0-9]+/gu, '-')" },
    { why: '保留大写的内联正则', code: "const s = b.replace(/[^A-Za-z0-9._-]+/g, '-')" }
  ])('反向自证：$why 不制造 unclassified 噪声', ({ code }) => {
    expect(unclassified(code), `静态可判的正则被误标成可疑：${code}`).toEqual([])
  })

  it.each([
    // 正则**不是** slug 类时，求不出的替换物不制造噪声（否则全仓一堆合法的 map/transform 式 .replace
    // 都会误报）——只有「slug 类 + 认不出替换物」这个交叉才响亮。
    { why: '非 slug 类 + 求不出的函数替换物', code: "const s = v.replace(/[^A-Za-z0-9._-]+/g, (m) => transform(m))" },
    { why: '正则与替换物都是变量', code: 'const s = v.replace(rx, fn)' }
  ])('反向自证：$why 既不算归一也不算可疑', ({ code }) => {
    expect(branchSlugReductions(code, 'x.ts'), `合法的 .replace 被误报：${code}`).toEqual([])
  })

  it('finds the reduction in the SSOT and nowhere else under main/renderer/shared', () => {
    const files = SCAN_ROOTS.flatMap(({ url }) =>
      walk(url).map((rel) => ({ rel: `${url}${rel}`, source: readFileSync(new URL(`${url}${rel}`, import.meta.url), 'utf8') }))
    )

    // 前提自检：三个扫描根加起来得有像样的文件数，否则扫描根写错会让主断言静默通过。
    expect(files.length, '几乎没扫到文件——扫描根写错，主断言恒绿').toBeGreaterThan(50)

    const scanned = files.map((file) => ({ rel: file.rel, reductions: branchSlugReductions(file.source, file.rel) }))

    // 先钉「无法归类」这一侧：任何文件里出现折成连字符、但正则静态解析不出的 .replace，都可能是第二份
    // slug 用运行期正则伪装的。它必须让人回来看，而不是被当成安全（记忆 forbidden-list-guard-always-leaks）。
    const suspicious = scanned.flatMap(({ rel, reductions }) =>
      reductions.filter((r) => r.kind === 'unclassified').map((r) => `${rel}: ${r.text}`)
    )
    expect(suspicious, [
      '这些 .replace(…, "-") 的正则不是内联字面量，静态解析不出它折的是什么字符类。它可能正是',
      '第二份分支名 slug 用运行期构造的正则伪装起来。请改成内联正则字面量，或从 fanOutSlug 取。'
    ].join('\n')).toEqual([])

    const holders = scanned
      .map(({ rel, reductions }) => ({ rel, hits: reductions.filter((r) => r.kind === 'slug').map((r) => r.text) }))
      .filter(({ hits }) => hits.length > 0)

    // SSOT 必须在其中——否则「别处都没有」可能意味着这个归一整个消失了，而不是恰好一份。
    expect(
      holders.some(({ rel }) => rel.endsWith(SSOT_BASENAME)),
      'src/shared/fanout-naming.ts 里没找到分支名 slug 归一——SSOT 自己不见了，下面的断言会恒绿'
    ).toBe(true)

    const strays = holders
      .filter(({ rel }) => !rel.endsWith(SSOT_BASENAME))
      .map(({ rel, hits }) => `${rel}: ${hits.join(' | ')}`)
    expect(strays, [
      '这些文件自己写了一份分支名 slug 归一，而不是从 src/shared/fanout-naming.ts import fanOutSlug。',
      '第二份副本对今天的输入也许是对的，但它与那一份迟早漂移——#644 的不动点正是这样回来的。'
    ].join('\n')).toEqual([])
  })
})
