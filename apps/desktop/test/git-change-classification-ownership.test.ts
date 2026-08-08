import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// WHO may read git's two raw porcelain status columns, enforced structurally over the whole renderer.
//
// Porcelain v1 gives every change two columns, `XY`: `index` (X, index-vs-HEAD) and `worktree`
// (Y, worktree-vs-index) on {@link GitFileChange}. **A merge conflict is a property of the PAIR, not of
// either letter.** Git's seven unmerged codes are exactly `DD AU UD UA DU AA UU`. A reader that picks ONE
// column and switches on it gets four of the seven wrong — `DD`→deleted, `AU`→added, `DU`→deleted,
// `AA`→added — while the three it gets right (`UD`/`UA`/`UU`) are right only by accident, because their X
// happens to be `U`. That was #746: the file tree's colouring and the Changes panel's label had each
// hand-written that single-column switch, and neither noticed because on the common conflict `UU` both
// were correct. The pair also cannot be reduced to "both columns dirty": `AD` (staged add, then deleted
// on disk) and `RM` (staged rename, then modified) are real non-conflicts with TWO non-blank columns, so
// conflict detection has to be the closed enumerated set of seven codes — which is what
// `git-porcelain-status.ts` now owns.
//
// The fix centralised the decision in ONE module (`git-porcelain-status.ts`), read through
// `gitChangeClass` / `gitUnmergedCodeOf` / `gitChangeLabel`. This guard keeps it centralised: it fails if
// any renderer file OTHER than that SSOT re-derives the classification from the raw columns. The criterion
// is an OWNERSHIP rule over the two raw fields — a read of `.index` / `.worktree` on a `GitFileChange`
// belongs to the SSOT alone; everyone else consumes the classifier.
//
// ─── WHY THE CRITERION IS SYMBOL IDENTITY, NOT A PROPERTY-NAME BLOCKLIST ───
//
// A name blocklist on `index` / `worktree` is useless here, and measurably so: `.index` is one of the
// most overloaded reads in the renderer. Measured on the real tree, a bare name match for `.index` would
// fire on `match.index` (terminal-path-link.ts, TerminalView.tsx — a `RegExpMatchArray`), `mark.index`
// (ConversationAxis.tsx), `marker.index`, `reference.index` (markdown-file-reference.ts), and
// `readout.index` (activity-ruler.ts) — none of which is a `GitFileChange`. An exemption list for them is
// a second hand-copied scope that decays on every new file (记忆 forbidden-list-guard-always-leaks).
//
// So this drives the TypeScript type checker. A read counts ONLY when the checker resolves the read's key
// to `GitFileChange`'s OWN `index` / `worktree` property symbol: the receiver's type is split into its
// union constituents and each is asked `getPropertyOfType(constituent, key)`, and the answer counts only
// when that symbol is identical (`===`) to one the SSOT type declares. `match.index` resolves to
// `RegExpMatchArray.index` — a different symbol — and never enters the finding set. That the homonyms are
// silently correct is the whole reason this guard is worth having; it is asserted below, both on the real
// tree (self-check "scan面") and synthetically ("innocent homonyms").
//
// ─── BYPASS SHAPES COVERED (a name blocklist leaks; this must not) ───
//
// The extractor sees, and each is exercised by a synthetic self-check below plus, for the two present in
// the tree today, the real scan:
//   · plain member          `change.index`
//   · optional chain        `change?.index`               (nullable receiver; non-nullable is taken first)
//   · element access        `change['worktree']`          (string-literal key)
//   · destructuring         `const { index, worktree } = change`
//   · renamed destructuring `const { index: i } = change`
//   · read inside a helper  `function f(x: GitFileChange) { return x.worktree }`
//   · through a runtime-transparent wrapper `(change as any).index`, `change!.worktree`, `(change).index`
//     — these compile to the same read, so the receiver is stripped of parens / `!` / `as` / `satisfies`
//     before its type is taken, and BOTH the wrapped and unwrapped types are offered.
//
// ─── DECLARED BLIND SPOTS (an undeclared blind spot is the worst outcome) ───
//
//   · It is a LEXICAL walk over each file's own AST with a full checker, not a dataflow analysis. A column
//     copied into a local first (`const raw = change.index; switch (raw)`) is still caught at the
//     `change.index` read — but a `GitFileChange` widened to `any`/`string`-shaped before the read, or
//     reached through an INDEX/computed key the checker cannot resolve to a literal
//     (`change[dynamicKey]`), is not: the position stops being `GitFileChange`-typed, exactly as it does
//     for the homonyms. This is the same conservative direction the needs-you guard takes.
//   · It only reads `index` / `worktree`. The derived booleans (`staged`, `unstaged`, `untracked`) are
//     legitimately read by consumers (ChangesPanel groups on `staged`, the SSOT's tail switches on
//     `staged`), so they are deliberately NOT owned here — a consumer switching on `staged` is not
//     re-deriving the conflict classification, which is the thing #746 got wrong.
//   · Scope is the renderer (`src/renderer/src`). The producer in `src/main/git-service.ts` CONSTRUCTS a
//     `GitFileChange` from local `token[0]`/`token[1]` variables and never reads `.index` off one, so it
//     has no raw-column read to police; widening the scan to all of `src` was measured to add zero
//     findings, and narrowing to the renderer keeps the guard about the surface the bug lived on.
//   · The scan face is the TS program, and the self-check that pins it to the on-disk set only has teeth
//     for the files the program holds as ROOTS. TypeScript pulls an imported file in even when `exclude`
//     names it, so excluding an imported module cannot shrink the scan face (measured: excluding
//     lib/quick-switch.ts kept all 6 green). Two renderer files are roots today; excluding one of those
//     does red. A file made unreachable some other way is the residual blind spot.
// ─────────────────────────────────────────────────────────────────────────────

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = path.join(DESKTOP_DIR, 'src')
const RENDERER_SRC = path.join(SRC_DIR, 'renderer/src')
const CONTRACTS_FILE = path.join(SRC_DIR, 'shared/contracts.ts')
/** The one module allowed to read the raw columns — the SSOT the #746 fix created. */
const SSOT_FILE = path.join(RENDERER_SRC, 'lib/git-porcelain-status.ts')

