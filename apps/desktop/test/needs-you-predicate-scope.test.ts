import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// WHO may decide "does this Agent need a person", enforced structurally over the whole of `src/`.
//
// `attention-vocabulary.ts` is the SSOT: one total `Record<AgentDisplayState, boolean>` and the
// `isNeedsYouState` predicate reading it. Five surfaces asked the question before that file existed and
// each spelled the answer out itself as `state === 'waiting' || state === 'blocked'`; two carried a
// comment promising they were "kept identical to" another one, which is the shape that drifts.
//
// The guard that existed for this named its scope by hand:
//
//   const CONSUMER_MODULES = ['…/attention-event.ts', '…/agent-attention.ts', '…/quick-switch.ts']
//
// Three paths, typed out. A fresh copy in a fourth file is invisible to it, which is the failure mode
// the guard exists to prevent — and the ordering guard next door (`attention-ordering.test.ts`) had
// already moved to deriving its own scope. This is that lesson applied here.
//
// It is deliberately NOT a text or literal ban over the tree. Measured before writing a line: `'blocked'`
// is an `AgentDisplayState` member AND an unrelated status word in three other subsystems — `move
// blocked` (file-explorer-move.ts), `PR blocked` (pr-launch.ts), `removal blocked`
// (worktree-removal-request.ts), plus the two components rendering those. A tree-wide literal ban reds
// five legitimate files, and an exemption list for them is a second hand-copied scope with the same
// decay. So this drives the TypeScript type checker: a literal counts only where the checker says the
// position is `AgentDisplayState`-typed. The homonyms never enter the scan at all — no exemptions.
//
// TWO TIERS, because "copied the predicate" and "re-derived it" are different shapes and neither
// criterion sees the other (each has a mutation witness in the falsifiability tests below):
//
//   TIER A — a file that IMPORTS from the SSOT may not also name a needs-you state in a typed position.
//     Scope is the import graph, not a path list. This is the tier that catches a HALF copy: a surface
//     that calls `isNeedsYouState` in one place and writes `state === 'waiting'` in another is claiming
//     two different answers to one question, and the single literal is the more dangerous half because
//     it looks like a narrower intent rather than a duplicate.
//
//   TIER B — anywhere in `src/`, a function that names EVERY needs-you state must name EVERY state.
//     This catches a full re-derivation in a file that never heard of the SSOT — the `waiting || blocked`
//     copy, wherever it lands.
//
// WHY TIER B's second half is load-bearing (and not a loophole): a scope naming all nine states is an
// EXHAUSTIVE MAPPING — `statusLabel`, `sessionBoardColumn` — which is the outcome this guard family
// wants, not a violation. `sessionBoardColumn` is explicitly a coarser mapping than the needs-you
// predicate and is documented as such at its declaration; flagging it would be flagging the fix. Nine is
// read from the union, so a tenth state moves this criterion automatically.
//
// WHAT THIS SEES: `state === 'waiting'` / `!==` (either operand order), a `case 'waiting':` label on a
// state-typed switch, and a literal in any position the checker gives a state-typed contextual type —
// which covers a `Record<AgentDisplayState, …>` key, an argument to a state-typed parameter, and an
// element of a state-typed array.
//
// WHAT THIS DOES NOT SEE, stated so the next reader does not over-trust it: a state value widened to
// `string` before comparison (the checker no longer calls the position state-typed), literals assembled
// at runtime, and — for tier A — a copy in a file that imports NOTHING from the SSOT while also naming
// only one needs-you state. That last hole is the price of deriving tier A's scope from the import graph
// instead of a path list, and it is the better trade: a path list decays silently on every new file,
// whereas this hole shrinks every time a surface enrolls in the SSOT. Tier B covers the full copy in
// such a file regardless.
//
// Four self-checks keep it from going vacuously green (the local precedent: a scan whose root is wrong
// reports success over nothing). (1) the union anchor resolves to exactly the nine members and the
// needs-you set to exactly two, both read from the SSOT rather than typed out here; (2) the scan reached
// every `.ts`/`.tsx` file in `src/` on disk, enumerated independently; (3) a synthetic in-memory program
// proves tier A flags a half copy and clears a file that only calls the predicate; (4) a synthetic
// program proves tier B flags a full copy and CLEARS an exhaustive mapping.

const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = path.join(DESKTOP_DIR, 'src')
const VOCABULARY_FILE = path.join(SRC_DIR, 'renderer/src/lib/attention-vocabulary.ts')

