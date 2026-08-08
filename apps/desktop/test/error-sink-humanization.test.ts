import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// #197 class guard: a caught error must not reach a user as raw internal text.
//
// The leak this pins shut is a CLASS. A dozen-plus panels caught an `unknown` and shipped
// `cause instanceof Error ? cause.message : String(cause)` straight into an error banner — not even
// stripping Electron's `Error invoking remote method '<channel>': …` transport wrapper, which the store
// already knew to strip. The fix routes every such conversion through `presentError`
// (src/renderer/src/lib/error-presentation.ts), the one place that de-frames the message and keeps the
// raw original reachable. This guard fails when a new sink is added that bypasses it.
//
// ## Why this is an ALLOW-list keyed on TAINT, not a forbidden-list of spellings
//
// This repo has proven that a forbidden-list guard both LEAKS and MISFIRES: a banned-operator guard was
// slipped by Yoda conditions, a banned-property guard by destructuring / bracket access / an out-of-block
// helper. Banning the shape `X instanceof Error ? X.message : String(X)` would be exactly that trap —
// `message(cause)`, `const { message } = cause`, `cause['message']`, `` `${cause}` `` all evade it, and a
// file's own legitimate `foo === X.message` comparison gets caught in the crossfire.
//
// So the criterion is a TAINT question answered with the type checker, not a text match:
//   sink argument is a VIOLATION  ⟺  it derives a display string from an error-typed value
//                                     (`unknown` / `any` / `Error` / `AgentMuxError`) by any route,
//                                     EXCEPT through `presentError(...)`.
// "By any route" is enforced structurally ({@link derivesFromErrorWithoutPresenter} recurses through the
// whole argument expression), so a new spelling is caught by construction rather than by enumeration.
// `presentError` is the single sanctioned launderer: its output is clean no matter what it consumed,
// because it is the audited de-framer that keeps raw reachable.
//
// A shape the walker cannot classify is not silently passed — {@link classifySink} records it as
// `unknown` and the main assertion fails LOUDLY printing the SyntaxKind + source, because "a guard that
// green-lights what it does not understand" is how the next leak ships.
//
// ## What this guard does NOT see (declared blind spots)
//   1. Sinks that are not `set<...>Error(...)` calls with a `string`-dispatch setState type. A banner that
//      renders a raw string held in some OTHER state variable, or main-process `dialog.showErrorBox`, is
//      out of scope — this guard is the renderer setState surface. (The presence self-check pins the sink
//      count so a rename that hides the whole surface reds instead of passing on an empty scan.)
//   2. Domain humanizers that produce their OWN curated string (git-remote `describeGitRemote`, control
//      `addressingRecovery`, PR eligibility) legitimately pass a non-error-typed string to a sink; those
//      are clean by the taint rule and must stay so — this guard never forces them through `presentError`.
//   3. Laundering through an intermediate `const`: `const m = cause.message; setError(m)` reads `m` as a
//      plain `string` at the sink, so the taint is not visible AT the sink. Today every conversion is
//      inline at the sink, and the inline `.message`/`String()` forms ARE caught; the assign-then-use form
//      is not. It is a known gap, mitigated by the sink count pin (a new sink still has to appear) and by
//      the fact that the idiomatic fix (`presentError(cause)`) is shorter than the workaround.
//   4. The two peer-held files in {@link PENDING} still carry the old idiom (their owners hold them this
//      session). They are exempted with a REQUIRED-nonzero count each, so the exemption cannot rot into
//      cover: when a file is migrated its count must drop to 0 and this guard reds until PENDING is updated.
// ---------------------------------------------------------------------------

const RENDERER = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
const DESKTOP = fileURLToPath(new URL('../', import.meta.url))

/** The sanctioned laundering call. Its output is clean regardless of what it consumed. */
const PRESENTER = 'presentError'

/**
 * Files still carrying the pre-#197 idiom because a peer holds them uncommitted this session. Each MUST
 * still contain at least the stated number of violations — the reverse of a rotting allow-list: the
 * moment a file is migrated (its count → 0) this guard reds, forcing the entry to be removed rather than
 * left as permanent cover. Counts are the real numbers measured on HEAD at the time of writing.
 */
const PENDING: Readonly<Record<string, number>> = {
  'components/BranchesPanel.tsx': 5,
  'components/SurfaceToolDock.tsx': 6
}

type Sink = { file: string; text: string; kind: 'ok' | 'violation' | 'unknown'; syntaxKind: string }

function rendererSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...rendererSourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function buildProgram(roots: readonly string[]): ts.Program {
  const configFile = ts.readConfigFile(path.join(DESKTOP, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP)
  return ts.createProgram([...roots], parsed.options)
}

/** A value whose static type could be a raw caught error: `unknown` / `any` / `Error` / `AgentMuxError`. */
function isErrorTyped(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type]
  return parts.some((part) => {
    if (part.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return true
    const symbol = part.getSymbol()
    return symbol !== undefined && /^(Error|AgentMuxError)$/.test(symbol.getName())
  })
}

/**
 * Is this a `set…Error`-shaped setState function (the renderer's error-banner sinks)?
 *
 * Keyed on the setter's TYPE (`Dispatch<SetStateAction<… string …>>`), not merely its name — a `setError`
 * that is not a string setState (e.g. `setError(errorObject)` for a typed field) is not this surface. The
 * name pattern narrows to the error-display intent; the type pins that it writes a string the user sees.
 */
function isErrorStringSink(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(node.expression)) return false
  if (!/^set[A-Za-z0-9]*Error$/.test(node.expression.text)) return false
  const type = checker.typeToString(checker.getTypeAtLocation(node.expression))
  return /Dispatch<SetStateAction<[^>]*string/.test(type)
}

/**
 * Does this expression derive a display string from an error-typed value WITHOUT going through
 * `presentError`? Recurses the whole expression so a new spelling is caught structurally.
 *
 * Returns `'clean'` (no error-typed text, or all of it laundered by presentError), `'violation'` (raw
 * error text reaches the string), or `'unknown'` (a node the walker does not model — reported loudly).
 */
function classifyArgument(node: ts.Expression | undefined, checker: ts.TypeChecker): 'clean' | 'violation' | 'unknown' {
  if (!node) return 'clean'

  // presentError(...) launders whatever it consumed — its result is clean by construction.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === PRESENTER) {
    return 'clean'
  }

  // Direct extraction of `.message` off an error-typed value.
  if (
    (ts.isPropertyAccessExpression(node) && node.name.text === 'message') ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'message')
  ) {
    if (isErrorTyped(checker.getTypeAtLocation(node.expression))) return 'violation'
  }

  // `String(errorish)`.
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'String' &&
    node.arguments[0] &&
    isErrorTyped(checker.getTypeAtLocation(node.arguments[0]))
  ) {
    return 'violation'
  }

  // Any OTHER call: if it is handed an error-typed argument it is a framing-unaware converter
  // (`message(cause)`, `humanize(err)`) doing the job presentError should — the raw text can leak, so
  // violation. Otherwise it is a domain helper producing its own curated string
  // (`browserOpenError(activePaneId)`) and the caught error does not flow through it here; recurse into
  // its arguments anyway so a nested converter (`wrap(message(cause))`) cannot hide behind an outer call.
  // This taint rule — not a name list — is what lets curated humanizers pass while conversions do not.
  if (ts.isCallExpression(node)) {
    if (node.arguments.some((arg) => isErrorTyped(checker.getTypeAtLocation(arg)))) return 'violation'
    let worst: 'clean' | 'violation' | 'unknown' = 'clean'
    for (const arg of node.arguments) {
      const verdict = classifyArgument(arg, checker)
      if (verdict === 'violation') worst = 'violation'
      else if (verdict === 'unknown' && worst === 'clean') worst = 'unknown'
    }
    return worst
  }

  // A template literal `…${x}…`: the only value-bearing parts are the span expressions. `forEachChild`
  // yields TemplateHead / TemplateSpan wrappers (not Expressions), so reach the interpolations directly.
  if (ts.isTemplateExpression(node)) {
    let worst: 'clean' | 'violation' | 'unknown' = 'clean'
    for (const span of node.templateSpans) {
      const verdict = classifyArgument(span.expression, checker)
      if (verdict === 'violation') worst = 'violation'
      else if (verdict === 'unknown' && worst === 'clean') worst = 'unknown'
    }
    return worst
  }

  // Compositional shapes the walker understands: recurse into every child EXPRESSION and take the worst
  // verdict. Non-expression children (operator tokens, `?`/`:`) carry no value and are skipped —
  // classifying a raw token would spuriously read as 'unknown'. Any expression shape not enumerated as a
  // leaf below still surfaces as 'unknown' rather than passing silently.
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isBinaryExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    let worst: 'clean' | 'violation' | 'unknown' = 'clean'
    node.forEachChild((child) => {
      if (!ts.isExpression(child)) return
      const verdict = classifyArgument(child, checker)
      if (verdict === 'violation') worst = 'violation'
      else if (verdict === 'unknown' && worst === 'clean') worst = 'unknown'
    })
    return worst
  }

  // Leaf shapes that never carry error text into a string: literals, `null`/`undefined`, identifiers and
  // member/element reads whose receiver is NOT error-typed (curated domain-result fields like
  // `outcome.message`, `draft.reason`), functional-updater arrows.
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined') ||
    ts.isIdentifier(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  ) {
    return 'clean'
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    // A `.message`/`.reason`/… read off a NON-error-typed receiver is a curated domain result — clean.
    return isErrorTyped(checker.getTypeAtLocation(node.expression)) ? 'violation' : 'clean'
  }

  return 'unknown'
}