/** The two raw porcelain columns, and the only property names this guard is about. */
const RAW_COLUMN_NAMES: ReadonlySet<string> = new Set(['index', 'worktree'])

function isSourceFileName(fileName: string): boolean {
  if (fileName.endsWith('.d.ts')) return false
  return fileName.endsWith('.ts') || fileName.endsWith('.tsx')
}

/**
 * Every renderer source file on disk, enumerated from the filesystem rather than from the TS program.
 *
 * Deliberately a second, independent enumeration: the guard's scan face comes from the program, so a file
 * tsconfig omits is one the guard can never flag while staying green. The self-check "scan面" asserts these
 * two sets are equal, which is the only thing that makes the compiler's coverage a checked property.
 */
function rendererFilesOnDisk(): string[] {
  return readdirSync(RENDERER_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isSourceFileName(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/**
 * The property symbols `GitFileChange` declares for `index` and `worktree`, read from the code.
 *
 * Read from the declaration rather than typed out so the guard cannot drift from the contract: if the
 * field is renamed, this resolves to a different symbol (or none) and the self-check that pins the set to
 * exactly two members fails loudly, instead of the guard silently policing a name that no longer exists.
 *
 * The declaration is found by scanning every program source for the `GitFileChange` alias/interface, not
 * by filename: in another program (the synthetic self-checks) it lives in the fixture itself.
 */
function rawColumnSymbols(program: ts.Program, checker: ts.TypeChecker): Set<ts.Symbol> {
  let changeType: ts.Type | null = null
  for (const source of program.getSourceFiles()) {
    ts.forEachChild(source, (node) => {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        node.name.text === 'GitFileChange'
      ) {
        changeType = checker.getTypeAtLocation(ts.isTypeAliasDeclaration(node) ? node.name : node)
      }
    })
  }
  const symbols = new Set<ts.Symbol>()
  if (!changeType) return symbols
  for (const name of RAW_COLUMN_NAMES) {
    const symbol = checker.getPropertyOfType(changeType, name)
    if (symbol) symbols.add(symbol)
  }
  return symbols
}

/**
 * Strip runtime-transparent wrappers so `(change as any).index` reads like `change.index`.
 *
 * Parentheses, `!`, `as` and `satisfies` all compile away, so a cast added to quiet the type checker must
 * not also hide the raw-column read behind it. Returns the innermost wrapped expression.
 */
function unwrap(expr: ts.Expression): ts.Expression {
  let inner: ts.Expression = expr
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression
  }
  return inner
}

/**
 * Does reading `key` off `receiver` resolve to one of `GitFileChange`'s own raw-column symbols?
 *
 * The receiver's type is taken both as written and after {@link unwrap} (a cast changes the type but not
 * the runtime read), each is made non-nullable (`change?.index`) and split into union constituents
 * (`GitFileChange | Other`), and every constituent is asked for its `key` property. The match is SYMBOL
 * IDENTITY against the SSOT's declared symbols — this is the single thing that tells `change.index` from
 * `match.index`, and why no exemption list appears in this file.
 */
function readsRawColumn(
  receiver: ts.Expression,
  key: string,
  checker: ts.TypeChecker,
  targets: ReadonlySet<ts.Symbol>
): boolean {
  const candidates = new Set<ts.Type>([checker.getTypeAtLocation(receiver)])
  const inner = unwrap(receiver)
  if (inner !== receiver) candidates.add(checker.getTypeAtLocation(inner))
  for (const candidate of candidates) {
    const nonNull = checker.getNonNullableType(candidate)
    for (const part of nonNull.isUnion() ? nonNull.types : [nonNull]) {
      const symbol = checker.getPropertyOfType(part, key)
      if (symbol && targets.has(symbol)) return true
    }
  }
  return false
}

/** One offending raw-column read: where it is and what it looks like. */
export interface RawColumnRead {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Every raw-column read of a `GitFileChange` in one source file, across all bypass shapes.
 *
 * Member access (`change.index`, `change?.index`, wrapped), element access with a string-literal key
 * (`change['worktree']`), and object destructuring (`const { index } = change`, renamed
 * `const { index: i } = change`). The destructuring branch resolves the property against the type of the
 * pattern AND of the (unwrapped) initializer — the pattern's type is `any` when the initializer is cast to
 * `any`, so the initializer recovers it.
 */
export function rawColumnReadsIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  targets: ReadonlySet<ts.Symbol>
): RawColumnRead[] {
  const found: RawColumnRead[] = []
  const relative = path.relative(RENDERER_SRC, sourceFile.fileName)
  const record = (node: ts.Node): void => {
    found.push({
      file: relative,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      text: node.getText(sourceFile).replace(/\s+/g, ' ').trim()
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && RAW_COLUMN_NAMES.has(node.name.text)) {
      if (readsRawColumn(node.expression, node.name.text, checker, targets)) record(node)
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      RAW_COLUMN_NAMES.has(node.argumentExpression.text)
    ) {
      if (readsRawColumn(node.expression, node.argumentExpression.text, checker, targets)) record(node)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && RAW_COLUMN_NAMES.has(key.text)) {
        // The receiver a binding pattern destructures is whatever the pattern's type is; when the
        // initializer was cast (`const { index } = (change as any)`) the pattern types as `any`, so the
        // unwrapped initializer is offered as a second candidate.
        const pattern = node.parent
        const declaration = pattern.parent
        const patternExpr: ts.Expression | undefined =
          ts.isVariableDeclaration(declaration) && declaration.initializer
            ? declaration.initializer
            : undefined
        const patternType = checker.getTypeAtLocation(pattern)
        const hitByPattern = (() => {
          const nonNull = checker.getNonNullableType(patternType)
          for (const part of nonNull.isUnion() ? nonNull.types : [nonNull]) {
            const symbol = checker.getPropertyOfType(part, key.text)
            if (symbol && targets.has(symbol)) return true
          }
          return false
        })()
        if (hitByPattern || (patternExpr && readsRawColumn(patternExpr, key.text, checker, targets))) {
          record(node)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * Scan a set of renderer files for raw-column reads.
 *
 * Returns the offenders WITH the exact file set it walked (`scanned`), produced by the same predicate that
 * drives the walk. Coverage is then asserted against what was actually scanned, so a narrowed scan root
 * cannot pass by inspecting an innocent subset (记忆 gate-scan-root-can-be-wrong). The SSOT file is NOT
 * excluded here — it is a legitimate reader — so its own reads appear and can witness that the detector
 * fires; the main guard filters the SSOT out itself.
 */
function collectRawColumnReads(
  program: ts.Program,
  checker: ts.TypeChecker,
  targets: ReadonlySet<ts.Symbol>,
  isScanned: (fileName: string) => boolean
): { reads: RawColumnRead[]; scanned: Set<string> } {
  const reads: RawColumnRead[] = []
  const scanned = new Set<string>()
  for (const source of program.getSourceFiles()) {
    if (!isScanned(source.fileName)) continue
    scanned.add(source.fileName)
    reads.push(...rawColumnReadsIn(source, checker, targets))
  }
  return { reads, scanned }
}

/** Build an in-memory single-file program for the synthetic self-checks. `noLib` keeps it fast. */
function syntheticProgram(fileName: string, text: string): { program: ts.Program; checker: ts.TypeChecker } {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? file : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? text : undefined)
  }
  const program = ts.createProgram([fileName], { noLib: true, strict: true }, host)
  return { program, checker: program.getTypeChecker() }
}

/** Findings for a synthetic fixture: the raw-column read texts the extractor reported, deduped and sorted. */
function syntheticFindings(fileName: string, text: string): string[] {
  const { program, checker } = syntheticProgram(fileName, text)
  const targets = rawColumnSymbols(program, checker)
  const source = program.getSourceFile(fileName)!
  return [...new Set(rawColumnReadsIn(source, checker, targets).map((read) => read.text))].sort()
}

describe('git change classification is owned by git-porcelain-status.ts', () => {
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()
  const targets = rawColumnSymbols(program, checker)
  const isRenderer = (fileName: string): boolean =>
    fileName.startsWith(RENDERER_SRC) && isSourceFileName(fileName)

  it('self-check: the raw-column symbols resolve from GitFileChange — exactly two', () => {
    // Without this the scan matches nothing and both the known-positive check and the guard go silently
    // green. Pinning to two also makes renaming a column a deliberate, visible event here.
    expect(targets.size, 'GitFileChange.index / .worktree did not resolve — the whole scan is inert').toBe(2)
    const names = [...targets].map((symbol) => symbol.name).sort()
    expect(names).toEqual(['index', 'worktree'])
    // The symbols must belong to GitFileChange specifically. A GitFileChange value's `.index` read
    // resolves to one of them; this is the identity the guard turns on.
    const changeDecl = program
      .getSourceFile(CONTRACTS_FILE)!
      .statements.find(
        (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
          (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
          statement.name.text === 'GitFileChange'
      )
    expect(changeDecl, 'GitFileChange is not declared in contracts.ts — scan root or contract moved').toBeDefined()
  })

  it('self-check: the instrument fires on the known-positive reads inside the SSOT itself', () => {
    // The defense against a collector that returns [] (or scans nothing): if the extractor is inert, this
    // is empty and red, even though the guard below — which excludes the SSOT — would be vacuously green.
    // git-porcelain-status.ts is the ONE file that legitimately reads both columns; it must be found.
    const { reads } = collectRawColumnReads(program, checker, targets, isRenderer)
    const inSsot = reads.filter((read) => read.file === path.relative(RENDERER_SRC, SSOT_FILE))
    const columns = new Set(
      inSsot.flatMap((read) => [...RAW_COLUMN_NAMES].filter((name) => read.text.includes(name)))
    )
    expect(
      inSsot.length,
      'the extractor found no raw-column read in git-porcelain-status.ts — it is inert, so the guard ' +
        'below cannot fail. This is the "scans nothing → forever green" failure this check exists to catch.'
    ).toBeGreaterThanOrEqual(2)
    expect([...columns].sort(), 'both columns must be witnessed in the SSOT').toEqual(['index', 'worktree'])
  })

  it('self-check: the scan面 includes the real classification consumers, by name', () => {
    // A named-file coverage check, not a count floor. A count floor drifts as the renderer grows (either
    // false-reds or gets bumped and loses teeth); naming the files this guard exists to police is what
    // survives a refactor. If the scan root is narrowed to an innocent subset, these are absent and this
    // reds — which is what proves the guard cannot pass by inspecting nothing.
    const { scanned } = collectRawColumnReads(program, checker, targets, isRenderer)
    const relativeScanned = new Set([...scanned].map((file) => path.relative(RENDERER_SRC, file)))
    for (const consumer of [
      'lib/git-porcelain-status.ts', // the SSOT — reads the columns, must be seen for the check above
      'lib/file-tree-git-status.ts', // projects gitChangeClass onto the tree — a #746 victim
      'components/ChangesPanel.tsx' // calls gitChangeLabel — the other #746 victim
    ]) {
      expect(
        relativeScanned.has(consumer),
        `${consumer} is not in the scan面 — the guard is not looking where classification lives`
      ).toBe(true)
    }
    // And every renderer file that exists on disk must have been walked. The scan face is derived from the
    // TS program, so anything the program does not reach is invisible to this guard while it stays green —
    // today `include` is `src/**` with no `exclude`, so the two sets agree (measured: 231 = 231), but that
    // is a property of today's tsconfig, not of this test. Enumerating the directory independently is what
    // turns "the compiler happens to see everything" into an assertion, and it subsumes a count floor,
    // which would drift as the renderer grows and stop meaning anything once bumped.
    //
    // The tooth is narrower than "any tsconfig change reds here", and the measurement says so: TS pulls an
    // imported file into the program even when `exclude` names it, so excluding an imported module does NOT
    // shrink the scan face (verified — excluding lib/quick-switch.ts left all 6 green). Only a file the
    // program holds as a ROOT can actually leave, and the renderer has exactly two of those today
    // (components/EditorPane.tsx and main.tsx — everything else arrives through an import edge). Excluding
    // main.tsx does red this check, naming the escaped file. So this guards the reachable case and is
    // deliberately blind to the unreachable one, rather than claiming to cover both.
    const unscanned = rendererFilesOnDisk()
      .filter((file) => !scanned.has(file))
      .map((file) => path.relative(RENDERER_SRC, file))
      .sort()
    expect(
      unscanned,
      'renderer files exist on disk that the TS program never sees, so this guard is blind to them — ' +
        'check tsconfig.json include/exclude'
    ).toEqual([])
  })

  it('self-check: every bypass shape is flagged on a synthetic GitFileChange', () => {
    // The real tree only exhibits plain `change.index` today, so element access, destructuring and the
    // wrapper shapes are unwitnessed there (记忆 lib-export-reachability synthetic-witness). This fixture
    // is the witness that the extractor recognises each shape — delete any branch of rawColumnReadsIn and
    // the corresponding line drops out of this set.
    const findings = syntheticFindings(
      '/synthetic-git-change/consumer.ts',
      [
        'type GitFileChange = { path: string; index: string; worktree: string; staged: boolean }',
        'declare const change: GitFileChange',
        'declare const maybe: GitFileChange | null',
        'const a = change.index', // plain member
        "const b = change['worktree']", // element access, string-literal key
        'const c = maybe?.index', // optional chain on a nullable receiver
        'const { index } = change', // destructuring
        'const { worktree: w } = change', // renamed destructuring
        'const d = (change as any).index', // through a runtime-transparent cast
        'function helper(x: GitFileChange): string { return x.worktree }' // read inside a same-file helper
      ].join('\n')
    )
    // Asserted as the exact set, not "contains": a set comparison red-flags a missing shape AND a shape
    // that started matching something it should not, where `.some(includes)` would hide the former.
    expect(findings).toEqual(
      [
        'change.index',
        "change['worktree']",
        'maybe?.index',
        'index', // the `const { index } = change` binding element
        'worktree: w', // the renamed binding element
        '(change as any).index',
        'x.worktree'
      ].sort()
    )
  })

  it('self-check: innocent homonyms on other types are NOT flagged', () => {
    // The property this guard is worth having for: `.index` on anything that is not a GitFileChange must be
    // invisible. Symbol identity is what delivers it — `other.index` and a match-array `.index` resolve to
    // different symbols. If the criterion ever degrades to a name match, this set becomes non-empty and reds.
    const findings = syntheticFindings(
      '/synthetic-git-change/homonyms.ts',
      [
        'type GitFileChange = { path: string; index: string; worktree: string }',
        'type RegexMatch = { index: number; length: number }', // like RegExpMatchArray.index
        'type Marker = { index: number; id: string }', // like BrowserAnnotationMarker.index
        'declare const other: RegexMatch',
        'declare const marker: Marker',
        'const a = other.index', // different symbol → not flagged
        "const b = other['index']", // ditto via element access
        'const { index } = marker', // ditto via destructuring
        'const c = marker.index'
      ].join('\n')
    )
    expect(findings, 'a homonym `.index` on a non-GitFileChange type was flagged — the criterion degraded to a name match').toEqual([])
  })

  it('no renderer file other than git-porcelain-status.ts re-derives classification from the raw columns', () => {
    const { reads } = collectRawColumnReads(program, checker, targets, isRenderer)
    const offenders = reads
      .filter((read) => read.file !== path.relative(RENDERER_SRC, SSOT_FILE))
      .map((read) => `${read.file}:${read.line}  ${read.text}`)
      .sort()
    expect(
      offenders,
      'A renderer file reads GitFileChange.index / .worktree directly. Those two raw porcelain columns are ' +
        'owned by src/renderer/src/lib/git-porcelain-status.ts — a merge conflict is a property of the PAIR ' +
        '(the seven codes DD AU UD UA DU AA UU), and reading one column classifies four of them wrong (#746). ' +
        'Consume gitChangeClass / gitUnmergedCodeOf / gitChangeLabel instead.\n' +
        `Offending reads:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
