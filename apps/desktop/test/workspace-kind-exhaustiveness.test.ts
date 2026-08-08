import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// WHO is allowed to branch on `WorkspaceRecord.kind`, enforced structurally over all of desktop `src/`.
//
// `WorkspaceRecord['kind']` is a two-member union (`'folder' | 'worktree'`). Before the SSOT in
// `contracts.ts` (`WORKSPACE_KINDS` + `assertUnreachableWorkspaceKind` + `isFolderWorkspace` /
// `isWorktreeWorkspace`), ~7 consumers each compared it by hand — `kind === 'folder'`,
// `kind !== 'worktree'`, … — and nothing tied those tests to the union. `tsconfig` runs `strict` but
// NOT `noImplicitReturns`, so adding a third member compiled clean and every one of those comparisons
// silently kept its old branch.
//
// That silence is SHARPER for a two-member union than for the surface-kind union next door
// (`workbench-surface-kind-exhaustiveness.test.ts`, which this file is modelled on). There, a
// single-kind test (`is this a file?`) is correct to leave alone: a 6th kind rightly answers "no". Here
// a single-kind test IS the bug vector — `kind !== 'worktree'` literally means "is a folder", so a
// third kind is silently folded into whichever side the author happened to write. So this guard's
// enumerator threshold is ONE literal, not two: any consumer that compares the kind value to even a
// single kind literal must route through the SSOT. (`ENUMERATOR_MIN_LITERALS` below states this, with a
// witness in self-check 2 so it cannot drift silently.)
//
// It is deliberately NOT a filename list and NOT a regex over source text:
//   - A filename allowlist goes stale the instant a consumer is added in a file not on the list — the
//     exact failure mode this exists to prevent.
//   - A regex cannot tell `workspace.kind` (a WorkspaceRecord) from `surface.kind` (a WorkbenchSurface),
//     `session.kind` (a SessionSnapshot), `row.kind`, `item.kind`, or the dozens of other `.kind`
//     unions in this tree; all are identical text. Measured: a bare-text scan for `.kind` reads hits
//     30+ unrelated sites. It also cannot see that a `switch` routes its default through the anchor.
// So it drives the TypeScript type checker: a `.kind` read counts only where the checker says the
// object is assignable to `WorkspaceRecord`. Every homonym is excluded by TYPE, with no exemption list.
//
// WHAT THIS SEES (each shape has a witness in self-check 2, so breaking one reds here):
//   1. `workspace.kind`                          — property access
//   2. `workspace['kind']`                       — element access with a literal key
//   3. `const { kind } = workspace` / `f({ kind }: WorkspaceRecord)` — destructuring, incl. renamed
//   4. `f(k: WorkspaceRecord['kind'])`           — the helper split off with the value as a parameter
//   plus, for each, comparisons reached through a LOCAL ALIAS (`const k = workspace.kind`), `switch`
//   case labels, and membership tests (`KINDS.includes(kind)` / `.indexOf` / `.has`), where the
//   literals live in the receiver rather than beside the read.
//
// WHAT THIS DOES NOT SEE (stated so the next reader does not over-trust it — an unstated gap is a false
// promise): a kind value widened to `string` before comparison (the checker no longer calls the object
// a WorkspaceRecord), a kind value passed across a function boundary as a plain `string`, literals
// assembled at runtime, and a `Record<WorkspaceKind, …>` lookup. The Record case is intentional — an
// exhaustive Record is ALREADY a compile error when a member is missing, which is the outcome this
// guard produces. The others are open holes; when one appears, widen the origin list, do not add an
// exemption.
//
// Three self-checks keep it from going vacuously green (the local precedent: a scan whose root is wrong
// passes silently — #393/#645). (1) the union anchor resolves to exactly `folder`/`worktree`, read from
// the SSOT rather than typed here, AND the reader set is asserted non-empty so a mis-typed scan root
// reds instead of passing over nothing; (2) a synthetic in-memory program proves the classifier FLAGS an
// unanchored consumer of every shape above (including a single-literal one) and CLEARS an anchored one;
// (3) the set of files the scan WALKED equals desktop `src/`'s `.ts`/`.tsx` files on disk, enumerated
// independently, so a scan that narrows and polices less code fails rather than reporting success over a
// smaller surface.

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = path.join(DESKTOP_DIR, 'src')
const CONTRACTS_FILE = path.join(SRC_DIR, 'shared/contracts.ts')