/**
 * Can a needs-you decision live in this file? Declaration files hold types and no function bodies.
 *
 * This is the SINGLE place that decision is made: the program's root walk uses it, the scan filters with
 * it, and self-check 2 builds its reference set with it. Written twice, the scan could narrow while the
 * coverage check narrowed in agreement and kept reporting full coverage — the drift shape this whole file
 * exists to prevent.
 */
function carriesDecidingCode(fileName: string): boolean {
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
    if (carriesDecidingCode(entry.name)) found.push(full)
  }
  return found
}

/**
 * The same files, enumerated INDEPENDENTLY of `sourceRoots`.
 *
 * The independence is the point. A coverage check whose expectation comes from the same walk it checks
 * cannot fail: narrow that walk and the reference set narrows identically, both sides agree, and the
 * assertion reports full coverage over less code. So this uses `readdirSync`'s own recursion; the one
 * thing the two enumerations share is `carriesDecidingCode`, the single decision that IS meant to be
 * shared.
 */
function sourceFilesOnDisk(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && carriesDecidingCode(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

type StateVocabulary = {
  /** Every `AgentDisplayState` member, from the union declaration. */
  states: Set<string>
  /** The members the SSOT's verdict table marks `true`, read from that table. */
  needsYou: Set<string>
}

/**
 * Read the vocabulary from the code rather than restating it here.
 *
 * `AgentDisplayState` resolves through `packages/core/dist/types.d.ts` in the desktop program, not
 * `packages/core/src/types.ts` — measured. So the alias is found by scanning every program source file
 * for the declaration instead of by filename, which would find nothing and leave the scan matching no
 * literals at all.
 *
 * The needs-you half comes from `NEEDS_YOU_BY_STATE`'s `true` entries. Typing `['waiting','blocked']`
 * here would make this guard a second hand-copy of the very table it protects: flip a verdict in the
 * SSOT and the guard would keep policing yesterday's answer.
 */
function readStateVocabulary(program: ts.Program, checker: ts.TypeChecker): StateVocabulary {
  const states = new Set<string>()
  for (const source of program.getSourceFiles()) {
    ts.forEachChild(source, (node) => {
      if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'AgentDisplayState') return
      const type = checker.getTypeAtLocation(node.name)
      for (const part of type.isUnion() ? type.types : [type]) {
        if (part.isStringLiteral()) states.add(part.value)
      }
    })
  }

  const needsYou = new Set<string>()
  const vocabulary = program.getSourceFile(VOCABULARY_FILE)
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'NEEDS_YOU_BY_STATE' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          needsYou.add(property.name.getText())
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  if (vocabulary) visit(vocabulary)

  return { states, needsYou }
}

/**
 * Is this literal in a position the checker types as `AgentDisplayState`?
 *
 * Three routes, and each is needed for a shape present in the tree today:
 *   - contextual/declared type is a multi-member union of state members only — a `Record<…>` key, a
 *     state-typed argument, a state-typed array element. Requiring 2+ members is what keeps a literal
 *     whose own type is just itself (`'blocked'` in an unrelated string union of one) out.
 *   - the OTHER operand of `===`/`!==` is state-typed. `null`/`undefined` are allowed alongside, because
 *     `session?.status.state === 'waiting'` types the left side as `AgentDisplayState | undefined` and
 *     that is the ordinary spelling, not an evasion.
 *   - a `case` label on a switch whose expression is state-typed.
 *
 * This is the single thing standing between the guard and the `'blocked'` homonyms; it is why no
 * exemption list appears anywhere in this file.
 */
function isStateTypedPosition(
  literal: ts.StringLiteralLike,
  checker: ts.TypeChecker,
  states: ReadonlySet<string>
): boolean {
  const allStateMembers = (type: ts.Type, allowNullish: boolean): boolean => {
    const parts = type.isUnion() ? type.types : [type]
    if (parts.length < 2) return false
    let sawState = false
    for (const part of parts) {
      if (part.isStringLiteral() && states.has(part.value)) {
        sawState = true
        continue
      }
      if (allowNullish) {
        const name = checker.typeToString(part)
        if (name === 'null' || name === 'undefined') continue
      }
      return false
    }
    return sawState
  }

  for (const type of [checker.getContextualType(literal), checker.getTypeAtLocation(literal)]) {
    if (type && allStateMembers(type, false)) return true
  }

  const parent = literal.parent
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    const other = parent.left === literal ? parent.right : parent.left
    if (allStateMembers(checker.getTypeAtLocation(other), true)) return true
  }

  if (ts.isCaseClause(parent) && parent.expression === literal) {
    const statement = parent.parent.parent
    if (ts.isSwitchStatement(statement) && allStateMembers(checker.getTypeAtLocation(statement.expression), false)) {
      return true
    }
  }

  return false
}

