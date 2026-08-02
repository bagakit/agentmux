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
// menu). This test is the backstop that a *new* enumerating consumer cannot land without an
// exhaustiveness mechanism.
//
// It is deliberately NOT a filename list and NOT a regex over source text:
//   - A filename allowlist goes stale the instant a consumer is added in a file not on the list — the
//     exact failure mode this is meant to prevent.
//   - A regex cannot tell `surface.kind` (a WorkbenchSurface) from `session.kind` (a SessionSnapshot)
//     or `issue.kind` (a document-issue union); both spellings are identical text. It also cannot see
//     that a `switch` routes its default through `assertUnreachableSurface`.
// So it drives the TypeScript type checker: it resolves the *type* of every `x.kind` read, keeps only
// those whose object is assignable to `WorkbenchSurface`, groups them by enclosing function, and
// requires every function that BRANCHES on 2+ distinct kind literals to be anchored to the SSOT — it
// must reference `assertUnreachableSurface` (the exhaustive-switch backstop) or `isSessionSurface`
// (the SSOT predicate for the agent-or-terminal membership test). A function that tests a single kind
// (`is this a file?`) is not enumerating: a 6th kind correctly answers "no", so those are left alone.
//
// The guard carries three self-checks so it cannot go vacuously green (the local precedent: a scan
// whose root is wrong passes silently). (1) the union anchor must resolve to exactly the 5 members;
// (2) a synthetic in-memory program proves the classifier actually FLAGS an unanchored enumerator and
// CLEARS an anchored one — if the checker wiring broke, this fails instead of passing empty; (3) the
// real scan must have found the known enumerators, so a mis-rooted scan (zero functions) is a failure.

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

/** Every TypeScript source under the renderer, so the program the checker sees is the whole surface. */
function rendererSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    // `assets` and `styles` hold no TypeScript; skipping them keeps the program from growing for
    // nothing. This is not an exemption list for code — every directory that CAN enumerate is walked.
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'styles') continue
      found.push(...rendererSources(full))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
  }
  return found
}

// The SSOT symbols an enumerating consumer must route through. `assertUnreachableSurface` is the
// exhaustive-switch backstop; `isSessionSurface` is the SSOT predicate that replaces every inlined
// `kind === 'agent' || kind === 'terminal'`. Referencing either is proof of exhaustiveness enrollment.
const ANCHOR_IDENTIFIERS = new Set(['assertUnreachableSurface', 'isSessionSurface'])