/**
 * The SSOT symbol a `.kind`-READING consumer must route through: `assertUnreachableWorkspaceKind`, the
 * exhaustive-switch backstop.
 *
 * Deliberately NOT the predicates `isFolderWorkspace` / `isWorktreeWorkspace`. Those are the REPLACEMENT
 * for reading `.kind`, not a wrapper you put around a read — a consumer that calls a predicate does not
 * read `.kind` at all, so the classifier never sees it and anchoring is moot. If a consumer DOES read
 * `.kind` itself, the only exhaustiveness-safe form is an exhaustive `switch` whose `default` calls
 * `assertUnreachableWorkspaceKind`; a raw `kind === 'folder'` is always silent on a third member.
 *
 * Measured: with the predicates in this set, re-inlining `workspace.kind === 'folder'` in
 * `projectWorkspaces` — which also calls `isFolderWorkspace` at its OTHER site — left the whole function
 * "anchored" and the mutation survived. Narrowing the reader-anchor to the backstop alone kills it: a
 * function that reads `.kind` must have the exhaustive switch, not merely also-call a predicate somewhere.
 */
const ANCHOR_IDENTIFIERS = new Set(['assertUnreachableWorkspaceKind'])

/**
 * How many distinct kind literals make a consumer an *enumerator*. ONE, because the union has two
 * members: a single `kind === 'folder'` / `kind !== 'worktree'` test already decides the whole union and
 * so already mishandles a third member. Self-check 2 carries a single-literal witness and asserts it
 * through `isEnumerator`, so lowering this to a hand-counted comparison — or a future editor raising it
 * to 2 "to match the surface guard" — reds there rather than silently reopening the single-kind hole.
 */
const ENUMERATOR_MIN_LITERALS = 1

/**
 * Can a branching consumer live in this file? Declaration files hold types and no function bodies, so
 * the classifier has nothing to find in them.
 *
 * This is the SINGLE place that decision is made: the program's root walk uses it, the scan filters with
 * it, and self-check 3 builds its reference set with it. Written twice, the scan could quietly narrow
 * while the coverage check narrowed in agreement and kept reporting full coverage — the drift shape this
 * whole file exists to prevent.
 */
function carriesEnumerableCode(fileName: string): boolean {
  if (fileName.endsWith('.d.ts')) return false
  return fileName.endsWith('.ts') || fileName.endsWith('.tsx')
}

/** Program roots: every source file under `src/`, walked recursively. */
function sourceRoots(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceRoots(full))
      continue
    }
    if (carriesEnumerableCode(entry.name)) found.push(full)
  }
  return found
}

/**
 * The same files, enumerated INDEPENDENTLY of `sourceRoots`.
 *
 * The independence is the point. A coverage check whose expectation comes from the same walk it checks
 * cannot fail: narrow that walk and the reference set narrows identically, both sides agree, and the
 * assertion reports full coverage over less code. So this uses `readdirSync`'s own recursion; the one
 * thing the two enumerations share is `carriesEnumerableCode`, the single decision that IS meant to be
 * shared.
 */
function sourceFilesOnDisk(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && carriesEnumerableCode(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

type KindReader = {
  file: string
  fn: string
  /** Distinct kind string-literals this function compares the kind value against. */
  literals: Set<string>
  /**
   * True when the function demonstrably branches on the kind but the literals are not statically
   * readable here (`case workspace.kind:` against an unknown switch; a membership receiver we cannot
   * resolve). Treated as enumerating: the conservative direction is to demand an anchor rather than to
   * report "not a branch" about code we failed to read.
   */
  opaque: boolean
  /** True if the function references an SSOT anchor identifier (as a USE, not its own name). */
  anchored: boolean
  /** Which origin shapes produced this reader — reported in failures so the shape is visible. */
  origins: Set<string>
}

/** The single decision for "does this consumer branch on the kind?", shared by self-check and scan. */
function isEnumerator(reader: KindReader): boolean {
  return reader.literals.size >= ENUMERATOR_MIN_LITERALS || reader.opaque
}

function functionName(fn: ts.SignatureDeclaration): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText()
  const parent = fn.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  const line = fn.getSourceFile().getLineAndCharacterOfPosition(fn.getStart()).line + 1
  return `(anonymous @ ${path.basename(fn.getSourceFile().fileName)}:${line})`
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) return current
    current = current.parent
  }
  return null
}

