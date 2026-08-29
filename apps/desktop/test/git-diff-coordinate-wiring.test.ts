import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * 接线层守卫（#761）：**喂给「打开 diff」的那个路径，取值必须来自坐标转换**，不能是 porcelain 原样。
 *
 * 为什么这一层非要单独存在。行为层（git-service.test.ts 里那三条真 git 用例）钉的是「`diff()` 收到
 * workspace-相对路径时做对了什么」——它把服务端的契约钉死了，但它对**调用方喂进去的是哪一种坐标**完全
 * 失明：调用方递 `change.path`（仓库根相对）时，服务端照旧忠实执行，只是执行在另一个文件上。#761 本体
 * 就是这个形状，而且它在 repo 根 == workspace 的自家仓库里逐字相同，所以两层缺一层都抓不到。
 *
 * 判据是 **import 关系 + 取值来源**，不是「名字出现过」：
 *   - `not.toContain('change.path')` 之类的禁止清单必漏（换个变量名、先存进局部量、下标读都绕过），且会
 *     误伤本文件里三个写动词——它们**就该**用 `change.path`（记忆 forbidden-shape-guard-misfires）。
 *   - 只判 `workspaceRelativeGitPath` 在场同样不够：调用它、然后把返回值丢掉、仍旧递 `change.path`，
 *     「在场」判据全绿（记忆 optional-prop-only-buys-silence / presence-assertion-blind-when-shape-repeats）。
 * 所以走 TS parser，把每个 `openFileDiff(...)` 的实参提出来，要求它**能追溯到**那次转换的返回值。
 *
 * 自检在最后：提取器必须真的找到调用点。找不到时静默通过是这族守卫最常见的恒绿形态。
 */

const RENDERER_ROOT = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
const CONVERSION = 'workspaceRelativeGitPath'
const DIFF_OPENER = 'openFileDiff'

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function rendererSources(): string[] {
  const files: string[] = []
  const descend = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) descend(path)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path)
    }
  }
  descend(RENDERER_ROOT)
  return files
}

/** The callee's own identifier, so `f(x)` and `obj.f(x)` both answer `f` — and strings never do. */
function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  return null
}

/** Every call to `name` in this source, in source order. */
function callsTo(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(source, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === name) found.push(node)
  })
  return found
}

/**
 * The names bound to the result of a `CONVERSION` call in this file — `const p = f(...)`, and the
 * conditional forms a caller reaches for when null is a real answer (`x ? f(...) : null`, `f(...) ?? y`).
 * A guard that only accepted the bare `const p = f(...)` shape would go blind the moment the caller has
 * to handle the "names nothing in this tree" answer, which is exactly what #761's caller does.
 *
 * 传递闭包，不是一跳。取值经过一次中转再递出去是本仓真实在用的形状：`SessionResultReview` 先把
 * 转换结果绑成 `timelineDiffPath`，再由 `uniqueTimelineDiffPath` 做一次去重后才递给 `openFileDiff`。
 * 只认一跳会把这个**已经转换过**的调用点报成违例——而守卫误伤合法代码比没有守卫更糟：下一个人
 * 会照着报错把 `uniqueTimelineDiffPath` 改成直接递 porcelain 路径，那才真的把 #761 装回去。
 *
 * 局部函数同样算数：把转换包进 `function f(...) { … return workspaceRelativeGitPath(…) }` 再调用，
 * 取值依然来自转换。`timelinePathForWorkspace` 正是这个形状（它的另一条臂走 Workspace 约束规则，
 * 两条臂产出的都是编辑器坐标）。
 *
 * 只看初始化式的**取值位**，不看整段文本。`cond ? A : B` 真正被绑定的是 A 或 B，条件里提到什么
 * 都不算数——否则 `timelineDiffPath ? change.path : null` 会因为"提到了一个转换过的名字"被放行，
 * 而它递出去的正是 porcelain 路径。放宽传递闭包时最容易开的就是这个洞。
 */