type DecidingScope = {
  file: string
  fn: string
  /** Distinct state literals this scope names in a state-typed position. */
  literals: Set<string>
  /** True when this scope's FILE imports something from the SSOT — tier A's scope, from the import graph. */
  enrolled: boolean
}

function scopeName(node: ts.SignatureDeclaration | null, source: ts.SourceFile): string {
  if (!node) return '<module scope>'
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText()
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  return `(anonymous @ ${path.basename(source.fileName)}:${line})`
}

/**
 * Does this file import anything declared in the SSOT?
 *
 * Resolved through the checker's alias, not by matching the import's path text. A module specifier can be
 * spelled several ways (`./attention-vocabulary`, `../lib/attention-vocabulary`, an alias) and a text
 * match would miss the spellings it did not anticipate — the same decay as the path list this guard
 * replaces. Following the symbol to its declaration file answers the question once, for every spelling.
 */
function importsFromVocabulary(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  vocabularyFile: string
): boolean {
  let found = false
  ts.forEachChild(source, (node) => {
    if (found || !ts.isImportDeclaration(node)) return
    const bindings = node.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return
    for (const specifier of bindings.elements) {
      const symbol = checker.getSymbolAtLocation(specifier.name)
      const target =
        symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      if (target?.declarations?.[0]?.getSourceFile().fileName === vocabularyFile) found = true
    }
  })
  return found
}

/**
 * The core classifier, shared by the two synthetic self-checks and the real scan.
 *
 * Returns `scanned` alongside the scopes: the exact file set this run walked, produced by the same filter
 * that drives the walk, so coverage is asserted against what was scanned rather than inferred from what
 * happened to be found.
 *
 * The SSOT file itself is excluded from the scan — it is where the answer is SUPPOSED to be written, and
 * its verdict table names every state, so including it would report the definition as a violation of
 * itself.
 */
function collectDecidingScopes(
  program: ts.Program,
  checker: ts.TypeChecker,
  vocabulary: StateVocabulary,
  options: { rootDir: string; vocabularyFile: string; isScanned: (fileName: string) => boolean }
): { scopes: DecidingScope[]; scanned: Set<string> } {
  const byFunction = new Map<ts.Node | null, DecidingScope>()
  const scanned = new Set<string>()

  for (const source of program.getSourceFiles()) {
    if (source.fileName === options.vocabularyFile) continue
    if (!options.isScanned(source.fileName)) continue
    scanned.add(source.fileName)
    const relative = path.relative(options.rootDir, source.fileName)
    const enrolled = importsFromVocabulary(source, checker, options.vocabularyFile)

    const visit = (node: ts.Node, enclosing: ts.SignatureDeclaration | null): void => {
      const isFunction =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      const current = isFunction ? (node as ts.SignatureDeclaration) : enclosing

      if (
        ts.isStringLiteralLike(node) &&
        vocabulary.states.has(node.text) &&
        isStateTypedPosition(node, checker, vocabulary.states)
      ) {
        // Keyed by the enclosing function NODE, not by its name: two anonymous callbacks in one file
        // share a printed name but are separate decisions, and merging them would let one scope's
        // literals satisfy the other's criterion.
        const key = current ?? source
        let scope = byFunction.get(key)
        if (!scope) {
          scope = { file: relative, fn: scopeName(current, source), literals: new Set(), enrolled }
          byFunction.set(key, scope)
        }
        scope.literals.add(node.text)
      }

      ts.forEachChild(node, (child) => visit(child, current))
    }
    ts.forEachChild(source, (child) => visit(child, null))
  }

  return { scopes: [...byFunction.values()], scanned }
}

/** TIER A: an enrolled file names ANY needs-you state in a typed position — including just one. */
function tierAViolations(scopes: readonly DecidingScope[], vocabulary: StateVocabulary): string[] {
  return scopes
    .filter((scope) => scope.enrolled && [...vocabulary.needsYou].some((state) => scope.literals.has(state)))
    .map((scope) => `${scope.file}::${scope.fn} names {${[...scope.literals].sort().join(', ')}}`)
    .sort()
}