/**
 * Resolve the `WorkspaceRecord` type from its declaration in `contracts.ts`. The type itself is the
 * anchor: the classifier compares each `.kind` read's object type against it, so the guard tracks the
 * real contract rather than a name.
 */
function resolveWorkspaceType(
  program: ts.Program,
  checker: ts.TypeChecker,
  declFile: string
): ts.Type | null {
  const source = program.getSourceFile(declFile)
  if (!source) return null
  let resolved: ts.Type | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'WorkspaceRecord') {
      resolved = checker.getTypeAtLocation(node.name)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return resolved
}

/**
 * The core classifier, reused for both the synthetic self-check and the real scan.
 *
 * Finds every place a WorkspaceRecord's `kind` VALUE is obtained — four origin shapes, see the header —
 * groups them by enclosing function, records which kind literals each is compared against (following
 * local aliases, switch labels and membership receivers) and whether it references an SSOT anchor.
 *
 * Returns `scanned` alongside the readers: the exact file set this run walked, emitted by the same
 * filter that drives the walk, so coverage is asserted against what was scanned rather than inferred
 * from which anchors happened to resolve.
 *
 * The SSOT file (`contracts.ts`) is excluded: it is where `.kind` is SUPPOSED to be read — the two
 * predicates and the type itself live there — so including it would report the definition as a violation
 * of itself.
 */
