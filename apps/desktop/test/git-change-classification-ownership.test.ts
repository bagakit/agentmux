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
// ─── WHY THE CRITERION IS THE TYPE CHECKER, NOT A PROPERTY-NAME BLOCKLIST ───
//
// A name blocklist on `index` / `worktree` is useless here, and measurably so: `.index` is one of the
// most overloaded reads in the renderer. Measured on the real tree (2026-09-07, `grep` over
// `src/renderer/src`), a bare name match for `.index` would fire on FOUR unrelated families:
//   · `match.index`     — a `RegExpMatchArray`, in THREE files (TerminalView.tsx, lib/terminal-path-link.ts,
//                         lib/terminal-kitty-keyboard.ts)
//   · `mark.index`      — a conversation-axis mark (ConversationAxis.tsx, lib/conversation-axis.ts)
//   · `readout.index` / `readoutAt.index` / `at.index`
//                       — a `RulerReadout`, itself a UNION (ActivityView.tsx, lib/activity-ruler.ts)
//   · `reference.index` / `only.index`
//                       — a markdown file reference (lib/markdown-file-reference.ts)
// none of which is a `GitFileChange`. An exemption list for them is a second hand-copied scope that decays
// on every new file (记忆 forbidden-list-guard-always-leaks). `.worktree`, by contrast, has NO homonym: it
// occurs only in the SSOT.
//
// So this drives the TypeScript type checker. The receiver's type is split into its union constituents and
// each is asked `getPropertyOfType(constituent, key)`; the resulting property counts when EITHER tier
// below says it is one of the two raw porcelain columns. `match.index` resolves to `RegExpMatchArray.index`
// and satisfies neither tier, so it never enters the finding set. That the homonyms are silently correct is
// the whole reason this guard is worth having; it is asserted below, both on the real tree (self-check
// "scan面") and synthetically ("innocent homonyms").
//
//   TIER 1 — DECLARATION IDENTITY. The property's `declarations` include a node that `GitFileChange`'s own
//     `index` / `worktree` declares. NOT symbol identity: **mapped types synthesize fresh property symbols**,
//     so `Pick<GitFileChange, 'index' | 'worktree' | 'staged'>` declares different SYMBOLS while keeping the
//     same DECLARATION NODE. Measured (2026-09-07, TS 5.9.3) for a `.index` read on each receiver:
//         receiver                                     sameSymbol   sameDeclarationNode
//         GitFileChange                                true         true
//         Pick<GitFileChange, …>                       false        true
//         Partial<GitFileChange>                       false        true
//         Readonly<GitFileChange>                      false        true
//         Omit<GitFileChange, 'path'>                  false        true
//         GitFileChange & { extra: number }            true         true
//     Declaration identity therefore strictly subsumes symbol identity and adds the four mapped types. This
//     matters because the guard SHIPPED on symbol identity (bec7884) and a `Pick<>` helper carrying the exact
//     #746 single-column bug measured 6 passed (6) with `tsc` silent too — and `Pick<>` is the IDIOMATIC way
//     to narrow such a helper, not an evasion, so it is what a well-meaning contributor reaches for (#776).
//
//   TIER 2 — STRUCTURAL PROJECTION. The constituent carries BOTH raw columns AND `GitFileChange` is
//     assignable to it. This is the residual tier-1 cannot reach: a HAND-WRITTEN alias
//     (`{ index: string; worktree: string; staged: boolean }`) shares no declaration node with the contract,
//     yet a `GitFileChange` flows into it silently. Measured on the same fixture, `sameDeclarationNode` is
//     `false` for that alias and `isTypeAssignableTo(GitFileChange, alias)` is `true`. The two tiers are
//     genuinely independent — the intersection type is caught ONLY by tier 1 (assignability is `false`, since
//     a `GitFileChange` lacks `extra`), the alias ONLY by tier 2 — so neither is redundant, and each has a
//     self-check below that reds when its own tier is removed.
//     Requiring BOTH columns is what keeps tier 2 from firing on innocent types: it is the classification
//     decision that is owned here, and that decision is a property of the PAIR. `RegExpMatchArray` and
//     `RulerReadout` have an `index` and no `worktree`, so they fail before assignability is ever consulted.
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
//   · narrowed parameter    `function f(c: Pick<GitFileChange, 'index' | 'worktree'>) { return c.index }`
//     and the `Partial` / `Readonly` / `Omit` / intersection members of the same family — tier 1
//   · hand-written alias    `function f(c: { index: string; worktree: string }) { return c.index }` — tier 2
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
//     for the homonyms. This is the same conservative direction the needs-you guard takes. `Record<string,
//     unknown>` and `any` were measured to have NO resolvable `index` property at all, so they leave via
//     this door rather than via a tier.
//   · Tier 2 requires BOTH columns on the same constituent, so a helper taking ONE column
//     (`function f(c: { index: string })`) is invisible to it. That is deliberate and not a hole in the
//     thing being owned: one column alone cannot re-derive the classification, because the classification
//     is a property of the pair — a single-column reader is either consuming an already-classified value or
//     is a homonym. Tier 1 still catches `Pick<GitFileChange, 'index'>`, since the declaration node
//     survives, so only a hand-written single-column alias escapes, and that shape cannot express #746.
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
/**
 * Where a cross-process contract is allowed to live — the directory, not one file inside it.
 *
 * The property this guard needs is "`GitFileChange` is declared once, in the shared contract surface both
 * processes read" — never "it is declared in contracts.ts". Pinning the filename made a pure move red
 * (measured: splitting the git contracts into shared/git-contracts.ts failed this check while every
 * behavioural assertion stayed green), and the cheapest repair for that red is to relax the assertion,
 * which reopens the hole. What must stay nailed down is that the declaration is not in a renderer file,
 * a main-process file, or a test fixture — any of those would mean one side owns the other's vocabulary.
 */