/** TIER B: any scope names EVERY needs-you state without naming every state (i.e. not exhaustive). */
function tierBViolations(scopes: readonly DecidingScope[], vocabulary: StateVocabulary): string[] {
  return scopes
    .filter(
      (scope) =>
        [...vocabulary.needsYou].every((state) => scope.literals.has(state)) &&
        scope.literals.size < vocabulary.states.size
    )
    .map((scope) => `${scope.file}::${scope.fn} names {${[...scope.literals].sort().join(', ')}}`)
    .sort()
}

/**
 * Build a program from an in-memory source, for the two falsifiability self-checks.
 *
 * `noLib` keeps it fast; the fixtures declare whatever they need.
 */
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

describe('who decides needs-you is confined to the attention vocabulary SSOT', () => {
  const roots = sourceRoots(SRC_DIR)
  const configFile = ts.readConfigFile(path.join(DESKTOP_DIR, 'tsconfig.json'), ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, DESKTOP_DIR)
  const program = ts.createProgram(roots, { ...parsed.options, noEmit: true })
  const checker = program.getTypeChecker()
  const vocabulary = readStateVocabulary(program, checker)
  const rootSet = new Set(roots)
  const scanOptions = {
    rootDir: SRC_DIR,
    vocabularyFile: VOCABULARY_FILE,
    isScanned: (fileName: string) => rootSet.has(fileName)
  }

  it('self-check 1: the vocabulary resolves from the code, nine states and two needs-you', () => {
    // Without this the scan could match no literals at all and report both tiers clean. Pinning the
    // member list also makes a tenth state a deliberate, visible event here.
    expect([...vocabulary.states].sort()).toEqual([
      'blocked',
      'disconnected',
      'done',
      'error',
      'exited',
      'running',
      'starting',
      'waiting',
      'working'
    ])
    // Read from NEEDS_YOU_BY_STATE's `true` entries, so this asserts the SSOT's verdicts rather than
    // restating them: flip one there and this fails, instead of the guard policing a stale answer.
    expect([...vocabulary.needsYou].sort()).toEqual(['blocked', 'waiting'])
  })

  it('self-check 2: the scan reached every source file on disk, not just the ones handed in as roots', () => {
    // A coverage assertion about the scan itself. The reference set comes from `sourceFilesOnDisk`, which
    // walks independently — see its docstring for why sharing the walk would make this unable to fail.
    const { scanned } = collectDecidingScopes(program, checker, vocabulary, scanOptions)
    const onDisk = sourceFilesOnDisk().filter((file) => file !== VOCABULARY_FILE)
    expect(onDisk.length, 'an empty tree would read as full coverage').toBeGreaterThan(100)
    const unscanned = onDisk
      .filter((file) => !scanned.has(file))
      .map((file) => path.relative(SRC_DIR, file))
    expect(
      unscanned.sort(),
      'these files were never scanned, so no needs-you copy in them can be caught'
    ).toEqual([])
  })

  it('self-check 3: tier A flags a HALF copy in an enrolled file and clears one that only calls the SSOT', () => {
    // The shape tier B cannot see, and the reason tier A exists. Both fixtures import from the same
    // synthetic SSOT, so the ONLY difference between flagged and cleared is the bare literal.
    const name = '/synthetic-needs-you/consumer.ts'
    // No arrays anywhere in this fixture. `noLib` means `Array.prototype.filter` has no signature, so a
    // `sessions.filter((s) => s.state === 'waiting')` fixture types `s` as `any` and the literal stops
    // being in a state-typed position — the classifier then finds nothing and this self-check goes green
    // for a reason that has nothing to do with the criterion. Measured: that first draft produced an empty
    // finding set. Direct comparisons keep the fixture about the criterion.
    const source = [
      "type AgentDisplayState = 'waiting' | 'blocked' | 'working' | 'done'",
      'declare function isNeedsYouState(state: AgentDisplayState): boolean',
      'type Session = { state: AgentDisplayState }',
      // Calls the predicate in one place and re-decides in another — two answers to one question.
      'function halfCopy(a: Session, b: Session): number {',
      "  const inline = a.state === 'waiting' ? 1 : 0",
      '  const shared = isNeedsYouState(b.state) ? 1 : 0',
      '  return inline + shared',
      '}',
      // The good citizen: routes everything through the predicate.
      'function onlyTheSsot(session: Session): boolean {',
      '  return isNeedsYouState(session.state)',
      '}',
      // MUST NOT be flagged: names a state, but not a needs-you one.
      'function unrelatedStateTest(session: Session): boolean {',
      "  return session.state === 'working'",
      '}'
    ].join('\n')
    const { program: syntheticProg, checker: syntheticChecker } = syntheticProgram(name, source)
    const syntheticVocabulary = readStateVocabulary(syntheticProg, syntheticChecker)
    expect([...syntheticVocabulary.states].sort()).toEqual(['blocked', 'done', 'waiting', 'working'])

    // The synthetic file declares its own vocabulary, so `enrolled` is forced rather than derived here;
    // the import-graph derivation itself is exercised by the real scan, where three files enrol.
    const { scopes } = collectDecidingScopes(syntheticProg, syntheticChecker, syntheticVocabulary, {
      rootDir: '/synthetic-needs-you',
      vocabularyFile: '/synthetic-needs-you/nowhere.ts',
      isScanned: () => true
    })
    const forced = scopes.map((scope) => ({ ...scope, enrolled: true }))
    const needsYou = new Set(['waiting', 'blocked'])
    const flagged = tierAViolations(forced, { states: syntheticVocabulary.states, needsYou })

    // Asserted on the LITERAL SET, not on a name substring. `.some(includes(name))` cannot tell a missing
    // finding from a differently-named one, so it would go green for a classifier that found nothing at
    // all — which is exactly what the first draft of this fixture did (see the note on `source`).
    //
    // So: exactly one finding, and it is the lone `waiting` in `halfCopy`. `onlyTheSsot` names no state
    // literal so it produces no scope; `unrelatedStateTest` produces one holding `{working}`, which tier A
    // must not flag. Both of those show up here as the ABSENCE of a second entry.
    expect(flagged, 'tier A must flag the lone needs-you literal, and only that').toEqual([
      'consumer.ts::halfCopy names {waiting}'
    ])

    // The non-needs-you scope must have been SEEN and cleared, rather than missed. Without this, a
    // classifier blind to `===` comparisons would produce the same single-entry list above.
    const unrelated = forced.find((scope) => scope.literals.has('working'))
    expect(unrelated, 'the classifier must see the unrelated state test').toBeDefined()
    expect([...unrelated!.literals]).toEqual(['working'])

    // And the blind spot that motivates the second tier, asserted rather than described: tier B sees
    // nothing here at all. If a future change made tier B catch a single-literal copy, this fails and the
    // header's claim that the two tiers cover different shapes stops being prose nothing checks.
    expect(
      tierBViolations(forced, { states: syntheticVocabulary.states, needsYou }),
      'tier B is superset-based, so a single-literal copy is exactly what it cannot see'
    ).toEqual([])
  })

  it('self-check 4: tier B flags a full copy and CLEARS an exhaustive mapping', () => {
    // The precision half. An exhaustive mapping is the outcome this guard family wants, so flagging one
    // would be flagging the fix — measured against the real tree, where `statusLabel` and
    // `sessionBoardColumn` both name `waiting` and `blocked` and both must stay clear.
    const name = '/synthetic-needs-you/rederive.ts'
    const source = [
      "type AgentDisplayState = 'waiting' | 'blocked' | 'working' | 'done'",
      'type Session = { state: AgentDisplayState }',
      // The full hand copy, in a file that never heard of the SSOT.
      'function rederived(session: Session): boolean {',
      "  return session.state === 'waiting' || session.state === 'blocked'",
      '}',
      // An exhaustive mapping: names every state, so a new state fails at compile time here already.
      'function label(state: AgentDisplayState): string {',
      '  switch (state) {',
      "    case 'waiting': return 'Waiting'",
      "    case 'blocked': return 'Blocked'",
      "    case 'working': return 'Working'",
      "    case 'done': return 'Done'",
      '  }',
      '}',
      // A single-state test: a tenth state correctly answers "no", so it is not enumerating.
      'function isDone(session: Session): boolean {',
      "  return session.state === 'done'",
      '}'
    ].join('\n')
    const { program: syntheticProg, checker: syntheticChecker } = syntheticProgram(name, source)
    const syntheticVocabulary = {
      states: readStateVocabulary(syntheticProg, syntheticChecker).states,
      needsYou: new Set(['waiting', 'blocked'])
    }
    const { scopes } = collectDecidingScopes(syntheticProg, syntheticChecker, syntheticVocabulary, {
      rootDir: '/synthetic-needs-you',
      vocabularyFile: '/synthetic-needs-you/nowhere.ts',
      isScanned: () => true
    })
    const flagged = tierBViolations(scopes, syntheticVocabulary)

    // The exact finding set, for the reason spelled out in self-check 3: `.some(includes(name))` cannot
    // tell a missing finding from a differently-named one, so it would go green for a classifier that
    // found nothing. `rederived` names both needs-you states and only those two — flagged. `label` names
    // all four — cleared. `isDone` names one — cleared.
    expect(flagged, 'tier B must flag the full re-derivation, and only that').toEqual([
      'rederive.ts::rederived names {blocked, waiting}'
    ])

    // Both cleared scopes must have been SEEN, and for the right reason. Without this, a classifier blind
    // to `case` labels would clear `label` because it read nothing there, and a classifier blind to `===`
    // would clear `isDone` the same way — either would produce the single-entry list above.
    const exhaustive = scopes.find((scope) => scope.fn === 'label')
    expect(exhaustive, 'the classifier must see the exhaustive mapping').toBeDefined()
    expect(
      [...exhaustive!.literals].sort(),
      'cleared because it names every state, not because the case labels went unread'
    ).toEqual(['blocked', 'done', 'waiting', 'working'])

    const single = scopes.find((scope) => scope.fn === 'isDone')
    expect(single, 'the classifier must see the single-state test').toBeDefined()
    expect([...single!.literals]).toEqual(['done'])
  })

  it('tier A: no file that imports the needs-you SSOT also names a needs-you state itself', () => {
    const { scopes } = collectDecidingScopes(program, checker, vocabulary, scanOptions)

    // The scan must have found the enrolled files, or this tier polices an empty set. Derived from the
    // import graph: these three import `isNeedsYouState`, and a fourth enrolling widens the tier
    // automatically.
    const enrolledFiles = new Set(scopes.filter((scope) => scope.enrolled).map((scope) => scope.file))
    const allEnrolled = new Set(
      program
        .getSourceFiles()
        .filter((source) => rootSet.has(source.fileName) && source.fileName !== VOCABULARY_FILE)
        .filter((source) => importsFromVocabulary(source, checker, VOCABULARY_FILE))
        .map((source) => path.relative(SRC_DIR, source.fileName))
    )
    expect(
      [...allEnrolled].sort(),
      'the SSOT importer set is what scopes this tier; an empty set would police nothing'
    ).toEqual([
      'renderer/src/lib/agent-attention.ts',
      'renderer/src/lib/attention-event.ts',
      'renderer/src/lib/quick-switch.ts'
    ])
    // Enrolled files with zero state literals produce no scope at all, which is the clean state — so
    // this may legitimately be empty and is NOT asserted non-empty.
    expect([...enrolledFiles].every((file) => allEnrolled.has(file))).toBe(true)

    expect(
      tierAViolations(scopes, vocabulary),
      'A surface that imports from attention-vocabulary.ts also decides needs-you itself. Even one ' +
        'literal is a second answer to a question this file already answers — call isNeedsYouState ' +
        'instead. See src/renderer/src/lib/attention-vocabulary.ts.'
    ).toEqual([])
  })

  it('tier B: no scope re-derives the needs-you class from state literals', () => {
    const { scopes } = collectDecidingScopes(program, checker, vocabulary, scanOptions)

    // The scan must have found the exhaustive mappings, or a classifier that resolved nothing would make
    // this tier pass for the wrong reason. These two name all nine states and are cleared BY DESIGN:
    // `statusLabel` is the notification label, `sessionBoardColumn` a deliberately coarser mapping.
    const named = new Map(scopes.map((scope) => [`${scope.file}::${scope.fn}`, scope]))
    for (const key of [
      'shared/notification-presentation.ts::statusLabel',
      'renderer/src/lib/project-board.ts::sessionBoardColumn'
    ]) {
      const scope = named.get(key)
      expect(scope, `the classifier must see ${key}`).toBeDefined()
      expect(
        scope!.literals.size,
        `${key} is an exhaustive mapping — it must name every state, which is why tier B clears it`
      ).toBe(vocabulary.states.size)
    }

    expect(
      tierBViolations(scopes, vocabulary),
      'A scope names every needs-you state without being an exhaustive mapping — that is the ' +
        '`state === \'waiting\' || state === \'blocked\'` copy this SSOT replaced. Call ' +
        'isNeedsYouState, or make the mapping total over AgentDisplayState so a new state fails to ' +
        'compile. See src/renderer/src/lib/attention-vocabulary.ts.'
    ).toEqual([])
  })
})