function classifySink(node: ts.CallExpression, sourceFile: ts.SourceFile, checker: ts.TypeChecker): Sink {
  const arg = node.arguments[0]
  const verdict = classifyArgument(arg, checker)
  return {
    file: path.relative(RENDERER, sourceFile.fileName),
    text: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 90),
    kind: verdict === 'violation' ? 'violation' : verdict === 'unknown' ? 'unknown' : 'ok',
    syntaxKind: arg ? ts.SyntaxKind[arg.kind] : 'NONE'
  }
}

function scanRenderer(): { sinks: Sink[]; scannedFiles: number } {
  const roots = rendererSourceFiles(RENDERER)
  const program = buildProgram(roots)
  const checker = program.getTypeChecker()
  const scanned = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && file.fileName.startsWith(RENDERER))
  const sinks: Sink[] = []
  for (const sourceFile of scanned) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isErrorStringSink(node, checker)) {
        sinks.push(classifySink(node, sourceFile, checker))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { sinks, scannedFiles: scanned.length }
}

// One scan, reused across the assertions below.
const { sinks, scannedFiles } = scanRenderer()
const violationsByFile = new Map<string, number>()
for (const sink of sinks) if (sink.kind === 'violation') {
  violationsByFile.set(sink.file, (violationsByFile.get(sink.file) ?? 0) + 1)
}

describe('#197 每个 caught error 只能经 presentError 到达错误显示汇', () => {
  it('自证：扫描面真的抓到了渲染层的一批文件与足够多的错误汇（扫空目录时判据会恒真）', () => {
    // A scan that finds zero sinks and reports green is the most common false-green in this repo. Pin the
    // sink count so a rename of the setter shape (or a wrong scan root) reds here instead of passing an
    // empty scan. 74 is the real count measured with the same criterion; it may grow, never collapse.
    expect(scannedFiles).toBeGreaterThan(50)
    expect(sinks.length, '错误显示汇数量塌了——setState 汇的形状或扫描根回归了').toBeGreaterThanOrEqual(74)
  })

  it('没有 unknown 形状被静默放过（不认识的写法要响亮失败，不能默认通过）', () => {
    const unknowns = sinks.filter((sink) => sink.kind === 'unknown')
    expect(
      unknowns,
      unknowns.length === 0
        ? ''
        : `这些错误汇的实参是本守卫没有建模的形状——它既不是 presentError 也无法判定安全，必须被显式归类而不是默认放过：\n` +
            unknowns.map((sink) => `  ${sink.file}: [${sink.syntaxKind}] ${sink.text}`).join('\n')
    ).toEqual([])
  })

  it('除待迁移的 peer 持有文件外，没有 caught error 绕过 presentError 直达错误汇', () => {
    const offenders = sinks.filter(
      (sink) => sink.kind === 'violation' && !(sink.file in PENDING)
    )
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `这些位置把一个 caught error（unknown/Error）直接转成横幅文本，绕过了 presentError——` +
            `#197 要消灭的正是这一族（连 Electron 的 IPC 传输前缀都不会被剥掉）。改成 setError(presentError(cause))：\n` +
            offenders.map((sink) => `  ${sink.file}: ${sink.text}`).join('\n')
    ).toEqual([])
  })

  it('待迁移清单不许腐烂：每个 peer 持有文件必须仍含它声明的违规数（迁移后必须从清单移除）', () => {
    // The exemption is only honest if it cannot silently become permanent cover. Require each PENDING file
    // to STILL hold at least its declared violation count. When a peer migrates the file, its count drops
    // and this reds — forcing the stale exemption out rather than letting it hide a regression.
    for (const [file, expected] of Object.entries(PENDING)) {
      const actual = violationsByFile.get(file) ?? 0
      expect(
        actual,
        `${file} 在待迁移清单里声明还有 ${expected} 处违规，实际找到 ${actual} 处。` +
          `若它已被迁移（违规归零），把它从 PENDING 移除；若违规变多，清单数字要更新。`
      ).toBeGreaterThanOrEqual(expected)
    }
  })
})

