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
// state-typed switch, a literal in any position the checker gives a state-typed contextual type (an
// argument to a state-typed parameter, an element of a state-typed array), and both halves of a table
// KEYED by state — writing `{ waiting: true, blocked: true }` under a `Record<AgentDisplayState, …>`
// annotation, and reading one back as `table['waiting']`. That last pair is here because it is the
// structure `NEEDS_YOU_BY_STATE` itself is, so a second one is the SSOT's own table copied. An earlier
// version of this file claimed to cover it and did not: the walk only offered STRING LITERALS to the
// classifier, and a verdict table is written with identifier keys, so `waiting:` never arrived. Measured
// then — a `Partial<Record<AgentDisplayState, true>>` table read by index passed clean — and measured
// again now as the mutation witness below.
//
// WHAT THIS DOES NOT SEE, stated so the next reader does not over-trust it: a state value widened to
// `string` before comparison (the checker no longer calls the position state-typed), a membership array
// (`['waiting','blocked'].includes(state)` — the tuple's elements type as their own singletons, so the
// 2+-member test declines), literals assembled at runtime, and — for tier A — a copy in a file that
// imports nothing from the SSOT *through a named import* while also naming only one needs-you state. That
// last one includes a namespace import (`import * as v from './attention-vocabulary'`), which does not
// enroll the file. It is the price of deriving tier A's scope from the import graph instead of a path
// list, and it is the better trade: a path list decays silently on every new file, whereas this hole
// shrinks every time a surface enrolls in the SSOT. Tier B covers the full copy in such a file regardless.
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
 * A node that spells a state's name: `'waiting'` or the bare `waiting` of an object key.
 *
 * Both spellings must be candidates, and the reason is measured rather than defensive: a verdict table is
 * ordinarily written with identifier keys (`{ waiting: true, blocked: true }`), so a gate accepting only
 * string literals never even offers that key to the position classifier. Restricting identifiers to
 * property-name position is what keeps every ordinary variable called `error` or `done` out of the scan.
 */
type StateNameNode = ts.StringLiteralLike | ts.Identifier

function stateNameOf(node: ts.Node, states: ReadonlySet<string>): StateNameNode | null {
  if (ts.isStringLiteralLike(node)) return states.has(node.text) ? node : null
  if (!ts.isIdentifier(node) || !states.has(node.text)) return null
  // Only as the NAME of a property, never as a value read. `waiting` in `{ waiting: true }` names a state;
  // `waiting` in `if (waiting)` is somebody's boolean.
  const parent = node.parent
  const isPropertyName =
    (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isShorthandPropertyAssignment(parent)) &&
    parent.name === node
  return isPropertyName ? node : null
}

/**
 * Is this literal in a position the checker types as `AgentDisplayState`?
 *
 * Three routes, and each is needed for a shape present in the tree today:
 *   - contextual/declared type is a union that COVERS every `AgentDisplayState` member — a state-typed
 *     argument or a state-typed array element. Covering the whole union (assignable-FROM it), not merely
 *     being a subset of its members, is what keeps a distinct semantic SUBTYPE out: `main/
 *     prompt-readiness-diagnostics.ts::PromptReadinessSemanticState` is `waiting|blocked|done|error`, a
 *     legitimate 4-member type whose every member is also an `AgentDisplayState` member but which is not an
 *     `AgentDisplayState` position. A subset-of-members heuristic mis-classified it; requiring full
 *     coverage does not. It also keeps a literal whose own type is just itself (`'blocked'` in an unrelated
 *     string union of one) out, for the same reason.
 *   - the OTHER operand of `===`/`!==` is state-typed. `null`/`undefined` are allowed alongside, because
 *     `session?.status.state === 'waiting'` types the left side as `AgentDisplayState | undefined` and
 *     that is the ordinary spelling, not an evasion.
 *   - a `case` label on a switch whose expression is state-typed.
 *
 * Plus the two halves of a table KEYED by state, which is the structure `NEEDS_YOU_BY_STATE` itself is —
 * see `stateKeyedRecord` below for why writing and reading are asked differently.
 *
 * This is the single thing standing between the guard and the `'blocked'` homonyms; it is why no
 * exemption list appears anywhere in this file.
 */