function resultExpressions(node: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return resultExpressions(node.expression)
  if (ts.isConditionalExpression(node)) {
    return [...resultExpressions(node.whenTrue), ...resultExpressions(node.whenFalse)]
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      return [...resultExpressions(node.left), ...resultExpressions(node.right)]
    }
    // `a && b` 取值是 b（a 为假时是 a 本身，那一侧只会是 null/undefined/false 这类空值）。
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return resultExpressions(node.right)
  }
  return [node]
}

/** 空值取值位不需要来自转换：`: null` 表达的是"没有可打开的路径"。 */
function isEmptyResult(node: ts.Expression): boolean {
  return node.kind === ts.SyntaxKind.NullKeyword
    || node.kind === ts.SyntaxKind.FalseKeyword
    || (ts.isIdentifier(node) && node.text === 'undefined')
}

function namesBoundToConversion(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  // 先收本文件里"返回值来自转换"的局部函数名，它们与 CONVERSION 同样算作转换的来源。
  const converters = new Set<string>([CONVERSION])
  const containsCallTo = (node: ts.Node, callees: ReadonlySet<string>): boolean => {
    let hit = false
    walk(node, (inner) => {
      if (ts.isCallExpression(inner)) {
        const name = calleeName(inner)
        if (name !== null && callees.has(name)) hit = true
      }
    })
    return hit
  }
  walk(source, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return
    if (containsCallTo(node.body, converters)) converters.add(node.name.text)
  })
  // 再求名字绑定的传递闭包：一轮只能看见直接绑定，中转量要多走几轮才连得上。
  // 判据是**每一个**非空取值位都来自转换——有一个取值位递的是别的东西，这个名字就不算转换过。
  for (let round = 0; round < 8; round += 1) {
    const before = names.size
    walk(source, (node) => {
      if (!ts.isVariableDeclaration(node)) return
      if (!ts.isIdentifier(node.name) || !node.initializer) return
      if (names.has(node.name.text)) return
      const results = resultExpressions(node.initializer).filter((result) => !isEmptyResult(result))
      if (results.length === 0) return
      const everyResultConverted = results.every((result) =>
        containsCallTo(result, converters) || (ts.isIdentifier(result) && names.has(result.text))
      )
      if (everyResultConverted) names.add(node.name.text)
    })
    if (names.size === before) break
  }
  return names
}