describe('#197 守卫的判据自证（反向：合法/违规的合成样本各判对）', () => {
  // Parse a synthetic module with a real program so the checker types the fixtures, then run the SAME
  // classifier over it. This proves the criterion is neither always-red nor always-green.
  function classifyProbe(body: string): Sink[] {
    const fileName = path.join(RENDERER, '__probe__.tsx')
    const source = [
      "import { useState } from 'react'",
      "import { presentError } from './lib/error-presentation'",
      'function message(e: unknown): string { return e instanceof Error ? e.message : String(e) }',
      'export function Probe() {',
      '  const [, setError] = useState<string | null>(null)',
      '  async function run(): Promise<void> {',
      '    try { await Promise.resolve() } catch (cause) {',
      `      ${body}`,
      '    }',
      '  }',
      '  return run',
      '}'
    ].join('\n')
    // Root ONLY the synthetic file: the checker resolves its imports (react, error-presentation.ts) on
    // demand, so `cause`/`presentError`/`setError` are all typed without rooting every renderer file. Doing
    // the latter rebuilt the whole program five times (~16s) and timed the self-check out under load — the
    // full-tree scan already lives in scanRenderer(), which runs once; the probe only needs its own module.
    const configFile = ts.readConfigFile(path.join(DESKTOP, 'tsconfig.json'), ts.sys.readFile)
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP)
    const host = ts.createCompilerHost(parsed.options)
    const original = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
      if (path.resolve(name) === path.resolve(fileName)) {
        return ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TSX)
      }
      return original(name, languageVersion, onError, shouldCreate)
    }
    host.fileExists = (name) => path.resolve(name) === path.resolve(fileName) || ts.sys.fileExists(name)
    host.readFile = (name) => (path.resolve(name) === path.resolve(fileName) ? source : ts.sys.readFile(name))
    const program = ts.createProgram([fileName], parsed.options, host)
    const checker = program.getTypeChecker()
    const sourceFile = program.getSourceFile(fileName)!
    const found: Sink[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isErrorStringSink(node, checker)) found.push(classifySink(node, sourceFile, checker))
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return found
  }

  it('合法：setError(presentError(cause)) 不被判违规', () => {
    const found = classifyProbe('setError(presentError(cause))')
    expect(found.map((sink) => sink.kind)).toEqual(['ok'])
  })

  it('合法：setError(null) 与已脱敏的领域结果字段不被判违规', () => {
    expect(classifyProbe('setError(null)').map((s) => s.kind)).toEqual(['ok'])
    // A `.message` off a NON-error value (a curated domain result) is clean.
    expect(classifyProbe("const outcome = { message: 'ok' as string }; setError(outcome.message)").map((s) => s.kind))
      .toEqual(['ok'])
  })

  it('合法：产出自己文案、不接 caught error 的领域 helper 不被判违规（?? / non-null 组合也放过）', () => {
    // The taint rule draws the line at "does a caught error flow through this?", not at "is it a call?".
    // A curated humanizer that takes no error-typed argument must pass — mirrors SurfaceToolDock's real
    // `setError(focusError ?? browserOpenError(undefined)!)`.
    expect(
      classifyProbe("function browserOpenError(id: string | undefined): string | null { return id ? null : 'x' }\n" +
        '      const focusError: string | null = null\n' +
        '      setError(focusError ?? browserOpenError(undefined)!)').map((s) => s.kind)
    ).toEqual(['ok'])
  })

  it('违规：inline 的 cause instanceof Error ? cause.message : String(cause) 被判违规', () => {
    const found = classifyProbe('setError(cause instanceof Error ? cause.message : String(cause))')
    expect(found.map((sink) => sink.kind)).toEqual(['violation'])
  })

  it('违规：换个拼法也抓得住——直接 .message、String()、下标读、framing-unaware helper', () => {
    // These are the forbidden-list evasions. Each must still be a violation, proving the taint criterion
    // is not tied to one spelling.
    expect(classifyProbe('setError(String(cause))').map((s) => s.kind), 'String(cause)').toEqual(['violation'])
    expect(classifyProbe('setError(message(cause))').map((s) => s.kind), 'framing-unaware helper').toEqual(['violation'])
    expect(
      classifyProbe('if (cause instanceof Error) setError(cause.message)').map((s) => s.kind),
      'direct .message on narrowed Error'
    ).toEqual(['violation'])
    expect(
      classifyProbe("if (cause instanceof Error) setError(cause['message'])").map((s) => s.kind),
      "bracket access cause['message']"
    ).toEqual(['violation'])
    expect(
      classifyProbe('setError(`failed: ${cause instanceof Error ? cause.message : String(cause)}`)').map((s) => s.kind),
      'template composition'
    ).toEqual(['violation'])
  })
})