function collectKindReaders(
  program: ts.Program,
  checker: ts.TypeChecker,
  workspaceType: ts.Type,
  options: { rootDir: string; ssotFile: string | null; isScanned: (fileName: string) => boolean }
): { readers: KindReader[]; scanned: Set<string> } {
  const byFunction = new Map<ts.SignatureDeclaration, KindReader>()
  const scanned = new Set<string>()

  // The kind union comes from the SAME anchor as the record type, so the two can never disagree about
  // what "a kind" is. Deriving it from a separately-named alias would be a second hand-copy.
  const kindUnion = checker.getTypeOfPropertyOfType(workspaceType, 'kind') ?? null

  const readerFor = (fn: ts.SignatureDeclaration, source: ts.SourceFile): KindReader => {
    let reader = byFunction.get(fn)
    if (!reader) {
      reader = {
        file: path.relative(options.rootDir, source.fileName),
        fn: functionName(fn),
        literals: new Set<string>(),
        opaque: false,
        anchored: false,
        origins: new Set<string>()
      }
      byFunction.set(fn, reader)
    }
    return reader
  }

  /**
   * The string literals in an array receiver: `['folder'].includes(k)` or a const bound to one. `null`
   * means "there is a receiver but we cannot read it" → the caller marks the reader opaque rather than
   * concluding it does not branch.
   */
  const arrayLiterals = (node: ts.Node): string[] | null => {
    let current = node
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
      current = current.expression
    }
    if (ts.isArrayLiteralExpression(current)) {
      const out: string[] = []
      for (const element of current.elements) {
        if (!ts.isStringLiteralLike(element)) return null
        out.push(element.text)
      }
      return out
    }
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current)
      const declaration = symbol?.declarations?.[0]
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return arrayLiterals(declaration.initializer)
      }
      return null
    }
    return null
  }

  /** Literals visible AT a kind value: `k === 'folder'`, `switch (k)`, `KINDS.includes(k)`. */
  const recordLiteralsAt = (value: ts.Expression, reader: KindReader): void => {
    const parent = value.parent
    // `k === 'x'` / `!==` — the literal is the other operand.
    if (ts.isBinaryExpression(parent)) {
      const other = parent.left === value ? parent.right : parent.left
      if (ts.isStringLiteralLike(other)) reader.literals.add(other.text)
    }
    // `switch (k) { case 'x': … }` — each case label is a literal.
    if (ts.isSwitchStatement(parent) && parent.expression === value) {
      for (const clause of parent.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
          reader.literals.add(clause.expression.text)
        }
      }
    }
    // `case workspace.kind:` — an inverted switch. The literals are on the switch's own expression, so
    // nothing is readable here; branching on the kind is nonetheless what it does.
    if (ts.isCaseClause(parent) && parent.expression === value) reader.opaque = true
    // `KINDS.includes(k)` / `.indexOf(k)` / `set.has(k)` — literals live in the RECEIVER. Climb any
    // `as`/parens between the value and the call, or the argument identity check misses.
    let outer: ts.Expression = value
    while (
      outer.parent &&
      (ts.isAsExpression(outer.parent) || ts.isParenthesizedExpression(outer.parent))
    ) {
      outer = outer.parent
    }
    const call = outer.parent
    if (call && ts.isCallExpression(call) && call.arguments.includes(outer)) {
      const callee = call.expression
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : null
      if (method === 'includes' || method === 'indexOf' || method === 'has') {
        const found = arrayLiterals((callee as ts.PropertyAccessExpression).expression)
        if (found === null) reader.opaque = true
        else for (const literal of found) reader.literals.add(literal)
      }
    }
  }

  /**
   * Every reference to a bound name, so comparisons against an ALIAS are still collected.
   * `const { kind } = workspace` and `const k = workspace.kind` both put the comparisons on a local, not
   * on the read. Symbol identity (not text) is what makes this sound: a same-named local in a sibling
   * scope has a different symbol.
   */
  const recordLiteralsFromReferences = (
    declarationName: ts.Identifier,
    fn: ts.SignatureDeclaration,
    reader: KindReader
  ): void => {
    const declarationSymbol = checker.getSymbolAtLocation(declarationName)
    if (!declarationSymbol) return
    const walk = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== declarationName &&
        checker.getSymbolAtLocation(node) === declarationSymbol
      ) {
        recordLiteralsAt(node, reader)
      }
      ts.forEachChild(node, walk)
    }
    walk(fn)
  }

  /** `const k = <kind read>` — hand the alias's own references to the literal collector. */
  const followLocalAlias = (
    read: ts.Expression,
    fn: ts.SignatureDeclaration,
    reader: KindReader
  ): void => {
    const parent = read.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === read && ts.isIdentifier(parent.name)) {
      recordLiteralsFromReferences(parent.name, fn, reader)
    }
  }

  for (const source of program.getSourceFiles()) {
    if (options.ssotFile && source.fileName === options.ssotFile) continue
    if (!options.isScanned(source.fileName)) continue
    scanned.add(source.fileName)

    const visit = (node: ts.Node): void => {
      // ORIGIN 1: `workspace.kind`. Assignable-to-WorkspaceRecord is the discriminator no regex can
      // make: it separates a workspace read from a textually identical `surface.kind` / `session.kind`.
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'kind') {
        const objectType = checker.getTypeAtLocation(node.expression)
        if (checker.isTypeAssignableTo(objectType, workspaceType)) {
          const fn = enclosingFunction(node)
          if (fn) {
            const reader = readerFor(fn, source)
            reader.origins.add('property')
            recordLiteralsAt(node, reader)
            followLocalAlias(node, fn, reader)
          }
        }
      }

      // ORIGIN 2: `workspace['kind']`. Identical semantics, different syntax node.
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'kind'
      ) {
        const objectType = checker.getTypeAtLocation(node.expression)
        if (checker.isTypeAssignableTo(objectType, workspaceType)) {
          const fn = enclosingFunction(node)
          if (fn) {
            const reader = readerFor(fn, source)
            reader.origins.add('element')
            recordLiteralsAt(node, reader)
            followLocalAlias(node, fn, reader)
          }
        }
      }

      // ORIGIN 3: `const { kind } = workspace` and `function f({ kind }: WorkspaceRecord)`, including the
      // renamed form `{ kind: k }`. The type of the enclosing binding PATTERN identifies the object as a
      // workspace — there is no `.kind` node to type at all.
      if (ts.isBindingElement(node)) {
        const property = node.propertyName ?? node.name
        if (ts.isIdentifier(property) && property.text === 'kind' && ts.isIdentifier(node.name)) {
          const patternType = checker.getTypeAtLocation(node.parent)
          if (checker.isTypeAssignableTo(patternType, workspaceType)) {
            const fn = enclosingFunction(node)
            if (fn) {
              const reader = readerFor(fn, source)
              reader.origins.add('destructure')
              recordLiteralsFromReferences(node.name, fn, reader)
            }
          }
        }
      }

      // ORIGIN 4: the helper split off so it takes the VALUE — `f(k: WorkspaceRecord['kind'])`. Its body
      // never mentions a workspace, so origins 1–3 see nothing.
      //
      // Two conditions make this sound (each measured to matter in the surface-kind precedent):
      //   - `isUnion()`: excludes an `any` param. `any` is mutually assignable to EVERY type, so both
      //     assignability calls below say "yes" about it — but `any.isUnion()` is `false`.
      //   - BOTH assignability directions: a param typed as a strict SUBSET (e.g. just `'folder'`) is
      //     assignable TO the kind union but not FROM it. Requiring both separates "is the kind union"
      //     from "happens to fit inside it".
      if (kindUnion && ts.isParameter(node) && ts.isIdentifier(node.name)) {
        const parameterType = checker.getTypeAtLocation(node.name)
        const isTheKindUnion =
          parameterType.isUnion() &&
          checker.isTypeAssignableTo(parameterType, kindUnion) &&
          checker.isTypeAssignableTo(kindUnion, parameterType)
        if (isTheKindUnion) {
          const fn = node.parent
          if (
            ts.isFunctionDeclaration(fn) ||
            ts.isFunctionExpression(fn) ||
            ts.isArrowFunction(fn) ||
            ts.isMethodDeclaration(fn)
          ) {
            const reader = readerFor(fn, source)
            reader.origins.add('kind-param')
            recordLiteralsFromReferences(node.name, fn, reader)
          }
        }
      }

      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  // Second pass: does each branching function REFERENCE an SSOT anchor identifier?
  //
  // "Reference", not "mention": the identifier that NAMES the function is excluded. Without that
  // exclusion an SSOT predicate anchors itself — `isFolderWorkspace` is both an anchor name and its own
  // declaration name, so collapsing its exhaustive switch to `return false` would leave this guard green.
  // It is also a general bypass in the other direction: any unanchored consumer could clear the guard by
  // renaming itself to an anchor. A declaration name proves nothing about routing through the SSOT; only
  // a use does. (The predicates themselves live in `contracts.ts`, which the scan excludes anyway — but
  // the exclusion is kept because a consumer could legitimately be named like an anchor.)
  for (const [fn, reader] of byFunction) {
    const declarationNames = new Set<ts.Node>()
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
      declarationNames.add(fn.name)
    }
    if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
      declarationNames.add(fn.parent.name)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && ANCHOR_IDENTIFIERS.has(node.text) && !declarationNames.has(node)) {
        reader.anchored = true
      }
      ts.forEachChild(node, visit)
    }
    visit(fn)
  }

  return { readers: [...byFunction.values()], scanned }
}

