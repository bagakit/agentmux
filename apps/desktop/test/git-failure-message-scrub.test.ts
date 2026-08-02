import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import { gitFailureError, gitFailureMessage } from '../src/main/git-service.js'

/**
 * 守的缺陷（#481 / #484）：两个 service 各写了一份 `assertGit`，字节级相同，**只差一个 scrub**。
 *
 * `git-service` 那份把消息过 `scrubGitCredentials`，`worktree-service` 那份直接抛裸 stderr。
 * 分岔恰好落在安全的那一半。而 worktree 侧那条串不是内部日志——它变成 `retained.reason`，再变成
 * 删除对话框的描述文案。remote 写成 `https://$TOKEN@host/o/r` 时，任何回显 URL 的失败都会把 token
 * 放进 stderr，所以这条泄漏不需要任何特殊配置，只需要一次失败。
 *
 * 修法不是「给第二份补上 scrub」——那样留下的还是同一个形状，第三份手抄照旧不带 scrub。
 * `gh-service` 当时确实已经是第三份，它恰好抄对了；但「恰好」不是机制。收成一处之后，
 * **没有地方能构造出不擦洗的 git 失败消息**。
 *
 * ## 判据落在**取值面**上：谁读了 `.stderr`
 *
 * 按名字查在这一族上是**必漏的**：`gitFailureMessage` 里那条 `stderr || stdout || fallback`
 * 链子随手就能在别处重抄一遍，而重抄出来的那份代码里根本不会出现 `scrub` 这个词——名字检查看到的
 * 是「这个文件没提 scrub」，判不出它到底是「不需要」还是「自己抄了一份忘了擦」。
 * （记忆 guard-criterion-must-be-import-relation、counting-a-symbol-misses-other-spellings。）
 *
 * 所以判据落在**取值面**上：git 唯一说出失败原因的地方是 `.stderr`，重抄那份**必然**要读它，绕不过去。
 * 于是找出每一处 `.stderr` 读取，问它是不是**合法形状**之一（见 {@link isPermittedStderrRead}），
 * 不是就报红。判 stderr 读取本身，而不是「它有没有流进一条拼出来的消息」——后者要沿数据流追下去，
 * 跨过一次 `const detail = result.stderr.trim()` 就断了；判读取点本身没有这个盲区。
 *
 * ## 扫描范围是**查出来的**，不是列出来的
 *
 * 范围 = 「这个文件 shell 出去跑 git 或 gh」，由 {@link shellsOutToGit} 在 AST 上判。
 * 这一点是承重的：我最初写成「main 进程所有文件」，于是 `workspace-files.ts` 里四处
 * `realpath` / `find` / `rm` 的失败消息全被判违规——那些跑的不是 git，消息里没有 remote URL，
 * 让它们去导入 git 的取值口毫无道理。会对正确代码报红的守卫下一个人会直接删掉，那时连剩下的
 * 覆盖一起消失（记忆 forbidden-list-guard-always-leaks 的反向自证那一条）。
 *
 * 一张手写的豁免清单也不行：每次有人新加一个读 stderr 的文件都要去改清单，而**忘了改清单的人会
 * 被判红、于是他会去加豁免**——豁免自己就是下一个绕法的载荷。查出来的范围没有这个问题：
 * 不跑 git 的文件天然不在里面，而一旦谁把 git 引进某个文件，那个文件当场进入范围。
 *
 * 已知的取舍：如果有人往 `workspace-files.ts` 里加一个 git shell-out，它那四处非 git 的错误链
 * 会一起被判红。这是**刻意保留的响亮失败**——把 git 引进一个已有四条手拼错误链的文件，正是需要有人
 * 看一眼的时刻；要么把 git 调用挪到 service 里，要么让那四处也走取值口。
 *
 * ## 允许清单，不是禁止清单
 *
 * {@link isPermittedStderrRead} 枚举 stderr 读取的**合法形状**（只有两种），其余一律违规，
 * 包括我没想到的写法——这正是要的性质。禁止清单的势是「语言能表达同一件事的所有写法」，无界：
 * `String(x)` / `x.concat` / `[…].join` / `'…' + x` / 三元 / `{ message: x }` / 先存进变量再拼……
 * 每一种都是一个新拼法，数不完（记忆 forbidden-list-guard-always-leaks、
 * counting-a-symbol-misses-other-spellings）。允许清单只有两条，多出来的任何东西都是违规。
 * 本仓有过同一处修正的先例：一处「禁止形状不在场」的守卫被换成允许清单，因为新拼法走过去了。
 */

