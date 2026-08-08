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
// 另一半是**归类不了的可疑形状要响亮**（记忆 forbidden-list-guard-always-leaks）：一个
// `.replace(<动态>, '-')`——正则从变量/函数/`new RegExp(变量)` 来，静态解析不出——可能正是第二份 slug
// 用运行期构造的正则伪装起来。它被标成 unclassified，主扫描一律响亮失败并指名，绝不静默放过。
// 今天三个扫描根里一处这种写法都没有（每个折成连字符的 `.replace` 第一参都是内联正则字面量），
// 见 `recognises the reduction` 的反向自证。
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
 * Every place in one source that reduces text to the branch-name alphabet, via TypeScript's own parser.
 *
 * A candidate is a `.replace(<x>, '-')` call. Its first argument is resolved to a regex pattern; the
 * negated class is canonicalised and compared to the lowercase-alnum signature (`0-9|a-z`) — so
 * `[^0-9a-z]`, `[^a-z\d]`, and `new RegExp('[^a-z0-9]')` all match, while the repo's uppercase-keeping
 * slugs do not. A candidate whose regex cannot be resolved statically is returned as `unclassified` so
 * the whole-repo scan fails loudly on it rather than silently treating it as "not a slug".
 */
type Reduction = { kind: 'slug'; text: string } | { kind: 'unclassified'; text: string }

function branchSlugReductions(source: string, label: string): Reduction[] {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Reduction[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'replace' &&
      node.arguments.length >= 2 &&
      // 只看「折成连字符」这一动作——替换实参恰好是字符串 '-'。别的替换（去尾斜杠成 ''、加前缀）不是它。
      staticStringOf(node.arguments[1]!) === '-'
    ) {
      const resolved = regexSourceOfReplaceArg(node.arguments[0]!)
      if ('unresolved' in resolved) {
        found.push({ kind: 'unclassified', text: node.getText() })
      } else {
        const canonical = negatedClassCanonical(resolved.source)
        if (canonical === BRANCH_SLUG_CANONICAL) found.push({ kind: 'slug', text: node.getText() })
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(file, visit)
  return found
}

describe('the branch-name slug lives in exactly one file', () => {
  it('recognises the reduction across equivalent spellings and does not fire on ordinary .replace calls', () => {
    // 没有这条自检，下面的全仓扫描可以靠「悄悄不再匹配任何东西」而恒绿——那正是让全仓守卫看起来
    // 周全、其实什么都没查的形状。
    const slugText = (source: string): string[] =>
      branchSlugReductions(source, 'x.ts').filter((r) => r.kind === 'slug').map((r) => r.text)
    const unclassified = (source: string): Reduction[] =>
      branchSlugReductions(source, 'x.ts').filter((r) => r.kind === 'unclassified')

    // 分支名 slug 的等价拼法都要被认出——这几条正是 review agent 测得 5/5 green 的 bypass：
    expect(slugText("const s = v.toLowerCase().replace(/[^a-z0-9]+/gu, '-')"), '基准拼法没被认出').toHaveLength(1)
    expect(slugText("const s = v.replace(/[^0-9a-z]+/gu, '-')"), '换序 [^0-9a-z] 绕过了归一').toHaveLength(1)
    expect(slugText("const s = v.replace(/[^a-z\\d]+/gu, '-')"), '\\d 代 0-9 绕过了归一').toHaveLength(1)
    expect(slugText("const s = v.replace(new RegExp('[^a-z0-9]', 'gu'), '-')"), 'new RegExp 绕过了归一').toHaveLength(1)

    // 近似但不同形的 .replace，必须**不**被认成分支名 slug：
    // 1) 去尾部斜杠（workspace 路径归一），替换实参是 '' 不是 '-'，也没有否定小写字母数字类。
    expect(slugText("const s = root.replace(/[\\\\/]+$/u, '')")).toEqual([])
    // 2) 保留大写字母的 slug（workspace 路径段 / provider id）——集合含大写字母，规范形不同。
    expect(slugText("const s = b.replace(/[^A-Za-z0-9._-]+/g, '-')")).toEqual([])
    expect(slugText("const s = p.replace(/[^A-Za-z0-9_-]/g, '-')")).toEqual([])
    // 3) 普通字符串替换，不是 slug。
    expect(slugText("const s = v.replace('a', 'b')")).toEqual([])

    // 归类不了的可疑形状要响亮，不能静默当成「不是 slug」（记忆 forbidden-list-guard-always-leaks）：
    // 折成连字符、但正则来自运行期构造，静态解析不出——可能正是第二份 slug 用变量正则伪装。
    expect(unclassified("const rx = buildIt(); const s = v.replace(rx, '-')"), '动态正则的折连字符没被标 unclassified')
      .toHaveLength(1)
    expect(unclassified("const s = v.replace(new RegExp(dyn), '-')"), 'new RegExp(变量) 的折连字符没被标 unclassified')
      .toHaveLength(1)
    // 反向自证：内联字面量正则不会被误标成 unclassified。
    expect(unclassified("const s = v.replace(/[^a-z0-9]+/gu, '-')")).toEqual([])
    expect(unclassified("const s = b.replace(/[^A-Za-z0-9._-]+/g, '-')")).toEqual([])
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