function isStateTypedPosition(
  literal: StateNameNode,
  checker: ts.TypeChecker,
  states: ReadonlySet<string>
): boolean {
  // COVERS every state, not merely a subset of them. `AgentDisplayState` must be assignable INTO this
  // position — every state member present, and no member that is not a state (nullish aside). A subset
  // check ("every member is a state") flagged a distinct semantic SUBTYPE whose members happen to all be
  // states: `PromptReadinessSemanticState` ('waiting'|'blocked'|'done'|'error') is a legitimate narrower
  // type, not an `AgentDisplayState` position, and naming its members is not a needs-you re-derivation.
  // Kept as literal coverage rather than `isTypeAssignableTo(AgentDisplayState, …)` on purpose: the latter
  // is also true for `string` (every state IS a string), which would newly flag the documented
  // widened-to-`string` blind spot below.
  const coversEveryState = (type: ts.Type, allowNullish: boolean): boolean => {
    const present = new Set<string>()
    for (const part of type.isUnion() ? type.types : [type]) {
      if (part.isStringLiteral() && states.has(part.value)) {
        present.add(part.value)
        continue
      }
      if (allowNullish) {
        const name = checker.typeToString(part)
        if (name === 'null' || name === 'undefined') continue
      }
      return false
    }
    return states.size > 0 && [...states].every((state) => present.has(state))
  }

  // The DECLARED type of a `===`/`!==` operand, before control-flow narrowing. In
  // `a === 'waiting' || a === 'blocked'` the checker narrows `a` on the second comparison to exclude
  // `'waiting'`, so its flow type no longer covers the full union and the second literal would go
  // uncounted — splitting one re-derivation across two half-seen comparisons and letting tier B miss it.
  // The symbol's declared type is stable across the chain; fall back to the flow type when there is no
  // symbol (an operand that is itself a call or other expression).
  const declaredTypeOf = (node: ts.Expression): ts.Type => {
    const symbol = checker.getSymbolAtLocation(node)
    return symbol ? checker.getTypeOfSymbol(symbol) : checker.getTypeAtLocation(node)
  }

  // A table KEYED by state. Symmetric with `coversEveryState`: there every state member must be present,
  // here every state must appear as a property name (extra non-state keys would fail the same way an extra
  // non-state union member does). A partial table over a subset of the states is not this shape.
  const stateKeyedRecord = (type: ts.Type): boolean => {
    const names = new Set(checker.getPropertiesOfType(type).map((property) => property.name))
    return states.size > 0 && [...states].every((state) => names.has(state))
  }

  // WRITING a verdict table: `{ waiting: true, blocked: true }` annotated as
  // `Partial<Record<AgentDisplayState, true>>`, read back by index, is a second copy of the SSOT's own
  // table — the exact structure `NEEDS_YOU_BY_STATE` is. Read from the CONTEXTUAL type, i.e. from an
  // annotation, not from the literal's inferred type: an unannotated `{ error, working }` in some
  // unrelated hook infers a type whose property names happen to all be states, and flagging that would
  // be inventing a homonym problem in the one place this guard had avoided one. The annotation is also
  // what makes the evasion reachable at all — without it, indexing the object by an
  // `AgentDisplayState` does not compile, so there is nothing to hide behind.
  if (ts.isPropertyAssignment(literal.parent) && literal.parent.name === literal) {
    const contextual = checker.getContextualType(literal.parent.parent)
    return contextual !== undefined && stateKeyedRecord(contextual)
  }

  // READING one: `table['waiting']`. Here the object's own declared type answers it, no annotation on
  // this expression needed.
  if (ts.isElementAccessExpression(literal.parent) && literal.parent.argumentExpression === literal) {
    if (stateKeyedRecord(checker.getTypeAtLocation(literal.parent.expression))) return true
  }

  for (const type of [checker.getContextualType(literal), checker.getTypeAtLocation(literal)]) {
    if (type && coversEveryState(type, false)) return true
  }

  const parent = literal.parent
  if (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    const other = parent.left === literal ? parent.right : parent.left
    if (coversEveryState(declaredTypeOf(other), true)) return true
  }

  if (ts.isCaseClause(parent) && parent.expression === literal) {
    const statement = parent.parent.parent
    if (ts.isSwitchStatement(statement) && coversEveryState(declaredTypeOf(statement.expression), false)) {
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

/**
 * Can this node hold a needs-you decision of its own?
 *
 * Every shape with a body that can compute a verdict, plus the two accessor shapes. NOT a mere block or
 * an `if` — those are inside a decision, not a separate one, and treating them as separate would let a
 * copy split across two statements evade tier B by never gathering both literals in one bucket.
 *
 * The list is deliberately broader than "functions". The narrower version keyed only
 * FunctionDeclaration / FunctionExpression / ArrowFunction / MethodDeclaration, and everything else fell
 * into one shared per-file bucket — see the note at the call site for the merge that let through.
 */
function isDecidingScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node)
  )
}