const MAIN = fileURLToPath(new URL('../src/main', import.meta.url))

/** 取值口自己的家。只有这个文件可以拼那条 fallback 链。 */
const SSOT = 'git-service.ts'

/** 允许自己构造 git 失败消息的文件。SSOT 一个，别无。 */
const MESSAGE_BUILDERS = new Set([SSOT])

type Offender = { file: string; text: string }
type SourceText = { file: string; text: string }
type StderrRead = { file: string; text: string; permitted: boolean }

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/**
 * 一个表达式静态求出来的字符串常量，求不出返回 null。
 *
 * 承重点：`shellsOutToGit` 曾只认 `ts.isStringLiteral`，于是 `host.run(`git`, …)`（模板串）和
 * `host.run('gi' + 't', …)`（拼接）这两种写法整个文件都不在范围里——它们跑的是 git，却被静默豁免。
 * 折叠无替换模板串与字符串字面量的 `+` 链，把这两种拼法收回范围。
 */
function staticStringValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left)
    const right = staticStringValue(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

/** 这个文件 shell 出去跑 git / gh 吗。跑，才在这条守卫的范围里。 */
function shellsOutToGit(source: ts.SourceFile): boolean {
  let found = false
  walk(source, (node) => {
    if (found) return
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const value = staticStringValue(node.arguments[0]!)
      if (value === 'git' || value === 'gh') found = true
    }
  })
  return found
}

/** 这个文件从 `./git-service.js` 导入的所有本地名字。取值口、擦洗口、分类谓词都在这里露面。 */
function namesImportedFromGitService(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.endsWith('git-service.js')) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    // element.name 是本地名——调用点写的就是它（`import { x as y }` 时调用点是 `y`）。
    for (const element of bindings.elements) names.add(element.name.text)
  }
  return names
}

function isComparisonToken(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    kind === ts.SyntaxKind.LessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanToken ||
    kind === ts.SyntaxKind.GreaterThanEqualsToken
  )
}

/**
 * 一处 `.stderr` 读取是不是允许清单里的合法形状。只有两种，其余（含没想到的写法）一律违规。
 *
 * 形状 1：直接作为「从 git-service 导入的函数」的实参。分类谓词（`isNotAGitRepositoryStderr`）与
 *   擦洗口（`scrubGitCredentials`）都在这里——值进了 SSOT 就归 SSOT 负责：谓词只吐布尔，擦洗口已擦。
 *   判的是 import 关系而非名字，所以 SSOT 以后新导出的取值口自动放过，不必来改这里（记忆
 *   guard-criterion-must-be-import-relation）。注意要求读取点**本身**是实参：`fn(result.stderr.trim())`
 *   里实参是那次 `.trim()` 调用、读取点的父是 `.trim` 属性访问，不算——先 `.trim` 再交出去正是绕法之一。
 * 形状 2：纯比较（`result.stderr !== ''` 之类）。结果是布尔，永远拼不成一条给人看的话，是控制流不是消息。
 */
function isPermittedStderrRead(read: ts.PropertyAccessExpression, fromGitService: ReadonlySet<string>): boolean {
  const parent = read.parent
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(read) &&
    ts.isIdentifier(parent.expression) &&
    fromGitService.has(parent.expression.text)
  ) {
    return true
  }
  if (
    ts.isBinaryExpression(parent) &&
    (parent.left === read || parent.right === read) &&
    isComparisonToken(parent.operatorToken.kind)
  ) {
    return true
  }
  return false
}

function enclosingStatementText(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isStatement(current)) return current.getText().replace(/\s+/g, ' ').slice(0, 160)
  }
  return node.getText()
}

/** 这个文件从 git-service 拿到取值口了吗。判的是 import 关系，不是名字有没有出现。 */
function importsMessageAccessor(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.endsWith('git-service.js')) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const name = element.propertyName?.text ?? element.name.text
      if (name === 'gitFailureMessage' || name === 'gitFailureError') return true
    }
  }
  return false
}