type SurfaceKindReader = {
  file: string
  fn: string
  /** Distinct kind string-literals this function compares `surface.kind` against. */
  literals: Set<string>
  /** True if the function references an SSOT anchor identifier. */
  anchored: boolean
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
 * the anchor: the classifier compares each `.kind` read's object type against it, so a kind added to
 * the union widens what this test polices automatically.
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
 * The core classifier, reused for both the synthetic self-check and the real scan. Walks a program,
 * finds every `x.kind` property read whose object is assignable to `surfaceType`, groups by enclosing
 * function, records the kind literals each compares against and whether it references an SSOT anchor.
 */
function collectSurfaceKindReaders(
  program: ts.Program,
  checker: ts.TypeChecker,
  surfaceType: ts.Type,
  rootDir: string
): SurfaceKindReader[] {
  const byFunction = new Map<ts.SignatureDeclaration, SurfaceKindReader>()

  const recordLiteralsFromComparison = (access: ts.PropertyAccessExpression, reader: SurfaceKindReader): void => {
    const parent = access.parent
    // `surface.kind === 'x'` / `!==` — the literal is the other operand.
    if (ts.isBinaryExpression(parent)) {
      const other = parent.left === access ? parent.right : parent.left
      if (ts.isStringLiteralLike(other)) reader.literals.add(other.text)
    }
    // `switch (surface.kind) { case 'x': ... }` — each case label is a literal.
    if (ts.isSwitchStatement(parent) && parent.expression === access) {
      for (const clause of parent.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
          reader.literals.add(clause.expression.text)
        }
      }
    }
  }

  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(rootDir)) continue
    if (source.fileName.endsWith('.d.ts')) continue
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'kind') {
        const objectType = checker.getTypeAtLocation(node.expression)
        // Assignable-to-WorkbenchSurface is the discriminator that a regex cannot make: it separates a
        // surface read from a `session.kind` / `issue.kind` read that is textually identical.
        if (checker.isTypeAssignableTo(objectType, surfaceType)) {
          const fn = enclosingFunction(node)
          if (fn) {
            let reader = byFunction.get(fn)
            if (!reader) {
              reader = {
                file: path.relative(rootDir, source.fileName),
                fn: functionName(fn),
                literals: new Set<string>(),
                anchored: false
              }
              byFunction.set(fn, reader)
            }
            recordLiteralsFromComparison(node, reader)
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

  return [...byFunction.values()]
}

function buildDesktopProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const roots = rendererSources(RENDERER_DIR)
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
  })

  it('self-check 2: the classifier flags an unanchored enumerator and clears an anchored one', () => {
    // A synthetic in-memory program with a known-bad and a known-good consumer. If the checker wiring,
    // the assignability test, or the literal/anchor extraction regressed, this fails LOUDLY here rather
    // than letting the real scan below pass with an empty result set (the vacuous-green failure mode).
    const syntheticName = '/synthetic-surface-guard/probe.ts'
    const syntheticSource = [
      "type WorkbenchSurface =",
      "  | { kind: 'a'; x: number }",
      "  | { kind: 'b'; y: number }",
      "  | { kind: 'c'; z: number }",
      'declare function assertUnreachableSurface(surface: never): never',
      'function unanchoredEnumerator(surface: WorkbenchSurface): number {',
      "  if (surface.kind === 'a') return surface.x",
      "  if (surface.kind === 'b') return surface.y",
      '  return 0',
      '}',
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

    const readers = collectSurfaceKindReaders(
      syntheticProgram,
      syntheticChecker,
      syntheticSurface!,
      '/synthetic-surface-guard'
    )
    const bad = readers.find((r) => r.fn === 'unanchoredEnumerator')
    const good = readers.find((r) => r.fn === 'anchoredEnumerator')
    const selfNamed = readers.find((r) => r.fn === 'isSessionSurface')
    expect(bad, 'classifier must see the unanchored enumerator').toBeDefined()
    expect(good, 'classifier must see the anchored enumerator').toBeDefined()
    expect(selfNamed, 'classifier must see the anchor-named enumerator').toBeDefined()
    // The bad one enumerates (2 literals) and is not anchored → it is exactly what the real assertion
    // below rejects. The good one enumerates (3 literals) and is anchored → accepted.
    expect(bad!.literals.size).toBeGreaterThanOrEqual(2)
    expect(bad!.anchored).toBe(false)
    expect(good!.literals.size).toBeGreaterThanOrEqual(2)
    expect(good!.anchored).toBe(true)
    // The bypass: a function may not anchor itself by carrying an anchor's NAME. Measured before this
    // held: collapsing the real `isSessionSurface` to `default: return false` kept both #491 suites
    // green, because `forEachChild` on the function node visited its own `name` identifier.
    expect(selfNamed!.literals.size).toBeGreaterThanOrEqual(2)
    expect(selfNamed!.anchored, 'a declaration name must not satisfy the anchor test').toBe(false)
  })

  it('every consumer that branches on 2+ surface kinds routes through the exhaustiveness SSOT', () => {
    const readers = collectSurfaceKindReaders(program, checker, surfaceType!, RENDERER_DIR)

    // Self-check 3: the scan must have actually found the known enumerators. A mis-rooted program, or a
    // checker that resolved nothing, yields an empty list — which would make the assertion below pass
    // for the wrong reason. Anchor to two enumerators that must exist by name.
    const enumerators = readers.filter((r) => r.literals.size >= 2)
    const enumeratorNames = new Set(enumerators.map((r) => `${r.file}::${r.fn}`))
    expect(enumeratorNames.has('lib/surface-memory-budget-candidates.ts::candidateForSurface')).toBe(true)
    expect(enumeratorNames.has('lib/workbench-persistence.ts::persistedSurfaceSurvives')).toBe(true)
    expect(enumerators.length).toBeGreaterThanOrEqual(6)

    // The actual guard: no enumerating consumer may lack an SSOT anchor.
    const unanchored = enumerators
      .filter((r) => !r.anchored)
      .map((r) => `${r.file}::${r.fn} branches on {${[...r.literals].sort().join(', ')}}`)
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