const SHARED_DIR = path.join(SRC_DIR, 'shared')
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
 * What a raw-column read is matched against: the contract type itself, plus the declaration nodes of its
 * two raw-column properties.
 *
 * Read from the declaration rather than typed out so the guard cannot drift from the contract: if a field is
 * renamed, its declaration set comes back empty and the self-check that pins the set to exactly two members
 * fails loudly, instead of the guard silently policing a name that no longer exists.
 *
 * The declaration is found by scanning every program source for the `GitFileChange` alias/interface, not by
 * filename: in another program (the synthetic self-checks) it lives in the fixture itself.
 */
interface RawColumnTargets {
  /** The `GitFileChange` type, for tier 2's assignability question. Null when the contract did not resolve. */
  readonly changeType: ts.Type | null
  /** Declaration nodes of `GitFileChange`'s own `index` / `worktree`, for tier 1. */
  readonly declarations: ReadonlySet<ts.Declaration>
}

function rawColumnTargets(program: ts.Program, checker: ts.TypeChecker): RawColumnTargets {
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
  const declarations = new Set<ts.Declaration>()
  if (changeType) {
    for (const name of RAW_COLUMN_NAMES) {
      const symbol = checker.getPropertyOfType(changeType, name)
      for (const declaration of symbol?.declarations ?? []) declarations.add(declaration)
    }
  }
  return { changeType, declarations }
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
 * Is reading `key` off this ONE type constituent a read of a raw porcelain column? Both tiers, per the file
 * header. Exported so a self-check can drive each tier directly rather than only through the AST walk.
 */
export function constituentReadsRawColumn(
  constituent: ts.Type,
  key: string,
  checker: ts.TypeChecker,
  targets: RawColumnTargets
): boolean {
  const property = checker.getPropertyOfType(constituent, key)
  if (!property) return false
  // TIER 1 — declaration identity. Survives Pick / Omit / Partial / Readonly / intersections, which all
  // synthesize a fresh symbol around the SAME declaration node (measured; see header).
  if ((property.declarations ?? []).some((declaration) => targets.declarations.has(declaration))) return true
  // TIER 2 — structural projection. A hand-written alias shares no declaration with the contract, so tier 1
  // cannot see it; it is a raw-column reader iff it carries BOTH columns and a GitFileChange flows into it.
  if (!targets.changeType) return false
  for (const name of RAW_COLUMN_NAMES) {
    if (!checker.getPropertyOfType(constituent, name)) return false
  }
  return checker.isTypeAssignableTo(targets.changeType, constituent)
}

/**
 * Does reading `key` off `receiver` resolve to one of `GitFileChange`'s raw columns?
 *
 * The receiver's type is taken both as written and after {@link unwrap} (a cast changes the type but not
 * the runtime read), each is made non-nullable (`change?.index`) and split into union constituents
 * (`GitFileChange | Other`), and every constituent is put to {@link constituentReadsRawColumn}. That
 * two-tier question is the single thing that tells `change.index` from `match.index`, and why no exemption
 * list appears in this file.
 */
function readsRawColumn(
  receiver: ts.Expression,
  key: string,
  checker: ts.TypeChecker,
  targets: RawColumnTargets
): boolean {
  const candidates = new Set<ts.Type>([checker.getTypeAtLocation(receiver)])
  const inner = unwrap(receiver)
  if (inner !== receiver) candidates.add(checker.getTypeAtLocation(inner))
  for (const candidate of candidates) {
    const nonNull = checker.getNonNullableType(candidate)
    for (const part of nonNull.isUnion() ? nonNull.types : [nonNull]) {
      if (constituentReadsRawColumn(part, key, checker, targets)) return true
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
  targets: RawColumnTargets
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
            if (constituentReadsRawColumn(part, key.text, checker, targets)) return true
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
  targets: RawColumnTargets,
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

/**
 * Build an in-memory single-file program for the synthetic self-checks, **with the real default lib**.
 *
 * The lib matters and its absence is not a performance trade — it is a correctness trap that cost this file
 * a wrong answer. A hand-rolled host that returns `undefined` for the lib cannot resolve `Pick`, `Partial`,
 * `Readonly` or `Omit`; a fixture using any of them then has NO PROPERTY at all, and every tier answers
 * "not a raw-column read" for a reason that has nothing to do with the criterion under test. Measured while
 * investigating #776: the first probe reported `Pick<GitFileChange, …>` as unflagged, which read as a real
 * blind spot and was purely a missing-lib artifact. `syntheticDiagnostics` is returned so a check can assert
 * the fixture actually compiled before believing any row of its findings.
 */
function syntheticProgram(
  fileName: string,
  text: string
): { program: ts.Program; checker: ts.TypeChecker; diagnostics: readonly ts.Diagnostic[] } {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true)
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, noEmit: true }
  const libFile = ts.getDefaultLibFilePath(options)
  const host: ts.CompilerHost = {
    getSourceFile: (name, languageVersion) => {
      if (name === fileName) return file
      const contents = ts.sys.readFile(name)
      return contents === undefined ? undefined : ts.createSourceFile(name, contents, languageVersion, true)
    },
    writeFile: () => {},
    getDefaultLibFileName: () => libFile,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName || ts.sys.fileExists(name),
    readFile: (name) => (name === fileName ? text : ts.sys.readFile(name))
  }
  const program = ts.createProgram([fileName], options, host)
  return {
    program,
    checker: program.getTypeChecker(),
    diagnostics: ts.getPreEmitDiagnostics(program, program.getSourceFile(fileName))
  }
}

/** Findings for a synthetic fixture: the raw-column read texts the extractor reported, deduped and sorted. */
function syntheticFindings(fileName: string, text: string): string[] {
  const { program, checker, diagnostics } = syntheticProgram(fileName, text)
  // A fixture that does not compile answers a different question than the one asked (see syntheticProgram).
  expect(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
    `synthetic fixture ${fileName} does not compile — its findings say nothing about the criterion`
  ).toEqual([])
  const targets = rawColumnTargets(program, checker)
  const source = program.getSourceFile(fileName)!
  return [...new Set(rawColumnReadsIn(source, checker, targets).map((read) => read.text))].sort()
}

describe('git change classification is owned by git-porcelain-status.ts', () => {
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()
  const targets = rawColumnTargets(program, checker)
  const isRenderer = (fileName: string): boolean =>
    fileName.startsWith(RENDERER_SRC) && isSourceFileName(fileName)

  it('self-check: the raw-column declarations resolve from GitFileChange — exactly two', () => {
    // Without this the scan matches nothing and both the known-positive check and the guard go silently
    // green. Pinning to two also makes renaming a column a deliberate, visible event here.
    expect(
      targets.declarations.size,
      'GitFileChange.index / .worktree did not resolve — the whole scan is inert'
    ).toBe(2)
    expect(targets.changeType, 'the GitFileChange type itself did not resolve — tier 2 is inert').not.toBeNull()
    const names = [...targets.declarations]
      .map((declaration) => (ts.isPropertySignature(declaration) ? declaration.name.getText() : '?'))
      .sort()
    expect(names).toEqual(['index', 'worktree'])
    // The declarations must belong to GitFileChange specifically, declared in the shared contract surface.
    const changeDecls = program
      .getSourceFiles()
      .filter((source) => source.fileName.startsWith(SHARED_DIR + path.sep))
      .flatMap((source) =>
        source.statements.filter(
          (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
            (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
            statement.name.text === 'GitFileChange'
        )
      )
    expect(
      changeDecls.length,
      'GitFileChange is not declared exactly once under src/shared — scan root moved, or the contract ' +
        'was duplicated so the two processes can drift'
    ).toBe(1)
    for (const declaration of targets.declarations) {
      expect(
        declaration.getSourceFile().fileName,
        'a raw-column declaration came from outside the shared contract surface'
      ).toBe(changeDecls[0].getSourceFile().fileName)
    }
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

  it('self-check: a narrowed parameter type does not hide the read (#776 — tier 1, mapped types)', () => {
    // #776 measured this file's original criterion — symbol identity — and found it defeated by the most
    // idiomatic way to write such a helper: narrow the parameter with `Pick<>`. Each mapped type synthesizes a
    // FRESH property symbol, so `c.index` off a `Pick<GitFileChange, …>` never matched the contract's symbol,
    // and the exact #746 bug (single-column classification) came back clean and `tsc`-approved. That is worse
    // than an evasion — it is what a careful contributor would write.
    //
    // The four mapped types are checked together because they are one mechanism: measured on TS 5.9.3, all four
    // reuse the SAME declaration node, which is precisely why tier 1 catches them and symbol identity did not.
    // The `& { note }` case is here for the opposite reason: an intersection is NOT assignable-from
    // GitFileChange (the extra member makes it a supertype requirement), so tier 2 alone would miss it while
    // tier 1 sees it. Neither tier is redundant, and this fixture is where that stops being an argument.
    // Each narrowing gets its OWN receiver name, and that is load-bearing rather than cosmetic. The first
    // draft named every parameter `c`, so the deduped finding set was `['c.index', 'c.worktree']` no matter
    // WHICH narrowing produced it — `Readonly<GitFileChange>` alone supplies both strings, so removing tier 1
    // entirely still left this check 8 passed (8). Measured, not reasoned: that mutation is what exposed it
    // (记忆 presence-assertion-blind-when-shape-repeats — when a fixture repeats a shape, count or name each
    // occurrence instead of asserting the set). Distinct names make the expected set name all five families.
    const findings = syntheticFindings(
      '/synthetic-git-change/narrowed.ts',
      [
        'type GitFileChange = { path: string; index: string; worktree: string; staged: boolean }',
        // The #746 bug shape: reads a single column to classify. Exactly the defect the ownership rule exists
        // to prevent, wearing the type that used to make it invisible.
        "function viaPick(pick: Pick<GitFileChange, 'index' | 'worktree' | 'staged'>) { return pick.staged ? pick.index : pick.worktree }",
        'function viaPartial(partial: Partial<GitFileChange>) { return partial.index }',
        'function viaReadonly(ro: Readonly<GitFileChange>) { return ro.worktree }',
        "function viaOmit(omit: Omit<GitFileChange, 'path'>) { return omit.index }",
        'function viaIntersection(inter: GitFileChange & { note: string }) { return inter.worktree }',
        // The one shape ONLY declaration identity catches. Measured: fresh symbol (so symbol identity is
        // blind), same declaration node (so tier 1 sees it), both columns present but NOT assignable-from
        // GitFileChange because `extra` is required (so tier 2 is blind too). Without this arm, regressing
        // tier 1 all the way back to the shipped bec7884 symbol-identity criterion left this suite 8 passed
        // (8) — tier 2 happens to cover every plain mapped type, so nothing discriminated the two criteria.
        "function viaNarrowedPlus(mix: Pick<GitFileChange, 'index' | 'worktree'> & { extra: number }) { return mix.index }",
        'declare const change: GitFileChange',
        'export const used = [viaPick(change), viaPartial(change), viaReadonly(change), viaOmit(change), viaIntersection({ ...change, note: "" }), viaNarrowedPlus({ ...change, extra: 1 })]'
      ].join('\n')
    )
    expect(
      findings,
      'a raw-column read behind a narrowed parameter type was not flagged — the criterion regressed to ' +
        'symbol identity, which #776 measured as green on exactly this fixture'
      // `pick.staged` is deliberately absent: `staged` is a derived boolean, not one of the two raw porcelain
      // columns, and reading it is legitimate everywhere. Only `index`/`worktree` carry the pair-valued fact
      // this file owns. (Measured, not reasoned — the first draft listed it and red on exactly this point.)
    ).toEqual(
      [
        'pick.index',
        'pick.worktree', // Pick
        'partial.index', // Partial
        'ro.worktree', // Readonly
        'omit.index', // Omit
        'inter.worktree', // intersection over the contract itself
        'mix.index' // mapped-type-inside-intersection — TIER 1 ONLY (see the comment above)
      ].sort()
    )
  })

  it('self-check: a hand-written structural alias does not hide the read (#776 — tier 2)', () => {
    // The other half of #776, and the reason declaration identity alone is not enough: a hand-written
    // `{ index; worktree; staged }` shares NO declaration node with the contract, so tier 1 is blind to it.
    // Tier 2 answers it structurally — both columns present AND GitFileChange assignable into it — which is
    // also why it stays silent on the homonyms in the check below: a `RegexMatch` carries `index` but not
    // `worktree`, so the both-columns requirement is what keeps tier 2 from becoming a name match with extra
    // steps. Requiring both columns is a declared, deliberate blind spot for a single-column alias: one column
    // cannot re-derive a classification that is a property of the pair.
    const findings = syntheticFindings(
      '/synthetic-git-change/alias.ts',
      [
        'type GitFileChange = { path: string; index: string; worktree: string; staged: boolean }',
        'type Columns = { index: string; worktree: string; staged: boolean }',
        'function viaAlias(cols: Columns) { return cols.staged ? cols.index : cols.worktree }',
        // Both columns, but nothing GitFileChange can flow into (`extra` is required) → not a projection of
        // the contract, so deliberately NOT flagged. Without this arm the fixture would not distinguish
        // "structural projection of GitFileChange" from "any type that happens to have two matching names".
        'type Unrelated = { index: string; worktree: string; extra: number }',
        'declare const unrelated: Unrelated',
        'const ignored = unrelated.index',
        'declare const change: GitFileChange',
        'export const used = [viaAlias(change), ignored]'
      ].join('\n')
    )
    expect(
      findings,
      'a raw-column read behind a hand-written structural alias was not flagged — declaration identity ' +
        'alone cannot see it, so tier 2 must'
      // `cols.staged` absent for the same reason as the tier-1 fixture: not a raw porcelain column. The
      // receiver is named `cols`, not `c`, so this check cannot be satisfied by the tier-1 fixture's strings.
    ).toEqual(['cols.index', 'cols.worktree'])
  })

  it('self-check: innocent homonyms on other types are NOT flagged', () => {
    // The property this guard is worth having for: `.index` on anything that is not a GitFileChange must be
    // invisible. The type checker is what delivers it — no exemption list appears anywhere in this file, which
    // is the thing a name blocklist can never claim (记忆 forbidden-list-guard-always-leaks). The renderer's
    // real homonyms are `match.index` (3 files), `mark.index`, `readout.index`/`at.index` and
    // `reference.index`/`only.index`; each is modelled below by shape, since what makes them invisible is
    // their type, not their identifier.
    //
    // Tier 2 is the one that could plausibly leak here, and the fixture is built to catch it: every homonym
    // carries `index` WITHOUT `worktree`, so the both-columns requirement is under load. If that requirement
    // is dropped, `RegexMatch` and friends become "assignable-from GitFileChange"-adjacent and this reds.
    const findings = syntheticFindings(
      '/synthetic-git-change/homonyms.ts',
      [
        'type GitFileChange = { path: string; index: string; worktree: string }',
        'type RegexMatch = { index: number; length: number }', // like RegExpMatchArray.index — 3 renderer files
        'type Marker = { index: number; id: string }', // like a conversation-axis mark
        'type Readout = { index: number; label: string }', // like an activity-ruler readout
        // The one homonym that puts tier 2's both-columns requirement under real load, and it took two
        // measurements to get right. The three above carry `index: number`, so GitFileChange is not
        // assignable to them at all and they are rejected for a reason with nothing to do with the
        // criterion — dropping the both-columns loop left this suite fully green while they were the only
        // homonyms here. The witness has to be a genuine SUPERTYPE of GitFileChange: `index: string`, and
        // no property GitFileChange lacks (a stray `label: string` re-blocks assignability and restores
        // the false green — measured). Then the column count is the only thing left standing between this
        // and a false positive.
        'type PathCursor = { index: string; path: string }',
        'declare const other: RegexMatch',
        'declare const marker: Marker',
        'declare const readout: Readout',
        'declare const cursor: PathCursor',
        'const a = other.index', // not a GitFileChange → not flagged
        "const b = other['index']", // ditto via element access
        'const { index } = marker', // ditto via destructuring
        'const c = marker.index',
        'const d = readout.index',
        'const e = cursor.index',
        'export const used = [a, b, index, c, d, e]'
      ].join('\n')
    )
    expect(
      findings,
      'a homonym `.index` on a non-GitFileChange type was flagged — the criterion degraded to a name match'
    ).toEqual([])
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