/**
 * 范围内（跑 git/gh、非 SSOT）每一处 `.stderr` 读取，连同它是不是允许清单里的合法形状。
 *
 * 自证必须走**同一条**取值路径，包括「哪些文件在范围里」「怎么找到那次读取」这两步。只验叶子谓词
 * （「isPermittedStderrRead 认得出比较吗」）证不出东西：范围判定或找位置那一步一旦回归，真断言拿到空
 * 清单恒真变绿，而只验叶子的自证察觉不到（记忆 extracting-to-lib-only-fixes-half）。所以下面的主断言
 * 先钉 `reads.length > 0`：范围内确实看见了要判的读取，才谈得上「它们都合法」。
 */
function stderrReadsIn(files: SourceText[]): StderrRead[] {
  const reads: StderrRead[] = []
  for (const { file, text } of files) {
    if (MESSAGE_BUILDERS.has(file)) continue
    const source = parse(file, text)
    if (!shellsOutToGit(source)) continue
    const fromGitService = namesImportedFromGitService(source)
    walk(source, (node) => {
      if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'stderr') return
      reads.push({ file, text: enclosingStatementText(node), permitted: isPermittedStderrRead(node, fromGitService) })
    })
  }
  return reads
}

function offendersIn(files: SourceText[]): Offender[] {
  return stderrReadsIn(files)
    .filter((read) => !read.permitted)
    .map(({ file, text }) => ({ file, text }))
}

/** 范围内的文件（跑 git/gh 的），供范围自身的断言用。 */
function gitShellingFiles(files: SourceText[]): string[] {
  return files.filter(({ file, text }) => shellsOutToGit(parse(file, text))).map(({ file }) => file)
}

/**
 * 某目录下所有 `.ts` 文件的源码，**递归**。
 *
 * 承重点：曾用非递归的 `readdirSync`，于是任何落在子目录里的 main 进程文件整个在扫描根之外——
 * 扫描根写错的守卫是静默变绿的（记忆 false-green-gate-patterns 的「扫描根写错」）。递归后，
 * 以后有人把 git service 挪进子目录也照样进范围。参数化 `root` 只为让「递归」和「空目录」这两条
 * 自证能对着临时目录跑，生产入口固定是 {@link MAIN}。
 */
