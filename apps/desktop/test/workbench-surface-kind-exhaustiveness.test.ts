import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// WHO is allowed to read `surface.kind`, enforced structurally.
//
// `WorkbenchSurface` is a 5-arm discriminated union. Before #491, ~5 consumers each hand-copied their
// own list of surface kinds — a switch here, a `kind === 'agent' || kind === 'terminal'` there, a
// `!== 'file' && !== 'browser'` somewhere else — and nothing tied them to the union. `tsconfig` runs
// `strict` but NOT `noImplicitReturns`, so a consumer that forgot a kind compiled clean and silently
// did the wrong thing for the new kind (a pane leaked, was dropped across restart, or vanished from a
// menu).
//
// It is deliberately NOT a filename list and NOT a regex over source text:
//   - A filename allowlist goes stale the instant a consumer is added in a file not on the list — the
//     exact failure mode this is meant to prevent.
//   - A regex cannot tell `surface.kind` (a WorkbenchSurface) from `session.kind` (a SessionSnapshot)
//     or `issue.kind` (a document-issue union); both spellings are identical text. It also cannot see
//     that a `switch` routes its default through `assertUnreachableSurface`.
// So it drives the TypeScript type checker: it finds every place a surface's `kind` VALUE is obtained,
// groups them by enclosing function, and requires every function that BRANCHES on 2+ distinct kind
// literals to be anchored to the SSOT — it must reference `assertUnreachableSurface` (the exhaustive-
// switch backstop) or `isSessionSurface` (the SSOT predicate for the agent-or-terminal membership
// test). A function that tests a single kind (`is this a file?`) is not enumerating: a 6th kind
// correctly answers "no", so those are left alone.
//
// WHAT THIS SEES (each shape has a witness in self-check 2, so breaking one reds here):
//   1. `surface.kind`                          — property access
//   2. `surface['kind']`                       — element access with a literal key
//   3. `const { kind } = surface` / `f({ kind }: WorkbenchSurface)` — destructuring, incl. renamed
//   4. `f(k: WorkbenchSurface['kind'])`        — the helper split off with the value as a parameter
//   plus, for each of those, comparisons reached through a LOCAL ALIAS (`const k = surface.kind`),
//   `switch` case labels, and membership tests (`KINDS.includes(kind)` / `.indexOf` / `.has`), where
//   the literals live in the receiver rather than next to the read.
// Shapes 2–4 and membership were each measured to bypass the earlier property-access-only classifier.
//
// WHAT THIS DOES NOT SEE (stated so the next reader does not over-trust it): a kind value passed
// across a function boundary as a plain `string`, literals assembled at runtime, and a
// `Record<SurfaceKind, …>` lookup. The Record case is deliberate — an exhaustive Record is already a
// compile error when a kind is missing, which is the outcome this guard exists to produce. The others
// are open holes; when one shows up, widen the origin list, do not add an exemption.
//
// The guard carries three self-checks so it cannot go vacuously green (the local precedent: a scan
// whose root is wrong passes silently). (1) the union anchor must resolve to exactly the 5 members;
// (2) a synthetic in-memory program proves the classifier FLAGS an unanchored enumerator of every
// shape above and CLEARS an anchored one — if the checker wiring broke, this fails instead of passing
// empty; (3) the set of files the scan actually WALKED must equal the renderer's `.ts`/`.tsx` files on
// disk, enumerated independently — so a scan that narrows and polices less code fails rather than
// reporting the same success over a smaller surface.

// The scan root is the WHOLE renderer, not just `lib/`.
//
// It was `lib/` at first, and that was a live hole rather than a conservative start: measured at the
// commit that introduced this guard, `components/WorkspaceWorkbench.tsx` held two unanchored
// enumerators and `store.ts` held four inlined `kind === 'agent' || kind === 'terminal'` copies — the
// exact hand-copied membership test `isSessionSurface` exists to replace, in the teardown and
// ownership paths. A guard whose root excludes the files most likely to enumerate is not a narrower
// guard; it is one that reports success about code it never opened.
const RENDERER_DIR = fileURLToPath(new URL('../src/renderer/src', import.meta.url))
const LIB_DIR = path.join(RENDERER_DIR, 'lib')
const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * Which files are handed to `ts.createProgram` as ROOTS.
 *
 * `skipDirectories` is a compile-time economy, not a coverage decision, and measurement is what settles
 * the difference: a directory dropped from this walk is still pulled into the program through the import
 * graph, so the checker still types it and the scan still visits it. (Adding `components` here left
 * self-check 3 green with zero unscanned files.) Coverage is decided by the scan's own filter, which
 * self-check 3 checks against an independently-built reference set.
 */