describe('#761 接线层：打开 diff 的路径取值必须来自坐标转换', () => {
  const sources = rendererSources()

  it('every openFileDiff argument is a value the coordinate conversion produced', () => {
    const offenders: string[] = []
    let inspected = 0
    for (const file of sources) {
      const source = parse(file)
      const calls = callsTo(source, DIFF_OPENER)
      // 只有真的传了实参的调用点才是接线点：`state.openFileDiff` 这种取值、以及 store 里的定义/声明，
      // 都不是调用。零实参的调用（若有）也不构成坐标决策。
      const wiring = calls.filter((call) => call.arguments.length > 0)
      if (wiring.length === 0) continue
      const converted = namesBoundToConversion(source)
      for (const call of wiring) {
        inspected += 1
        const argument = call.arguments[0]!
        const text = argument.getText(source)
        // 实参本身就是那次转换调用，或者是绑定了转换结果的局部量——两者都算「取值来自转换」。
        const inline = ts.isCallExpression(argument) && calleeName(argument) === CONVERSION
        const viaName = ts.isIdentifier(argument) && converted.has(argument.text)
        if (!inline && !viaName) {
          const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1
          offenders.push(`${file.slice(RENDERER_ROOT.length + 1)}:${line} → ${DIFF_OPENER}(${text})`)
        }
      }
    }
    expect(
      offenders,
      `这些调用点递给 ${DIFF_OPENER} 的不是 ${CONVERSION} 的产物——porcelain 的仓库根相对路径会被当成` +
        `编辑器坐标，在子目录 workspace 下静默打开另一个文件（#761）`
    ).toEqual([])
    // 自检：提取器必须真的看见接线点。看不见时上面那条断言恒真，正是这族守卫的恒绿形态。
    expect(inspected, `扫不到任何带实参的 ${DIFF_OPENER} 调用——判据恒真`).toBeGreaterThan(0)
  })

  /**
   * 同一份坐标合同的**另一半**，而且是个真实的过度修正形态：把 #761 「到处都转一遍」修一遍，
   * 三个写动词就全坏了——它们直连 `git`，要的正是 porcelain 那套坐标。子目录 workspace 下，转换后的
   * 路径喂给 `git add` 会指到仓库里另一处，或者干脆不存在；而在 repo 根 == workspace 的自家仓库里，
   * 它照旧逐字相同，测不出来。所以这一侧必须与「打开 diff 那一侧」同时钉住，否则修一个坏一个。
   *
   * 判据是**取值来源**（不得是转换的产物），不是禁止某种拼法：禁 `workspaceRelativeGitPath(` 字样
   * 会被换名、先存局部量、包一层 helper 绕过（记忆 forbidden-shape-guard-misfires）。
   * 它买不到的那一半也说清楚：另起一个第三种坐标（比如自己手算前缀）它认不出来——那属于「重复的
   * 规则」，由转换函数只此一份这件事去守。
   */
  it('the write verbs are fed the porcelain path, never the converted one', () => {
    const WRITE_VERBS = ['stage', 'unstage', 'discard']
    const offenders: string[] = []
    let inspected = 0
    for (const file of sources) {
      const source = parse(file)
      const converted = namesBoundToConversion(source)
      for (const verb of WRITE_VERBS) {
        for (const call of callsTo(source, verb)) {
          // 这三个动词的签名都是 (workspaceId, path, …)，所以坐标决策在第二个实参上。
          if (call.arguments.length < 2) continue
          inspected += 1
          const argument = call.arguments[1]!
          let derived = false
          walk(argument, (node) => {
            if (ts.isCallExpression(node) && calleeName(node) === CONVERSION) derived = true
            if (ts.isIdentifier(node) && converted.has(node.text)) derived = true
          })
          if (derived) {
            const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1
            offenders.push(
              `${file.slice(RENDERER_ROOT.length + 1)}:${line} → ${verb}(…, ${argument.getText(source)})`
            )
          }
        }
      }
    }
    expect(
      offenders,
      `这些写动词收到的是 ${CONVERSION} 转换后的路径——它们直连 git，要的是 porcelain 坐标；` +
        `子目录 workspace 下会作用到另一个路径上（#761 的反向形态）`
    ).toEqual([])
    // 自检：三个写动词必须真被扫到。它们全都在同一个组件里，一个都找不到就说明扫描面错了。
    expect(inspected, `扫不到任何两参以上的 ${WRITE_VERBS.join('/')} 调用——判据恒真`).toBeGreaterThan(2)
  })

  it('the conversion is imported where it is called, so a same-named local cannot stand in for it', () => {
    const callers = sources.filter((file) => callsTo(parse(file), CONVERSION).length > 0)
    const missing: string[] = []
    for (const file of callers) {
      const source = parse(file)
      let imported = false
      walk(source, (node) => {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
        if (!node.moduleSpecifier.text.endsWith('git-path-coordinates')) return
        const clause = node.importClause?.namedBindings
        if (clause && ts.isNamedImports(clause)) {
          for (const element of clause.elements) {
            if (element.name.text === CONVERSION) imported = true
          }
        }
      })
      if (!imported) missing.push(file.slice(RENDERER_ROOT.length + 1))
    }
    // 判 import 关系而不是名字：同名局部函数能满足「名字在场」，但满足不了「从 SSOT 那个模块导入」
    // （记忆 guard-criterion-must-be-import-relation）。
    expect(
      missing,
      `这些文件调了 ${CONVERSION} 却没从 git-path-coordinates 导入它——可能是个同名的本地副本`
    ).toEqual([])
    expect(callers.length, `全渲染层扫不到 ${CONVERSION} 的调用方——判据恒真`).toBeGreaterThan(0)
  })

  it('scans the renderer tree it claims to, including the Changes panel', () => {
    const relative = sources.map((file) => file.slice(RENDERER_ROOT.length + 1))
    expect(relative).toContain(join('components', 'ChangesPanel.tsx'))
    expect(relative).toContain(join('lib', 'git-path-coordinates.ts'))
    expect(relative.length).toBeGreaterThan(20)
  })
})