function scopeName(node: ts.Node | null, source: ts.SourceFile): string {
  if (!node) return '<module scope>'
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText()
  }
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

    const visit = (node: ts.Node, enclosing: ts.Node | null): void => {
      const current = isDecidingScope(node) ? node : enclosing

      const named = stateNameOf(node, vocabulary.states)
      if (named && isStateTypedPosition(named, checker, vocabulary.states)) {
        // Keyed by the enclosing scope NODE, not by its name: two anonymous callbacks in one file
        // share a printed name but are separate decisions, and merging them would let one scope's
        // literals satisfy the other's criterion.
        //
        // The same reasoning is why `isDecidingScope` must accept every shape that can hold a decision,
        // not just the four function shapes. A getter body or a top-level statement used to fall through
        // to a per-FILE bucket, and that bucket MERGES: a `waiting || blocked` copy in a getter, in a file
        // whose module scope also names all nine states somewhere (a state-typed array, say), reached
        // `literals.size === 9` and tier B's non-exhaustive half went false — clearing the copy. Measured
        // on a synthetic file before this widened; the merge is now confined to nodes that cannot hold a
        // decision at all.
        const key = current ?? source
        let scope = byFunction.get(key)
        if (!scope) {
          scope = { file: relative, fn: scopeName(current, source), literals: new Set(), enrolled }
          byFunction.set(key, scope)
        }
        scope.literals.add(named.text)
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

  it('self-check 5: tier B flags a verdict TABLE, both writing it and reading it back', () => {
    // The evasion an earlier version of this file claimed to cover and did not. A verdict table is the
    // structure the SSOT itself is, so a second one is the copy in its most literal form — and it is
    // written with IDENTIFIER keys, which never reached the position classifier when the walk offered it
    // only string literals. Both halves are here because they fail independently: writing the table and
    // reading one back are separate routes, and a fixture with only one would leave the other unwitnessed.
    //
    // `{ [K in AgentDisplayState]?: true }` rather than `Partial<Record<…>>`: `noLib` means the lib types
    // do not exist, and the mapped type is the same structure without them. Same reason the fixtures here
    // avoid arrays — see the note in self-check 3.
    const name = '/synthetic-needs-you/table.ts'
    const source = [
      "type AgentDisplayState = 'waiting' | 'blocked' | 'working' | 'done'",
      // WRITING it: annotated, so the keys are in a state-typed position. The annotation is also what
      // makes this reachable at all — without it, indexing by an AgentDisplayState does not compile.
      'const NEEDS_YOU: { [K in AgentDisplayState]?: true } = { waiting: true, blocked: true }',
      // READING one back by name.
      'function readsByIndex(state: AgentDisplayState): boolean {',
      "  return state === 'working' ? false : NEEDS_YOU['waiting'] === true || NEEDS_YOU['blocked'] === true",
      '}',
      // MUST NOT be flagged: an exhaustive table names every state, which is the outcome this guard wants.
      "const LABEL: { [K in AgentDisplayState]: string } = { waiting: 'W', blocked: 'B', working: 'K', done: 'D' }"
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

    // Exact set, for the reason given in self-check 3. Two findings, one per route: the module-scope write
    // (`NEEDS_YOU` and `LABEL` both live there, so the bucket holds all four states — see the note below
    // for why that still flags) and the by-name read inside `readsByIndex`.
    //
    // `readsByIndex` names `working` as well, so its set is {blocked, waiting, working} — three of four,
    // still short of exhaustive, still flagged. That is deliberate: a scope that mentions a third state
    // incidentally has not become a total mapping.
    const flagged = tierBViolations(scopes, syntheticVocabulary)
    expect(flagged, 'both halves of a state-keyed table must be visible').toEqual([
      'table.ts::readsByIndex names {blocked, waiting, working}'
    ])

    // The write half, asserted directly rather than through the finding list: module scope holds every
    // state here (two from `NEEDS_YOU`, four from `LABEL`), so it is cleared as exhaustive — which means
    // the finding list above cannot witness it. Without this assertion, deleting the property-name route
    // would leave that list unchanged and this self-check would pass over a blind classifier.
    const moduleScope = scopes.find((scope) => scope.fn === '<module scope>')
    expect(moduleScope, 'the classifier must see identifier keys at all').toBeDefined()
    expect(
      [...moduleScope!.literals].sort(),
      'written table keys must be counted; an unannotated object elsewhere is not this shape'
    ).toEqual(['blocked', 'done', 'waiting', 'working'])
  })

  it('self-check 6: a copy in a getter is its own scope, not merged into the file', () => {
    // The merge that cleared a full copy. Scope attribution used to recognize four function shapes; a
    // getter body fell through to a per-FILE bucket, and that bucket merges with everything else at module
    // scope. Measured: with an exhaustive table in the same file, the getter's `waiting || blocked` copy
    // reached `literals.size === 4` and tier B's non-exhaustive half went false — cleared.
    const name = '/synthetic-needs-you/accessor.ts'
    const source = [
      "type AgentDisplayState = 'waiting' | 'blocked' | 'working' | 'done'",
      'class Lane {',
      "  state: AgentDisplayState = 'working'",
      // The copy, in a scope the narrower version did not recognize.
      "  get needsYou(): boolean { return this.state === 'waiting' || this.state === 'blocked' }",
      '}',
      // The same-file exhaustive naming that did the hiding. On its own it is legitimate and must stay
      // cleared; what must not happen is it absorbing the getter's literals.
      "const LABEL: { [K in AgentDisplayState]: string } = { waiting: 'W', blocked: 'B', working: 'K', done: 'D' }"
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

    expect(
      tierBViolations(scopes, syntheticVocabulary),
      'the getter is a decision of its own and must not be absorbed by the file'
    ).toEqual(['accessor.ts::needsYou names {blocked, waiting}'])

    // And the hiding mechanism must have been PRESENT, not absent: the exhaustive naming has to be in the
    // same file and seen, or this fixture proves nothing about merging. Without this, a fixture whose
    // `LABEL` went unread would flag the getter for a reason unrelated to the merge.
    const moduleScope = scopes.find((scope) => scope.fn === '<module scope>')
    expect(moduleScope, 'the same-file exhaustive naming must be present to be hidden behind').toBeDefined()
    expect([...moduleScope!.literals].sort()).toEqual(['blocked', 'done', 'waiting', 'working'])
  })

  it('tier A: no file that imports the needs-you SSOT also names a needs-you state itself', () => {
    const { scopes } = collectDecidingScopes(program, checker, vocabulary, scanOptions)

    // The scan must have found the enrolled files, or this tier polices an empty set. Derived from the
    // import graph: these three import `isNeedsYouState`, and a fourth enrolling widens the tier
    // automatically.
    //
    // The set GROWS when a surface stops re-deriving and starts asking — GlobalFocusSurface.tsx joined
    // by replacing its own state test with `isNeedsYouState(row.state)`, which is exactly the direction
    // this regime wants; enrolling costs it nothing because it names no literal of its own.
    //
    // The set also SHRINKS legitimately, and that is the interesting direction — a file leaves when it
    // stops asking the predicate at all. quick-switch.ts left when its ranking collapsed into
    // `attentionSortClass` (attention-event.ts, itself enrolled): it now delegates the whole decision
    // one hop upstream instead of asking the table directly. Leaving this tier is NOT leaving the
    // regime — tier B below scans every scope regardless of enrollment, and
    // attention-vocabulary.test.ts keeps quick-switch.ts in its hand-copy ban list. What would be wrong
    // is padding this list back up with a vestigial `import { isNeedsYouState }` that nothing
    // calls, to keep a snapshot green.
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
      'renderer/src/components/GlobalFocusSurface.tsx',
      'renderer/src/lib/agent-attention.ts',
      'renderer/src/lib/attention-event.ts'
    ])
    // Enrolled files with zero state literals produce no scope at all, which is the clean state — so
    // this may legitimately be empty and is NOT asserted non-empty.
    // vacuous-ok: 空集合是这里的合法终局（一个状态字面量都没有＝干净），要求非空证明等于逼人写假话。
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