function rendererSources(dir: string, skipDirectories: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue
      found.push(...rendererSources(full, skipDirectories))
      continue
    }
    // `.d.ts` files still belong in the PROGRAM (they declare globals the renderer's types need), so
    // this walk takes them; `carriesEnumerableCode` is what keeps them out of the scanned set.
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
  }
  return found
}

// `assets` and `styles` hold no TypeScript, so handing them in as program roots costs compile time for
// nothing. That claim is not taken on faith: `rendererFilesOnDisk` enumerates the renderer with no skip
// list at all, so a `.ts` file appearing under a skipped directory that the import graph does not reach
// either shows up in self-check 3 as unscanned rather than being silently unpoliced.
const ROOT_SKIP_DIRECTORIES = new Set(['assets', 'styles'])

/**
 * Can an enumerating consumer live in this file? Declaration files hold types and no function bodies,
 * so the classifier has nothing to find in them.
 *
 * This is the SINGLE place that decision is made: the scan filters source files with it, and
 * self-check 3 builds its reference set with it. Written twice, the scan could quietly narrow while
 * the coverage check narrowed in agreement and kept reporting full coverage — the drift shape this
 * whole file exists to prevent. Declaration files stay in the program (they declare the globals the
 * renderer's types depend on); they are only excluded from what must be SCANNED.
 */
function carriesEnumerableCode(fileName: string): boolean {
  if (fileName.endsWith('.d.ts')) return false
  return fileName.endsWith('.ts') || fileName.endsWith('.tsx')
}

/**
 * The renderer's scannable files, enumerated INDEPENDENTLY of `rendererSources`.
 *
 * The independence is deliberate. A coverage check whose expectation is computed by the same walk it
 * checks cannot fail: narrow that walk and the reference set narrows identically, both sides agree, and
 * the assertion reports full coverage over less code. Measured on the way here — with the reference set
 * built from `rendererSources`, adding `components` to its skip list left every test green.
 *
 * (For the record, that green was NOT a missed regression: the program still gets `components/` through
 * the import graph, so `scanned` still contained those files and coverage really was intact. The walk's
 * skip list turns out to affect compile time, not reach. But a check that would have stayed green
 * whether or not coverage was lost is worthless, which is why the reference set moved off that walk.)
 *
 * So this uses `readdirSync`'s own recursion with no skip list and no shared walk: the one thing the two
 * enumerations share is `carriesEnumerableCode`, the single decision that IS meant to be shared. The
 * criterion that has teeth is the scan's own filter — narrow THAT (see the mutation note on self-check
 * 3) and this set diverges from `scanned`, naming every file that stopped being policed.
 */
