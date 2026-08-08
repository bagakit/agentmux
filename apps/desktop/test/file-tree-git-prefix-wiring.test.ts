import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 接线层：文件树 git 前缀在整个 renderer 里只有**一个**来源——main 随契约下发的那一个。
 *
 * 这是 #740 的第二半。行为层（`git-service.test.ts` 里的真 git 用例）钉的是「main 问 git 拿到的前缀
 * 是对的」；本文件钉的是「渲染层真的用它，而且没人重新自算」。两层各有各自的盲点，所以必须成对交付：
 *
 * - 行为层看不见 renderer。本包没有 DOM 测试环境（记忆 render-to-static-markup-blind-to-effects /
 *   zustand-ssr-renders-initial-state），`FileExplorer` 挂载后读到了什么在这里不可观测；把
 *   `buildFileTreeGitStatusIndex` 的第二个实参改成 `''`，行为层照旧全绿。
 * - 本层看不见取值。它只判语法关系，不判 `--show-prefix` 拿回来的那串字符对不对。
 *
 * 本层**刻意不**为 argv 立判据。这不是遗漏：把 `--show-prefix` 换成 `--show-toplevel` 实测在行为层打红
 * 两条（真 git 那条 + fake host 那条 toEqual），所以再加一条「argv 必须带 --show-prefix」只会是第二个
 * 预算守同一件事，短的那个只贡献假阴性（记忆 two-budgets-guard-one-thing）。
 *
 * 判据落在两件事上，各自都对着一个已经真实发生过的缺陷形状：
 *
 * 1. **实参就是契约字段。** 缺陷的原样是渲染层用 `repoPath` 与 `workspace.path` 做词法比较自算前缀
 *    （`workspace.startsWith(repo + '/')` 就切，否则 `''`），而这两个字符串来自不同世界：git 规范化
 *    symlink 与磁盘大小写，配置里那条路径不会。比较落空返回的 `''` 不是安全兜底——投影侧的过滤是
 *    `if (prefix && ...) continue`，空前缀让它既不过滤也不切，一个**干净**文件就此挂上别人的标记。
 *    所以判据不能只问「有没有传第二个实参」（传 `''` 也算传），要问**取值就是那个契约字段的读取**
 *    （记忆 optional-prop-only-buys-silence：只问在场买到的只是关掉 tsc）。
 * 2. **那个自算函数不许回来。** 它已经被删掉了；判据是全仓（renderer 全树）不得再出现同名导出或
 *    调用。若只守住调用点的实参，下一个人完全可以在别处重建一份，再把它的结果传进来——实参判据对
 *    此毫无察觉，因为传进去的确实是「某个表达式」。
 *
 * 自检在最后：判据依赖的语法形状必须真的在扫描面里被找到，否则改个写法就让整份守卫恒绿
 * （记忆 guard-must-check-reachability-not-presence）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_SRC = path.resolve(HERE, '../src/renderer/src')
const FILE_EXPLORER = path.join(RENDERER_SRC, 'components/FileExplorer.tsx')

/** 契约上那个字段的名字，和被删掉的那个自算函数的名字。两者都只在这里写一次。 */
const CONTRACT_FIELD = 'repoRelativePrefix'
const DELETED_SELF_COMPUTER = 'fileTreeRepoRelativePrefix'
const PROJECTION = 'buildFileTreeGitStatusIndex'

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 一棵子树里的每个节点，供下面几个提取器共用。 */
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/**
 * 对 `PROJECTION` 的每一次调用，返回它的实参列表。
 *
 * 按 callee 的**标识符**判，而不是按源码文本：`buildFileTreeGitStatusIndex(...)` 与
 * `lib.buildFileTreeGitStatusIndex(...)` 都要认到，而字符串里、注释里提到这个名字的地方不算调用。
 */
function projectionCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = []
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : null
    if (name === PROJECTION) calls.push(node)
  })
  return calls
}

/** 这个表达式是不是「读某个对象的 `<field>` 属性」——`x.repoRelativePrefix` 或 `x['repoRelativePrefix']`。 */
function readsField(expression: ts.Expression, field: string): boolean {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === field
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression
    return ts.isStringLiteralLike(argument) && argument.text === field
  }
  return false
}

/** renderer 全树下的每个 .ts/.tsx 源文件。 */
function rendererSources(): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.tsx?$/u.test(entry.name)) files.push(full)
    }
  }
  visit(RENDERER_SRC)
  return files
}

describe('文件树 git 前缀只有一个来源：main 随契约下发的那一个', () => {
  it('投影的前缀实参就是契约字段的读取，而不是渲染层自己算出来的某个值', () => {
    const source = parse(FILE_EXPLORER)
    const calls = projectionCalls(source)

    // 自检：调用点真的被找到了。若提取器因为写法变化而全落空，下面每一条都会恒真。
    expect(calls.length, `${FILE_EXPLORER} 里找不到对 ${PROJECTION} 的调用——提取器已失效`)
      .toBeGreaterThan(0)

    // 每一次调用都要么只传 changes（非 git 仓库那条早退路径，前缀无意义），要么第二个实参**就是**
    // 契约字段的读取。传字面量 `''`、传本地变量、传某个自算函数的返回值，全部不接受。
    const prefixArguments = calls
      .map((call) => call.arguments[1])
      .filter((argument): argument is ts.Expression => argument !== undefined)

    expect(
      prefixArguments.length,
      `${PROJECTION} 从来没被传过第二个实参——前缀根本没接上，投影退回「不过滤不切」`
    ).toBeGreaterThan(0)

    for (const argument of prefixArguments) {
      expect(
        readsField(argument, CONTRACT_FIELD),
        `${PROJECTION} 的前缀实参是 \`${argument.getText(source)}\`，不是契约字段 ` +
          `\`.${CONTRACT_FIELD}\` 的读取。渲染层一旦自己算这个前缀，两个字符串在祖先目录上分岔时` +
          `就会静默得到 ''，而 '' 让投影既不过滤也不切——干净文件会挂上别人的 git 标记。`
      ).toBe(true)
    }
  })

  it('那个按路径字符串自算前缀的函数不许在 renderer 里重新出现', () => {
    const offenders: string[] = []
    for (const file of rendererSources()) {
      const source = parse(file)
      walk(source, (node) => {
        if (ts.isIdentifier(node) && node.text === DELETED_SELF_COMPUTER) {
          offenders.push(path.relative(RENDERER_SRC, file))
        }
      })
    }

    expect(
      [...new Set(offenders)],
      `${DELETED_SELF_COMPUTER} 是被删掉的那个缺陷本身：它拿 repoPath 与 workspace.path 做词法比较，` +
        `比较落空时返回 ''。前缀现在只能来自 main（git 自己的 rev-parse --show-prefix）。`
    ).toEqual([])
  })

  it('自检：扫描面确实覆盖到了 FileExplorer 与足够多的 renderer 源文件', () => {
    const files = rendererSources()
    // 扫描根写错会让上面那条「不许重新出现」恒绿（记忆 false-green-gate-patterns：扫描根写错静默变绿）。
    expect(files, '消费者本身不在扫描面里').toContain(FILE_EXPLORER)
    expect(files.length, 'renderer 源文件扫出来太少，扫描根多半写错了').toBeGreaterThan(20)
  })
})
