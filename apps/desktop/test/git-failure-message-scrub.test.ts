import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
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
 * ## 判据为什么是 import 关系，不是「有没有出现 scrub 这个词」
 *
 * 按名字查在这一族上是**必漏的**：`gitFailureMessage` 里那条 `stderr || stdout || fallback`
 * 链子随手就能在别处重抄一遍，而重抄出来的那份代码里根本不会出现 `scrub` 这个词——名字检查看到的
 * 是「这个文件没提 scrub」，判不出它到底是「不需要」还是「自己抄了一份忘了擦」。
 * （记忆 guard-criterion-must-be-import-relation、counting-a-symbol-misses-other-spellings。）
 *
 * 所以判据落在**取值面**上：AST 上找出每一处「读了 `.stderr` 又参与拼消息」的位置，要求它所在的文件
 * 必须从 `git-service` 导入取值口。文件里出不出现 `scrub` 无关；重抄的那份**必然**要读 `.stderr`，
 * 这是绕不过去的——那是 git 唯一说出失败原因的地方。
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
 * {@link MESSAGE_BUILDERS} 枚举**合法形状**（哪个文件可以自己拼），其余一律违规，包括我没想到的
 * 写法——这正是要的性质。禁止清单的势是「语言能表达同一件事的所有写法」，无界。
 * （记忆 forbidden-list-guard-always-leaks：同一处守卫的两版禁止清单各被实测绕过。）
 */

const MAIN = fileURLToPath(new URL('../src/main', import.meta.url))

/** 取值口自己的家。只有这个文件可以拼那条 fallback 链。 */
const SSOT = 'git-service.ts'

/** 允许自己构造 git 失败消息的文件。SSOT 一个，别无。 */
const MESSAGE_BUILDERS = new Set([SSOT])

type Offender = { file: string; text: string }
type SourceText = { file: string; text: string }

/** 这个文件 shell 出去跑 git / gh 吗。跑，才在这条守卫的范围里。 */
function shellsOutToGit(source: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const first = node.arguments[0]!
      if (ts.isStringLiteral(first) && (first.text === 'git' || first.text === 'gh')) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * 找出每一处「把 `.stderr` 拼进一条消息」的位置。
 *
 * 判据形状：一个读 `x.stderr` 的属性访问，其**祖先**里有 `||` / `??` 的二元表达式或模板串——
 * 也就是它正在参与「拼出一条给人看的话」。单纯 `if (result.stderr !== '')` 这种判空不算，
 * 那是控制流不是消息构造。
 */
function messageBuildingStderrReads(source: ts.SourceFile): string[] {
  const reads: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'stderr' &&
      participatesInMessage(node)
    ) {
      reads.push(enclosingStatementText(node))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return reads
}

/** 这次读取有没有流进一条拼出来的消息。 */
function participatesInMessage(read: ts.Node): boolean {
  for (let node: ts.Node | undefined = read.parent; node; node = node.parent) {
    if (ts.isTemplateExpression(node)) return true
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) return true
    // 语句边界：再往上就与这次读取无关了。
    if (ts.isStatement(node)) return false
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

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

/**
 * 整条判据，一个函数。
 *
 * 判据是「跑 git 的文件里，除 SSOT 外**一次**拼消息的 stderr 读取都不许有」——注意不是
 * 「导入了取值口就放过这个文件」。合法调用方把整个 `result` 交给取值口
 * （`gitFailureError(result, fallback)`），它自己那行里根本没有 `.stderr`；读 stderr 这件事发生在
 * `git-service` 内部。所以「文件里还有拼消息的 stderr 读取」本身就是手抄的充分证据。
 *
 * 我第一版写成「这个文件 import 了取值口就整体跳过」，实测被绕过：把 `assertGit` 的函数体换回
 * 裸 `new Error(result.stderr.trim() || ...)`，而文件顶上那行 import 还在——守卫看见 import 就跳过
 * 整个文件，8 条全绿，而这恰好是 #481 那个真泄漏本身。判在场不判可达性，是同一族错误
 * （记忆 guard-must-check-reachability-not-presence）。
 *
 * `importsMessageAccessor` 因此不再参与 offender 判定，只留作末条**接线**断言：两个 service
 * 确实拿了取值口。两条各守一件事，各自的变异只红各自那条。
 *
 * 自证必须走**同一条**取值路径，包括「哪些文件在范围里」「怎么找到那次读取」这两步。只验叶子谓词
 * （「participatesInMessage 认得出 `||` 吗」）证不出东西：范围判定或找位置那一步一旦回归，
 * 真断言拿到空清单恒真变绿，而只验叶子的自证察觉不到（记忆 extracting-to-lib-only-fixes-half）。
 */
function offendersIn(files: SourceText[]): Offender[] {
  const offenders: Offender[] = []
  for (const { file, text } of files) {
    if (MESSAGE_BUILDERS.has(file)) continue
    const source = parse(file, text)
    if (!shellsOutToGit(source)) continue
    for (const read of messageBuildingStderrReads(source)) offenders.push({ file, text: read })
  }
  return offenders
}

/** 范围内的文件（跑 git/gh 的），供范围自身的断言用。 */
function gitShellingFiles(files: SourceText[]): string[] {
  return files.filter(({ file, text }) => shellsOutToGit(parse(file, text))).map(({ file }) => file)
}

function mainProcessFiles(): SourceText[] {
  return readdirSync(MAIN)
    .filter((name) => name.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(MAIN, file), 'utf8') }))
}

describe('git 失败消息只有一个构造口', () => {
  it('跑 git 的文件里没有第二处自己拼失败消息的地方', () => {
    const files = mainProcessFiles()
    // 扫描根或范围判定写错会让整条判据静默恒真，所以先钉住它确实看见了该看见的东西。
    expect(files.length).toBeGreaterThan(20)
    expect(gitShellingFiles(files).sort()).toEqual(['gh-service.ts', 'git-service.ts', 'worktree-service.ts'])

    expect(offendersIn(files)).toEqual([])
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
    // 顶上那行 import 是刻意留的：这正是我第一版被绕过的形状（见 offendersIn 的注释）。
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

  it('反向自证 1：跑 git 且走取值口的代码不报红', () => {
    // 合法形状：整个 result 交给取值口，调用方自己不读 stderr；判空的控制流也不算拼消息。
    const legitimate = `
      import { gitFailureError } from './git-service.js'
      async function a(host: Host) {
        const result = await host.run('git', ['status'], {})
        if (result.stderr !== '') return null
        if (result.exitCode !== 0) throw gitFailureError(result, 'failed')
        return result.stdout
      }
    `
    expect(offendersIn([{ file: 'legitimate.ts', text: legitimate }])).toEqual([])
  })

  it('反向自证 2：不跑 git 的文件自己拼错误消息不报红', () => {
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

  it('两个 service 都真的走取值口（不是恰好今天没有失败路径）', () => {
    for (const file of ['worktree-service.ts', 'gh-service.ts']) {
      const source = parse(file, readFileSync(join(MAIN, file), 'utf8'))
      expect(importsMessageAccessor(source), `${file} 必须从 git-service 拿取值口`).toBe(true)
    }
  })
})