function readTsFilesRecursively(root: string): SourceText[] {
  return readdirSync(root, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
}

function mainProcessFiles(): SourceText[] {
  return readTsFilesRecursively(MAIN)
}

/** 自证用的临时扫描根，跑完清掉。 */
const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('git 失败消息只有一个构造口', () => {
  it('跑 git 的文件里没有第二处自己拼失败消息的地方', () => {
    const files = mainProcessFiles()
    // 扫描根或范围判定写错会让整条判据静默恒真，所以先钉住它确实看见了该看见的东西。
    expect(files.length).toBeGreaterThan(20)
    expect(gitShellingFiles(files).sort()).toEqual(['gh-service.ts', 'git-service.ts', 'worktree-service.ts'])

    const reads = stderrReadsIn(files)
    // 找读取那一步一旦回归会拿到空清单，让下面那条恒真变绿；先钉它确实找到了要判的读取点。
    // 范围里真实存在的是 worktree-service 那两处分类谓词调用（合法形状 1）。
    expect(reads.length, '范围内一处 .stderr 读取都没找到——找读取或范围判定回归了').toBeGreaterThan(0)
    expect(reads.filter((read) => !read.permitted)).toEqual([])
  })

  it('取值口本身擦洗凭据：URL 里的 userinfo 不进消息', () => {
    const leaky = { exitCode: 128, stdout: '', stderr: 'fatal: could not read https://tok@h/o/r\n' }
    expect(gitFailureMessage(leaky, 'fallback')).toBe('fatal: could not read https://***@h/o/r')
    expect(gitFailureError(leaky, 'fallback').message).toBe('fatal: could not read https://***@h/o/r')
  })

  it('三级 fallback：stderr 优先，其次 stdout，都空才用兜底', () => {
    expect(gitFailureMessage({ stdout: 'out', stderr: 'err' }, 'fb')).toBe('err')
    expect(gitFailureMessage({ stdout: 'out', stderr: '   ' }, 'fb')).toBe('out')
    expect(gitFailureMessage({ stdout: '', stderr: '' }, 'fb')).toBe('fb')
  })

  it('判据认得出手抄：重抄一份 fallback 链即报红（import 还在也不放过）', () => {
    // 这段代码里**没有** scrub 这个词——按名字查的守卫看不见它，这正是判据要落在取值面的理由。
    // 顶上那行 import 是刻意留的：光有 import 不代表这处读取合法，读取点本身要过允许清单。
    const copy = `
      import { gitFailureError } from './git-service.js'
      async function run(host: Host) {
        const result = await host.run('git', ['status'], {})
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'failed')
        }
      }
    `
    expect(offendersIn([{ file: 'fresh-copy.ts', text: copy }])).toHaveLength(1)
  })

  it('判据认得出模板串拼法（换个拼法不该绕过）', () => {
    const template = `
      async function report(host: Host) {
        const result = await host.run('gh', ['pr', 'list'], {})
        return \`gh failed: \${result.stderr.trim()}\`
      }
    `
    expect(offendersIn([{ file: 'template.ts', text: template }])).toHaveLength(1)
  })

  it('允许清单对 20 种绕法各报红一次（禁止清单会漏的那些拼法）', () => {
    // 逐种拼法各一处 `.stderr` 读取，都不是「交给 git-service 导入的函数」也不是「比较」，故都该报红。
    // 前 17 种是把 stderr 经某个不在清单里的组合节点送进消息（旧的 `participatesInMessage` 只认
    // 模板串与 `||`/`??`，全放过）；后 3 种把读取与拼消息拆到两条语句，判读取点本身照样抓得住。
    const bypasses: Record<string, string> = {
      'String() 强转': `throw new Error(String(result.stderr))`,
      '.concat()': `throw new Error('git failed: '.concat(result.stderr.trim()))`,
      "数组 .join()": `throw new Error(['git failed', result.stderr.trim()].join(': '))`,
      '装成擦洗口的漏函数实参': `throw new Error(passthru(result.stderr.trim()))`,
      '.trim() 直接送进 Error': `throw new Error(result.stderr.trim())`,
      '.slice()': `throw new Error(result.stderr.slice(0, 200))`,
      '.replace()（看着像清洗其实没擦凭据）': `throw new Error(result.stderr.replace(/\\n/g, ' '))`,
      '.padEnd() 等其他字符串方法': `throw new Error(result.stderr.padEnd(10))`,
      'JSON.stringify': `throw new Error(JSON.stringify({ e: result.stderr }))`,
      '+ 号拼接': `throw new Error('git failed: ' + result.stderr.trim())`,
      '逗号运算符': `throw new Error((0, result.stderr.trim()))`,
      '三元': `throw new Error(result.exitCode ? result.stderr.trim() : 'failed')`,
      '对象属性 { message: … }': `throw { message: result.stderr.trim() }`,
      '括号包一层': `throw new Error((result.stderr.trim()))`,
      'as 断言': `throw new Error(result.stderr.trim() as string)`,
      '裸 stderr 直接 new Error': `throw new Error(result.stderr)`,
      'return 直接返回': `return result.stderr.trim()`,
      '先存变量再 || 拼（跨语句）': `const detail = result.stderr.trim()\n        throw new Error(detail || 'failed')`,
      '先存变量再模板拼（跨语句）': `const detail = result.stderr.trim()\n        throw new Error(\`git: \${detail}\`)`,
      '赋给外层变量随后用（跨语句）': `let m = ''\n        m = result.stderr.trim()\n        return m`
    }
    const gitShelling = (body: string): string =>
      `async function f(host: Host) {\n        const result = await host.run('git', ['status'], {})\n        ${body}\n      }`
    for (const [label, body] of Object.entries(bypasses)) {
      expect(offendersIn([{ file: 'bypass.ts', text: gitShelling(body) }]), `绕法「${label}」没被报红`).toHaveLength(1)
    }
  })

  it('反向自证 1：跑 git 且把 stderr 交给 git-service 导入的函数不报红', () => {
    // 合法形状 1：`.stderr` 作为「从 git-service 导入的函数」的实参——分类谓词只吐布尔，值进了 SSOT。
    // 这正是 worktree-service 真实的两处读取的形状，也是主断言里被判 permitted 的那些。
    const legitimate = `
      import { isNotAGitRepositoryStderr } from './git-service.js'
      async function a(host: Host) {
        const result = await host.run('git', ['status'], {})
        if (result.exitCode !== 0 && isNotAGitRepositoryStderr(result.stderr)) return null
        return result.stdout
      }
    `
    const reads = stderrReadsIn([{ file: 'legitimate.ts', text: legitimate }])
    // 先证探针里那处 `.stderr` 读取确实被看见并判为合法，再证它不进 offender——否则「不报红」
    // 可能只是因为读取压根没被找到（走同一条路径的在场自证）。
    expect(reads.map((read) => read.permitted)).toEqual([true])
    expect(offendersIn([{ file: 'legitimate.ts', text: legitimate }])).toEqual([])
  })

  it('反向自证 2：控制流里判空 stderr（比较）不报红', () => {
    // 合法形状 2：`result.stderr !== ''` 是比较，产出布尔，是控制流不是拼消息。
    const guardOnly = `
      import { gitFailureError } from './git-service.js'
      async function a(host: Host) {
        const result = await host.run('git', ['status'], {})
        if (result.stderr !== '') return null
        if (result.exitCode !== 0) throw gitFailureError(result, 'failed')
        return result.stdout
      }
    `
    const reads = stderrReadsIn([{ file: 'guard-only.ts', text: guardOnly }])
    expect(reads.map((read) => read.permitted)).toEqual([true])
    expect(offendersIn([{ file: 'guard-only.ts', text: guardOnly }])).toEqual([])
  })

  it('反向自证 3：不跑 git 的文件自己拼错误消息不报红', () => {
    // 这是范围判定承重的那一条：`workspace-files.ts` 真的长这样（realpath / find / rm 的失败消息）。
    // 判据若按「main 进程所有文件」扫，这些全被判违规——而它们跑的不是 git，消息里没有 remote URL。
    const nonGit = `
      async function remoteRealPath(host: Host, path: string) {
        const result = await host.run('realpath', ['--', path], {})
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || \`Could not resolve \${path}\`)
        }
        return result.stdout.trim()
      }
    `
    expect(offendersIn([{ file: 'non-git.ts', text: nonGit }])).toEqual([])
  })

  it('模板串 / 拼接写法的 git 调用也进范围（不再静默豁免）', () => {
    // `host.run(`git`, …)` 与 `host.run('gi' + 't', …)` 曾因 shellsOutToGit 只认字符串字面量而整个
    // 文件不在范围里。现在两者都进范围，其中的漏 stderr 读取照样报红。
    const templateInvocation = `
      async function f(host: Host) {
        const result = await host.run(\`git\`, ['status'], {})
        throw new Error(result.stderr.trim())
      }
    `
    const concatInvocation = `
      async function g(host: Host) {
        const result = await host.run('gi' + 't', ['status'], {})
        throw new Error(result.stderr.trim())
      }
    `
    expect(gitShellingFiles([{ file: 'tmpl.ts', text: templateInvocation }])).toEqual(['tmpl.ts'])
    expect(gitShellingFiles([{ file: 'concat.ts', text: concatInvocation }])).toEqual(['concat.ts'])
    expect(offendersIn([{ file: 'tmpl.ts', text: templateInvocation }])).toHaveLength(1)
    expect(offendersIn([{ file: 'concat.ts', text: concatInvocation }])).toHaveLength(1)
  })

  it('扫描是递归的：子目录里的 main 进程文件也在扫描根内', () => {
    // 曾用非递归 readdirSync，子目录里的文件整个在扫描根之外（扫描根写错＝静默变绿）。
    const root = mkdtempSync(join(tmpdir(), 'git-scrub-scan-'))
    tempDirs.push(root)
    writeFileSync(join(root, 'top.ts'), 'export const a = 1\n')
    mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'nested', 'deep.ts'), 'export const b = 2\n')

    const found = readTsFilesRecursively(root).map(({ file }) => file).sort()
    expect(found).toContain(join('nested', 'deep.ts'))
    expect(found).toContain('top.ts')
  })

  it('在场自证：扫描根为空目录时，主断言的前提当场落空', () => {
    // 把范围指向空目录，`files.length` 与「找到的 .stderr 读取数」都归零——主断言里那两条
    // `toBeGreaterThan` 会响亮失败，而不是因为没东西可判而恒真变绿。
    const empty = mkdtempSync(join(tmpdir(), 'git-scrub-empty-'))
    tempDirs.push(empty)
    const files = readTsFilesRecursively(empty)
    expect(files.length).toBe(0)
    expect(stderrReadsIn(files).length).toBe(0)
  })

  it('两个 service 都真的走取值口（不是恰好今天没有失败路径）', () => {
    for (const file of ['worktree-service.ts', 'gh-service.ts']) {
      const source = parse(file, readFileSync(join(MAIN, file), 'utf8'))
      expect(importsMessageAccessor(source), `${file} 必须从 git-service 拿取值口`).toBe(true)
    }
  })
})