function rendererFilesOnDisk(): string[] {
  return readdirSync(RENDERER_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && carriesEnumerableCode(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

// The SSOT symbols an enumerating consumer must route through. `assertUnreachableSurface` is the
// exhaustive-switch backstop; `isSessionSurface` is the SSOT predicate that replaces every inlined
// `kind === 'agent' || kind === 'terminal'`. Referencing either is proof of exhaustiveness enrollment.
const ANCHOR_IDENTIFIERS = new Set(['assertUnreachableSurface', 'isSessionSurface'])

/**
 * How many distinct kind literals make a consumer an *enumerator* rather than a single-kind test.
 *
 * Two, not three: `kind === 'agent' || kind === 'terminal'` is the exact hand-copied membership test
 * `isSessionSurface` exists to replace, and it has exactly two. Every 2-literal consumer in the tree
 * today happens to be anchored, so raising this to 3 would not fail any real file — which is why
 * self-check 2 carries a 2-literal witness and asserts it through `isEnumerator`, not through a
 * hand-counted comparison. Without that the threshold has no witness and can drift silently.
 */
const ENUMERATOR_MIN_LITERALS = 2

type SurfaceKindReader = {
  file: string
  fn: string
  /** Distinct kind string-literals this function compares the kind value against. */
  literals: Set<string>
  /**
   * True when the function demonstrably branches on the kind but the literals are not statically
   * readable here (`case surface.kind:` against an unknown switch; a membership receiver we cannot
   * resolve). Treated as enumerating: the conservative direction is to demand an anchor, because the
   * alternative is reporting "not an enumerator" about code we failed to read.
   */
  opaque: boolean
  /** True if the function references an SSOT anchor identifier. */
  anchored: boolean
  /** Which origin shapes produced this reader — reported in failures so the shape is visible. */
  origins: Set<string>
}

/** The single decision for "does this consumer enumerate?", shared by the self-check and the scan. */
function isEnumerator(reader: SurfaceKindReader): boolean {
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
 * Resolve the `WorkbenchSurface` type from its declaration in `workbench-tabs.ts`. The union itself is
 * the anchor: the classifier compares each kind read's object type against it, so a kind added to the
 * union widens what this test polices automatically.
 */
function resolveSurfaceType(
  program: ts.Program,
  checker: ts.TypeChecker,
  declFile: string
): ts.Type | null {
  const source = program.getSourceFile(declFile)
  if (!source) return null
  let resolved: ts.Type | null = null
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'WorkbenchSurface') {
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
 * Finds every place a surface's `kind` VALUE is obtained — four origin shapes, see the header — groups
 * them by enclosing function, records which kind literals each is compared against (following local
 * aliases, switch labels and membership receivers) and whether it references an SSOT anchor.
 *
 * Returns `scanned` alongside the readers: the exact file set this run walked, emitted by the same
 * filter that drives the walk. Coverage is then asserted against what was scanned rather than inferred
 * from which anchors happened to resolve — see `assertScanCoversTheRenderer`.
 */
function collectSurfaceKindReaders(
  program: ts.Program,
  checker: ts.TypeChecker,
  surfaceType: ts.Type,
  rootDir: string
): { readers: SurfaceKindReader[]; scanned: Set<string> } {
  const byFunction = new Map<ts.SignatureDeclaration, SurfaceKindReader>()
  const scanned = new Set<string>()

  // The kind union comes from the SAME anchor as the surface type, so the two can never disagree about
  // what "a kind" is. Deriving it from a separately-named alias would be a second hand-copy.
  const kindUnion = checker.getTypeOfPropertyOfType(surfaceType, 'kind') ?? null

  const readerFor = (fn: ts.SignatureDeclaration, source: ts.SourceFile): SurfaceKindReader => {
    let reader = byFunction.get(fn)
    if (!reader) {
      reader = {
        file: path.relative(rootDir, source.fileName),
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
   * The string literals in an array receiver: `['a','b'].includes(k)` or a const bound to one.
   * `null` means "there is a receiver but we cannot read it" → the caller marks the reader opaque
   * rather than concluding it does not enumerate.
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

  /** Literals visible AT a kind value: `k === 'a'`, `switch (k)`, `KINDS.includes(k)`. */
  const recordLiteralsAt = (value: ts.Expression, reader: SurfaceKindReader): void => {
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
    // `case surface.kind:` — an inverted switch. The literals are on the switch's own expression, not
    // here, so nothing is readable at this node; branching on the kind is nonetheless what it does.
    if (ts.isCaseClause(parent) && parent.expression === value) reader.opaque = true
    // `KINDS.includes(k)` / `.indexOf(k)` / `set.has(k)` — the literals live in the RECEIVER. Climb any
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
   *
   * `const { kind } = surface` and `const k = surface.kind` both put the comparisons on a local, not on
   * the read — measured as two separate live bypasses of a classifier that only looked next to the
   * read. Symbol identity (not text) is what makes this sound: a same-named local in a sibling scope
   * has a different symbol.
   */
  const recordLiteralsFromReferences = (
    declarationName: ts.Identifier,
    fn: ts.SignatureDeclaration,
    reader: SurfaceKindReader
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
    reader: SurfaceKindReader
  ): void => {
    const parent = read.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === read && ts.isIdentifier(parent.name)) {
      recordLiteralsFromReferences(parent.name, fn, reader)
    }
  }

  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(rootDir)) continue
    if (!carriesEnumerableCode(source.fileName)) continue
    scanned.add(source.fileName)

    const visit = (node: ts.Node): void => {
      // ORIGIN 1: `surface.kind`. Assignable-to-WorkbenchSurface is the discriminator no regex can
      // make: it separates a surface read from a textually identical `session.kind` / `issue.kind`.
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'kind') {
        const objectType = checker.getTypeAtLocation(node.expression)
        if (checker.isTypeAssignableTo(objectType, surfaceType)) {
          const fn = enclosingFunction(node)
          if (fn) {
            const reader = readerFor(fn, source)
            reader.origins.add('property')
            recordLiteralsAt(node, reader)
            followLocalAlias(node, fn, reader)
          }
        }
      }

      // ORIGIN 2: `surface['kind']`. Identical semantics, different syntax node — a classifier keyed on
      // `isPropertyAccessExpression` alone is blind to it.
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'kind'
      ) {
        const objectType = checker.getTypeAtLocation(node.expression)
        if (checker.isTypeAssignableTo(objectType, surfaceType)) {
          const fn = enclosingFunction(node)
          if (fn) {
            const reader = readerFor(fn, source)
            reader.origins.add('element')
            recordLiteralsAt(node, reader)
            followLocalAlias(node, fn, reader)
          }
        }
      }

      // ORIGIN 3: `const { kind } = surface` and `function f({ kind }: WorkbenchSurface)`, including the
      // renamed form `{ kind: k }`. The type of the enclosing binding PATTERN is what identifies the
      // object as a surface — there is no `.kind` node to type at all.
      if (ts.isBindingElement(node)) {
        const property = node.propertyName ?? node.name
        if (ts.isIdentifier(property) && property.text === 'kind' && ts.isIdentifier(node.name)) {
          const patternType = checker.getTypeAtLocation(node.parent)
          if (checker.isTypeAssignableTo(patternType, surfaceType)) {
            const fn = enclosingFunction(node)
            if (fn) {
              const reader = readerFor(fn, source)
              reader.origins.add('destructure')
              recordLiteralsFromReferences(node.name, fn, reader)
            }
          }
        }
      }

      // ORIGIN 4: the helper split off so it takes the VALUE — `f(k: WorkbenchSurface['kind'])`. Its
      // body never mentions a surface, so origins 1–3 see nothing; splitting a switch into such a
      // helper was a measured bypass.
      //
      // Two conditions make this sound, and each is load-bearing on its own (measured — each removed
      // separately turns self-check 2 red):
      //   - `isUnion()`: it is what excludes an `any` param. `any` is mutually assignable to EVERY
      //     type, so the two assignability calls below say "yes" about it — but `any.isUnion()` is
      //     already `false` (measured directly: a param typed `any` gives isAny=true isUnion=false; a
      //     param typed `'a'|'b'` gives isAny=false isUnion=true). An earlier revision ALSO carried an
      //     explicit `!isAny` conjunct and its comment credited that conjunct with keeping 17 `any`
      //     params out. That was wrong: with `isUnion()` present the conjunct could never change the
      //     result, and deleting it left every test green. It is gone rather than test-covered,
      //     because a condition that cannot change the outcome is dead code, not an untested feature.
      //   - BOTH assignability directions: a param typed as a strict SUBSET (e.g. `SessionSnapshot`'s
      //     `'agent' | 'terminal'`) is assignable TO the kind union but not FROM it. Requiring both
      //     directions is what separates "is the kind union" from "happens to fit inside it".
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

  // Second pass: does each enumerating function REFERENCE an SSOT anchor identifier?
  //
  // "Reference", not "mention": the identifier that NAMES the function is excluded. Without that
  // exclusion the SSOT predicate anchors itself — `isSessionSurface` is both an anchor name and its own
  // declaration name, so collapsing its exhaustive switch to `default: return false` left this guard
  // green (measured: the mutation survived at 7/7 before this exclusion existed). It is also a general
  // bypass in the other direction: any unanchored enumerator could clear the guard by renaming itself
  // to an anchor. A declaration name proves nothing about routing through the SSOT; only a use does.
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

function buildDesktopProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const roots = rendererSources(RENDERER_DIR, ROOT_SKIP_DIRECTORIES)
  const configPath = path.join(DESKTOP_DIR, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(roots, parsed.options)
  return { program, checker: program.getTypeChecker() }
}

describe('who reads WorkbenchSurface.kind is exhaustiveness-checked', () => {
  const { program, checker } = buildDesktopProgram()
  const declFile = path.join(LIB_DIR, 'workbench-tabs.ts')
  const surfaceType = resolveSurfaceType(program, checker, declFile)

  it('self-check 1: the WorkbenchSurface union anchor resolves to its five members', () => {
    // Without this the whole guard could pass by resolving `null`/`any` and matching nothing. Pinning
    // the member count also means a 6th arm added to the union is a deliberate, visible event here.
    expect(surfaceType).not.toBeNull()
    const members = surfaceType!.isUnion() ? surfaceType!.types : [surfaceType!]
    const kinds = new Set<string>()
    for (const member of members) {
      const kindProp = member.getProperty('kind')
      if (!kindProp) continue
      const kindType = checker.getTypeOfSymbolAtLocation(kindProp, program.getSourceFile(declFile)!)
      if (kindType.isStringLiteral()) kinds.add(kindType.value)
    }
    expect([...kinds].sort()).toEqual(['agent', 'browser', 'file', 'launcher', 'terminal'])

    // The kind union the classifier's ORIGIN-4 test compares against must be the same five, derived
    // from this same anchor. If this route ever returns undefined, origin 4 silently stops looking —
    // the classifier would keep passing while one whole bypass reopened.
    const kindUnion = checker.getTypeOfPropertyOfType(surfaceType!, 'kind')
    expect(kindUnion, 'the kind union must resolve from the surface anchor').toBeDefined()
    const unionMembers = kindUnion!.isUnion() ? kindUnion!.types : [kindUnion!]
    expect(
      unionMembers.map((t) => (t.isStringLiteral() ? t.value : '?')).sort()
    ).toEqual(['agent', 'browser', 'file', 'launcher', 'terminal'])
  })

  it('self-check 2: the classifier flags an unanchored enumerator of every origin shape', () => {
    // A synthetic in-memory program with a known-bad consumer per origin shape, plus a known-good one.
    // If the checker wiring, the assignability test, or any origin's literal extraction regressed, this
    // fails LOUDLY here rather than letting the real scan below pass with an empty result set (the
    // vacuous-green failure mode). Each `bypass*` function is a shape that was MEASURED to slip past
    // the earlier property-access-only classifier.
    const syntheticName = '/synthetic-surface-guard/probe.ts'
    const syntheticSource = [
      'type WorkbenchSurface =',
      "  | { kind: 'a'; x: number }",
      "  | { kind: 'b'; y: number }",
      "  | { kind: 'c'; z: number }",
      // `noLib` means the array methods the membership shape needs must be declared here.
      'interface Array<T> { includes(value: T): boolean; indexOf(value: T): number }',
      'interface ReadonlyArray<T> { includes(value: T): boolean }',
      // A SUBSET union: assignable TO the kind union but not FROM it. A one-directional origin-4 test
      // would flag this as "the kind union" and police an unrelated helper.
      "type SessionKind = 'a' | 'b'",
      'declare function assertUnreachableSurface(surface: never): never',
      // The plain shape the original classifier already caught.
      'function unanchoredEnumerator(surface: WorkbenchSurface): number {',
      "  if (surface.kind === 'a') return surface.x",
      "  if (surface.kind === 'b') return surface.y",
      '  return 0',
      '}',
      // BYPASS 1: destructured out of the surface — there is no `.kind` node to type.
      'function bypassDestructure(surface: WorkbenchSurface): number {',
      '  const { kind } = surface',
      "  if (kind === 'a') return 1",
      "  if (kind === 'b') return 2",
      '  return 0',
      '}',
      // BYPASS 2: destructured and RENAMED in the parameter list.
      "function bypassRenamedParam({ kind: k }: WorkbenchSurface): number {",
      "  if (k === 'a') return 1",
      "  if (k === 'b') return 2",
      '  return 0',
      '}',
      // BYPASS 3: computed element access.
      'function bypassComputedKey(surface: WorkbenchSurface): number {',
      "  if (surface['kind'] === 'a') return 1",
      "  if (surface['kind'] === 'b') return 2",
      '  return 0',
      '}',
      // BYPASS 4: the helper split off so it takes the kind VALUE; its body never mentions a surface.
      "function bypassKindParam(kind: WorkbenchSurface['kind']): number {",
      "  if (kind === 'a') return 1",
      "  if (kind === 'b') return 2",
      '  return 0',
      '}',
      // BYPASS 5: membership — the literals live in the receiver, not beside the read.
      'function bypassMembership(surface: WorkbenchSurface): boolean {',
      "  return ['a', 'b'].includes(surface.kind)",
      '}',
      // BYPASS 6: a local alias, with the comparisons hanging off the alias.
      'function bypassLocalAlias(surface: WorkbenchSurface): number {',
      '  const k = surface.kind',
      "  if (k === 'a') return 1",
      "  if (k === 'b') return 2",
      '  return 0',
      '}',
      // The good citizen: exhaustive switch routed through the SSOT backstop.
      'function anchoredEnumerator(surface: WorkbenchSurface): number {',
      '  switch (surface.kind) {',
      "    case 'a': return surface.x",
      "    case 'b': return surface.y",
      "    case 'c': return surface.z",
      '    default: return assertUnreachableSurface(surface)',
      '  }',
      '}',
      // Named like an anchor, routes through nothing. Proves the anchor test reads USES, not the
      // declaration name — the bypass that let the real SSOT predicate anchor itself.
      'function isSessionSurface(surface: WorkbenchSurface): boolean {',
      "  if (surface.kind === 'a') return true",
      "  if (surface.kind === 'b') return true",
      '  return false',
      '}',
      // MUST NOT be flagged: a single-kind test. A 6th kind correctly answers "no".
      'function singleKindTest(surface: WorkbenchSurface): boolean {',
      "  return surface.kind === 'a'",
      '}',
      // MUST NOT be flagged: enumerates a DIFFERENT union that merely fits inside the kind union.
      'function unrelatedSubsetHelper(kind: SessionKind): number {',
      "  if (kind === 'a') return 1",
      "  if (kind === 'b') return 2",
      '  return 0',
      '}',
      // MUST NOT be flagged: an `any` param IS mutually assignable to every type, so both
      // assignability calls in origin 4 answer "yes" about it. `isUnion()` is the single condition
      // that keeps it out (`any.isUnion()` is false). This witness is what makes that claim testable:
      // widen origin 4 to accept a non-union and 17 unrelated `any`-param helpers come back with it.
      'function anyParamHelper(value: any): number {',
      "  if (value === 'a') return 1",
      "  if (value === 'b') return 2",
      '  return 0',
      '}'
    ].join('\n')
    const syntheticFile = ts.createSourceFile(
      syntheticName,
      syntheticSource,
      ts.ScriptTarget.ES2022,
      true
    )
    const host: ts.CompilerHost = {
      getSourceFile: (name) => (name === syntheticName ? syntheticFile : undefined),
      writeFile: () => {},
      getDefaultLibFileName: () => 'lib.d.ts',
      getCurrentDirectory: () => '/',
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => f === syntheticName,
      readFile: (f) => (f === syntheticName ? syntheticSource : undefined)
    }
    const syntheticProgram = ts.createProgram([syntheticName], { noLib: true, strict: true }, host)
    const syntheticChecker = syntheticProgram.getTypeChecker()
    const syntheticSurface = resolveSurfaceType(syntheticProgram, syntheticChecker, syntheticName)
    expect(syntheticSurface).not.toBeNull()

    const { readers } = collectSurfaceKindReaders(
      syntheticProgram,
      syntheticChecker,
      syntheticSurface!,
      '/synthetic-surface-guard'
    )
    const byName = new Map(readers.map((r) => [r.fn, r]))

    // Every bypass shape must be SEEN and classified as an enumerator, and none is anchored — i.e.
    // each is exactly what the real assertion below rejects. Asserting through `isEnumerator` (not a
    // hand-counted `>= 2`) is what gives ENUMERATOR_MIN_LITERALS a witness: these all have exactly
    // two literals, so raising the threshold to 3 fails here.
    const mustBeFlagged = [
      'unanchoredEnumerator',
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
    // Exactly two literals each — so the threshold above is genuinely exercised at its boundary rather
    // than being satisfied incidentally by a 3-literal fixture.
    for (const name of mustBeFlagged) {
      if (name === 'bypassMembership') continue // membership contributes its receiver's literals
      expect(byName.get(name)!.literals.size, `${name} must sit exactly on the threshold`).toBe(2)
    }

    const anchored = byName.get('anchoredEnumerator')
    expect(anchored, 'classifier must see the anchored enumerator').toBeDefined()
    expect(isEnumerator(anchored!)).toBe(true)
    expect(anchored!.anchored).toBe(true)

    // The self-anchoring bypass: a function may not clear the guard by carrying an anchor's NAME.
    // Measured before this held: collapsing the real `isSessionSurface` to `default: return false` kept
    // both #491 suites green, because `forEachChild` visited the function's own `name` identifier.
    const selfNamed = byName.get('isSessionSurface')
    expect(selfNamed, 'classifier must see the anchor-named enumerator').toBeDefined()
    expect(isEnumerator(selfNamed!)).toBe(true)
    expect(selfNamed!.anchored, 'a declaration name must not satisfy the anchor test').toBe(false)

    // The other direction — precision. Flagging these would make the guard a nuisance that gets
    // weakened, so each false-positive shape is pinned as NOT an enumerator.
    const single = byName.get('singleKindTest')
    expect(single, 'classifier must still see a single-kind test').toBeDefined()
    expect(isEnumerator(single!), 'a single-kind test is not enumerating').toBe(false)

    expect(
      byName.has('unrelatedSubsetHelper'),
      'a helper over a strict SUBSET union must not be mistaken for the kind union'
    ).toBe(false)
    expect(
      byName.has('anyParamHelper'),
      'an `any` parameter passes both assignability directions; only isUnion() excludes it'
    ).toBe(false)
  })

  it('self-check 3: the scan reached every renderer source, not just the ones handed in as roots', () => {
    // What this proves, precisely: the set of files the classifier WALKED equals the set of renderer
    // `.ts`/`.tsx` files on disk. It is a coverage assertion about the scan itself, not an inference
    // from which anchors happened to resolve.
    //
    // That distinction is the whole point, and it was measured. An earlier revision asserted coverage by
    // naming known enumerators in both `lib/` and `components/` and claimed that made "a scan that
    // silently loses a directory a failure rather than a pass". It could not: dropping `components/`
    // from the walk left every test green (measured twice — once with the reference set still derived
    // from that same walk, once with it derived independently), because a directory removed as a program
    // ROOT is still pulled into the program through the import graph. The checker still types those
    // files, `rootDir`-prefix filtering still admits them, and every named anchor still resolves —
    // anchor names cannot observe the walk at all. Only the walked set can.
    //
    // The reference set comes from `rendererFilesOnDisk`, which walks the tree independently of the
    // `rendererSources` walk that feeds the program — see its docstring for why sharing that walk made
    // this assertion unable to fail. `ROOT_SKIP_DIRECTORIES` is therefore not taken on faith either: a
    // `.ts` file appearing under `assets`/`styles` shows up here as unscanned.
    const { scanned } = collectSurfaceKindReaders(program, checker, surfaceType!, RENDERER_DIR)
    const onDisk = rendererFilesOnDisk()
    expect(onDisk.length, 'the renderer must not be empty — a wrong root would read as full coverage')
      .toBeGreaterThan(20)
    const unscanned = onDisk.filter((file) => !scanned.has(file)).map((f) => path.relative(RENDERER_DIR, f))
    expect(
      unscanned.sort(),
      'these renderer sources were never scanned, so no enumerator in them can ever be caught. ' +
        'A directory dropped from the walk stays in the program via imports, so nothing else here ' +
        'would have gone red.'
    ).toEqual([])
  })

  it('every consumer that branches on 2+ surface kinds routes through the exhaustiveness SSOT', () => {
    const { readers } = collectSurfaceKindReaders(program, checker, surfaceType!, RENDERER_DIR)

    // The scan must have actually found the known enumerators. A checker that resolved nothing yields an
    // empty list, which would make the assertion below pass for the wrong reason. (Directory coverage is
    // NOT what these anchors prove — see self-check 3, which owns that question.)
    const enumerators = readers.filter(isEnumerator)
    const enumeratorNames = new Set(enumerators.map((r) => `${r.file}::${r.fn}`))
    expect(enumeratorNames.has('lib/surface-memory-budget-candidates.ts::candidateForSurface')).toBe(true)
    expect(enumeratorNames.has('lib/workbench-persistence.ts::persistedSurfaceSurvives')).toBe(true)
    expect(enumeratorNames.has('components/WorkspaceWorkbench.tsx::tabSurfaceFallback')).toBe(true)
    expect(enumerators.length).toBeGreaterThanOrEqual(6)

    // The actual guard: no enumerating consumer may lack an SSOT anchor.
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
      'A consumer branches on multiple WorkbenchSurface kinds without routing through the ' +
        'exhaustiveness SSOT (assertUnreachableSurface / isSessionSurface). Add a `default: return ' +
        'assertUnreachableSurface(surface)` to its switch, or use `isSessionSurface` for the ' +
        'agent-or-terminal test, so a new surface kind fails to compile here instead of being ' +
        'silently mishandled. See src/renderer/src/lib/workbench-surface-kinds.ts.'
    ).toEqual([])
  })
})