/** Build a program from an in-memory source, for the falsifiability self-check. */
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

describe('who branches on WorkspaceRecord.kind is exhaustiveness-checked', () => {
  const roots = sourceRoots(SRC_DIR)
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(roots, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()
  const workspaceType = resolveWorkspaceType(program, checker, CONTRACTS_FILE)

  it('self-check 1: the anchor resolves to exactly folder/worktree and the classifier matches real reads', () => {
    expect(workspaceType, 'WorkspaceRecord must resolve from contracts.ts').not.toBeNull()
    const kindUnion = checker.getTypeOfPropertyOfType(workspaceType!, 'kind')
    expect(kindUnion, 'the kind union must resolve from the WorkspaceRecord anchor').toBeDefined()
    const members = kindUnion!.isUnion() ? kindUnion!.types : [kindUnion!]
    expect(
      members.map((t: ts.Type) => (t.isStringLiteral() ? t.value : '?')).sort()
    ).toEqual(['folder', 'worktree'])

    // The #393/#645 vacuity trap, made concrete for THIS guard. After the refactor every production
    // consumer routes through the predicates, so the real scan (which excludes contracts.ts) correctly
    // finds ZERO direct `.kind` readers — that IS the success state, so a non-empty count of production
    // consumers is the wrong witness. The real risk is that `workspaceType` resolved to some type the
    // real program's `isTypeAssignableTo` never matches (a dist-vs-src identity split, say): then a
    // future inlined comparison would ALSO never match and the main assertion would pass over nothing.
    //
    // The witness that rules that out: the SSOT predicates in contracts.ts DO read `workspace.kind`
    // directly. Scan WITHOUT excluding contracts.ts and the classifier must find them — proof that
    // origin-1 assignability fires against the real program's WorkspaceRecord, not just the synthetic one
    // in self-check 2. If this ever finds nothing, the type match is broken and the whole guard is blind.
    const { readers } = collectKindReaders(program, checker, workspaceType!, {
      rootDir: SRC_DIR,
      ssotFile: null,
      isScanned: carriesEnumerableCode
    })
    const names = new Set(readers.filter(isEnumerator).map((r) => `${r.file}::${r.fn}`))
    expect(
      names.has('shared/contracts.ts::isFolderWorkspace'),
      'origin-1 assignability must match a real WorkspaceRecord.kind read'
    ).toBe(true)
    expect(names.has('shared/contracts.ts::isWorktreeWorkspace')).toBe(true)
  })

  it('self-check 2: the classifier flags an unanchored consumer of every shape, single-literal included', () => {
    const syntheticName = '/synthetic-workspace-guard/probe.ts'
    const syntheticSource = [
      "type WorkspaceRecord = { kind: 'folder' | 'worktree'; path: string }",
      // `noLib` means the array methods the membership shape needs must be declared here.
      'interface Array<T> { includes(value: T): boolean; indexOf(value: T): number }',
      'interface ReadonlyArray<T> { includes(value: T): boolean }',
      // A SUBSET union: assignable TO the kind union but not FROM it. A one-directional origin-4 test
      // would flag this as "the kind union" and police an unrelated helper.
      "type FolderOnly = 'folder'",
      // SINGLE-LITERAL: the shape that is safe to ignore for a many-armed union but IS the bug vector
      // here. It must be flagged; lowering the threshold's witness lives here.
      'function singleLiteralTest(workspace: WorkspaceRecord): boolean {',
      "  return workspace.kind === 'folder'",
      '}',
      // BYPASS 1: destructured out of the workspace — there is no `.kind` node to type.
      'function bypassDestructure(workspace: WorkspaceRecord): number {',
      '  const { kind } = workspace',
      "  if (kind === 'folder') return 1",
      '  return 0',
      '}',
      // BYPASS 2: destructured and RENAMED in the parameter list.
      'function bypassRenamedParam({ kind: k }: WorkspaceRecord): number {',
      "  if (k === 'worktree') return 1",
      '  return 0',
      '}',
      // BYPASS 3: computed element access.
      'function bypassComputedKey(workspace: WorkspaceRecord): number {',
      "  if (workspace['kind'] === 'folder') return 1",
      '  return 0',
      '}',
      // BYPASS 4: the helper split off so it takes the kind VALUE; its body never mentions a workspace.
      "function bypassKindParam(kind: WorkspaceRecord['kind']): number {",
      "  if (kind === 'worktree') return 1",
      '  return 0',
      '}',
      // BYPASS 5: membership — the literals live in the receiver, not beside the read.
      'function bypassMembership(workspace: WorkspaceRecord): boolean {',
      "  return ['folder'].includes(workspace.kind)",
      '}',
      // BYPASS 6: a local alias, with the comparison hanging off the alias.
      'function bypassLocalAlias(workspace: WorkspaceRecord): number {',
      '  const k = workspace.kind',
      "  if (k === 'folder') return 1",
      '  return 0',
      '}',
      // The real anchor: the exhaustive-switch backstop. Its declaration reads `.kind` and routes
      // through no OTHER anchor, so it doubles as the self-anchoring witness — a function may not clear
      // the guard by carrying the anchor's own NAME. (In production it takes `never`; here it reads a
      // real `.kind` so the classifier sees it as a reader.)
      'function assertUnreachableWorkspaceKind(workspace: WorkspaceRecord): boolean {',
      "  if (workspace.kind === 'folder') return true",
      '  return false',
      '}',
      // The good citizen: exhaustive switch routed through the SSOT backstop.
      'function anchoredEnumerator(workspace: WorkspaceRecord): number {',
      '  switch (workspace.kind) {',
      "    case 'folder': return 1",
      "    case 'worktree': return 2",
      '    default: return assertUnreachableWorkspaceKind(workspace) as unknown as number',
      '  }',
      '}',
      // MUST NOT be flagged: a helper over a strict SUBSET that merely fits inside the kind union.
      'function unrelatedSubsetHelper(kind: FolderOnly): number {',
      "  if (kind === 'folder') return 1",
      '  return 0',
      '}',
      // MUST NOT be flagged: an `any` param IS mutually assignable to every type; only isUnion() excludes it.
      'function anyParamHelper(value: any): number {',
      "  if (value === 'folder') return 1",
      '  return 0',
      '}'
    ].join('\n')
    const { program: sp, checker: sc } = syntheticProgram(syntheticName, syntheticSource)
    const syntheticWorkspace = resolveWorkspaceType(sp, sc, syntheticName)
    expect(syntheticWorkspace).not.toBeNull()

    const { readers } = collectKindReaders(sp, sc, syntheticWorkspace!, {
      rootDir: '/synthetic-workspace-guard',
      ssotFile: null,
      isScanned: () => true
    })
    const byName = new Map(readers.map((r) => [r.fn, r]))

    const mustBeFlagged = [
      'singleLiteralTest',
      'bypassDestructure',
      'bypassRenamedParam',
      'bypassComputedKey',
      'bypassKindParam',
      'bypassMembership',
      'bypassLocalAlias'
    ]
    for (const name of mustBeFlagged) {
      const reader = byName.get(name)
      expect(reader, `classifier is blind to the ${name} shape`).toBeDefined()
      expect(isEnumerator(reader!), `${name} must classify as an enumerator`).toBe(true)
      expect(reader!.anchored, `${name} routes through no SSOT anchor`).toBe(false)
    }

    // The single-literal witness sits exactly on the threshold: raising ENUMERATOR_MIN_LITERALS to 2
    // (e.g. "to match the surface guard") reds here rather than silently reopening the single-kind hole.
    expect(byName.get('singleLiteralTest')!.literals.size).toBe(1)

    const anchored = byName.get('anchoredEnumerator')
    expect(anchored, 'classifier must see the anchored enumerator').toBeDefined()
    expect(isEnumerator(anchored!)).toBe(true)
    expect(anchored!.anchored).toBe(true)

    // The self-anchoring bypass: a function may not clear the guard by carrying the anchor's own NAME.
    // `assertUnreachableWorkspaceKind`'s declaration reads `.kind` and references only its own name, so
    // it must classify as an unanchored enumerator — the declaration name is excluded from the anchor
    // test, otherwise any consumer could clear the guard by renaming itself.
    const selfNamed = byName.get('assertUnreachableWorkspaceKind')
    expect(selfNamed, 'classifier must see the anchor-named enumerator').toBeDefined()
    expect(isEnumerator(selfNamed!)).toBe(true)
    expect(selfNamed!.anchored, 'a declaration name must not satisfy the anchor test').toBe(false)

    // Precision: neither false-positive shape may be flagged.
    expect(
      byName.has('unrelatedSubsetHelper'),
      'a helper over a strict SUBSET must not be mistaken for the kind union'
    ).toBe(false)
    expect(
      byName.has('anyParamHelper'),
      'an `any` parameter passes both assignability directions; only isUnion() excludes it'
    ).toBe(false)
  })

  it('self-check 3: the scan reached every desktop src source, not just the roots handed in', () => {
    const { scanned } = collectKindReaders(program, checker, workspaceType!, {
      rootDir: SRC_DIR,
      ssotFile: CONTRACTS_FILE,
      isScanned: carriesEnumerableCode
    })
    const onDisk = sourceFilesOnDisk().filter((file) => file !== CONTRACTS_FILE)
    expect(onDisk.length, 'src must not be empty — a wrong root would read as full coverage')
      .toBeGreaterThan(50)
    const unscanned = onDisk.filter((file) => !scanned.has(file)).map((f) => path.relative(SRC_DIR, f))
    expect(
      unscanned.sort(),
      'these src sources were never scanned, so no consumer in them can ever be caught. A directory ' +
        'dropped from the walk stays in the program via imports, so nothing else here would have gone red.'
    ).toEqual([])
  })

  it('every consumer that branches on WorkspaceRecord.kind routes through the exhaustiveness SSOT', () => {
    const { readers } = collectKindReaders(program, checker, workspaceType!, {
      rootDir: SRC_DIR,
      ssotFile: CONTRACTS_FILE,
      isScanned: carriesEnumerableCode
    })

    const enumerators = readers.filter(isEnumerator)
    const unanchored = enumerators
      .filter((r) => !r.anchored)
      .map(
        (r) =>
          `${r.file}::${r.fn} branches on {${[...r.literals].sort().join(', ')}}` +
          `${r.opaque ? ' (+ unreadable branch)' : ''} via ${[...r.origins].sort().join('+')}`
      )
      .sort()

    expect(
      unanchored,
      'A consumer branches on WorkspaceRecord.kind without routing through the exhaustiveness SSOT ' +
        '(assertUnreachableWorkspaceKind / isFolderWorkspace / isWorktreeWorkspace). Because the union ' +
        'has two members, even a single `kind === \'folder\'` test silently mishandles a third kind: ' +
        'replace it with the predicate, so a new kind fails to compile in contracts.ts instead of being ' +
        'silently swept into one side. See src/shared/contracts.ts.'
    ).toEqual([])
  })
})
