import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { declarationOf, importedModuleOf, parseModule, parseModuleFile } from './helpers/ts-binding.js'
import type { ParsedModule } from './helpers/ts-binding.js'

/**
 * Every runtime enum schema must take its member list from an IMPORTED tuple, never from one authored
 * where the schema is built.
 *
 * WHY THIS GUARD EXISTS, given that `config-store.ts` already carries a two-way exactness proof
 * (`_schemaEnumsAreExactlyTheirUnions`): that proof only bites once the two spellings DISAGREE. Measured
 * on the commit that introduced it — re-forking `z.enum(TERMINAL_THEME_IDS)` back into an EQUAL hand list
 * `z.enum(['graphite', 'catppuccin-mocha'])` leaves `tsc --noEmit` at exit 0 and the whole 84-test
 * baseline green, because an equal copy satisfies containment in both directions. That is a silent
 * regression to the exact pre-fix shape, and the shape is the defect: the copy is correct only for
 * today's union, and the next member added to the union goes in one place while config load keeps
 * fail-closed-dropping it (`.strict()` + a stale enum). The exactness proof catches the drift AFTER it
 * happens; this guard forbids the shape that makes drift possible at all. The two are complementary and
 * neither subsumes the other.
 *
 * The criterion is an IMPORT RELATION resolved by the binder, not a text match (memory
 * `guard-criterion-must-be-import-relation`): each call's member argument is traced through the shapes a
 * real derivation takes — parentheses, `as`/`satisfies` casts, `.map(...)` projections, property and
 * element access — down to a root identifier, and that identifier must resolve to a named import. A
 * same-named local shadow therefore does not pass, and neither does `const IDS = [...] as const` authored
 * in the same file. `notificationModeIds` (`NOTIFICATION_TIERS.map((tier) => tier.id) as [string, ...]`)
 * passes on its own merits — it roots in an import — so it needs no exception entry, and there is no
 * exception list for a future member to hide in (memory `forbidden-list-guard-always-leaks`).
 *
 * SCAN SURFACE is every `.ts` under `src/`, not the one file that has schemas today: a guard bound to a
 * filename goes blind the moment the schema is extracted elsewhere (memory
 * `extracting-to-lib-moves-it-out-of-guard-view`). Self-check 1 asserts the scan actually reached
 * `main/config-store.ts` and found sites there, so a wrong scan root cannot go vacuously green.
 *
 * DECLARED BLIND SPOTS:
 * - The extractor accepts any call to a member named `enum`, whatever the receiver — deliberately
 *   over-inclusive, since an extra site only ever adds a check. It does NOT prove the receiver is zod.
 * - Bracket-spelled calls (`z['enum'](...)`) ARE scanned for offence, but they are excluded from the
 *   token-sequence reconciliation in self-check 2, which covers the dot form only. So an extractor that
 *   stopped recognizing the BRACKET form would not be caught by the reconciliation — only by the
 *   dedicated fixtures.
 * - The reconciliation counts the PARSER's leaf tokens, so a `.enum(` written inside a comment or a
 *   string literal is one token (or no token at all) and cannot inflate it. What it also cannot see is a
 *   call assembled at runtime (`z[key](...)`); that shape is outside both judgements.
 * - Tracing stops at the import. It does not prove the imported tuple is itself the union's SSOT — that
 *   is what `_schemaEnumsAreExactlyTheirUnions` in `config-store.ts` proves, at compile time.
 */

const here = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(here, '..', 'src')
const CONFIG_STORE = join(SRC_ROOT, 'main', 'config-store.ts')

interface EnumSite {
  readonly file: string
  readonly line: number
  readonly argumentText: string
  /** Module specifier the member tuple roots in, or `null` when it is authored in the scanned file. */
  readonly importedFrom: string | null
  readonly rootName: string | null
  readonly dotSpelled: boolean
}

/** Every `.ts` under `dir`, walked recursively. */
function sourceFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFilesUnder(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
  }
  return found.sort()
}

/**
 * The identifier a member-tuple expression ultimately reads from, folding through the transparent and
 * projecting shapes a real derivation uses. Returns `null` for anything authored in place — an array
 * literal above all, which is exactly the re-fork this guard exists to forbid.
 */
function rootIdentifier(expr: ts.Expression, depth = 0): ts.Identifier | null {
  if (depth > 16) return null
  if (ts.isParenthesizedExpression(expr)) return rootIdentifier(expr.expression, depth + 1)
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return rootIdentifier(expr.expression, depth + 1)
  if (ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
    return rootIdentifier(expr.expression, depth + 1)
  }
  if (ts.isCallExpression(expr)) return rootIdentifier(expr.expression, depth + 1)
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return rootIdentifier(expr.expression, depth + 1)
  }
  if (ts.isIdentifier(expr)) return expr
  return null
}

/**
 * Where a member tuple comes from: the module it was imported from, or `null` when the trail ends inside
 * this file. Local `const` bindings are followed to their initializer, so one level of naming (the
 * `notificationModeIds` shape) does not hide the origin — nor manufacture one.
 */
function tupleOrigin(
  module: ParsedModule,
  expr: ts.Expression,
  depth = 0
): { importedFrom: string | null; rootName: string | null } {
  if (depth > 16) return { importedFrom: null, rootName: null }
  const identifier = rootIdentifier(expr)
  if (identifier === null) return { importedFrom: null, rootName: null }
  const declaration = declarationOf(module, identifier)
  const imported = importedModuleOf(declaration)
  if (imported !== null) return { importedFrom: imported, rootName: identifier.text }
  if (declaration !== null && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return tupleOrigin(module, declaration.initializer, depth + 1)
  }
  return { importedFrom: null, rootName: identifier.text }
}

/** Is this callee a member named `enum`, in either spelling? */
function enumCallee(callee: ts.Expression): { matched: boolean; dotSpelled: boolean } {
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'enum') {
    return { matched: true, dotSpelled: true }
  }
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression
    if (ts.isStringLiteralLike(key) && key.text === 'enum') return { matched: true, dotSpelled: false }
  }
  return { matched: false, dotSpelled: false }
}

function enumSites(module: ParsedModule, label: string): EnumSite[] {
  const sites: EnumSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const { matched, dotSpelled } = enumCallee(node.expression)
      const argument = node.arguments[0]
      if (matched && argument !== undefined) {
        const origin = tupleOrigin(module, argument)
        sites.push({
          file: label,
          line: module.sourceFile.getLineAndCharacterOfPosition(node.getStart(module.sourceFile)).line + 1,
          argumentText: argument.getText(module.sourceFile),
          importedFrom: origin.importedFrom,
          rootName: origin.rootName,
          dotSpelled
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return sites
}

/**
 * How many `. enum (` token sequences the parser's own token stream contains — the independent count
 * self-check 2 reconciles the AST extractor against.
 *
 * WHY THE PARSER'S TOKENS AND NOT A RAW `ts.createScanner` LOOP, which is what this started as: a bare
 * scanner has no parser to drive `reScanTemplateToken`, so the first multi-line template literal with a
 * `${…}` substitution desynchronizes it — everything after is mis-lexed, and measured on
 * `config-store.ts` that made the backticks inside the JSDoc read as template delimiters, so the comment
 * body (which quotes `z.enum([...])` as the shape it forbids) was counted as code. The parser's leaf
 * tokens have none of that: comments are trivia and never appear, template literals are single tokens,
 * and the sequence is the real one.
 *
 * It is still an INDEPENDENT judgement from {@link enumSites}, which is the point of a reconciliation:
 * this counts a three-token sequence, while the extractor matches a `CallExpression` whose callee is an
 * `enum` member and which has a first argument. An extractor that quietly stopped recognizing a call
 * shape would find fewer sites than there are token sequences, and this turns red.
 *
 * `enum` is a reserved word, so after a dot the parser emits `EnumKeyword`, not an identifier. Accepting
 * only the identifier spelling would make this count zero everywhere and the reconciliation vacuous in
 * the other direction, so both are accepted.
 */
function dotSpelledLexemes(sourceFile: ts.SourceFile): number {
  const tokens: ts.Node[] = []
  const collect = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile)
    if (children.length === 0) tokens.push(node)
    else for (const child of children) collect(child)
  }
  collect(sourceFile)

  let count = 0
  for (let index = 2; index < tokens.length; index += 1) {
    const dot = tokens[index - 2]
    const name = tokens[index - 1]
    const open = tokens[index]
    // index 跑的是 2..length-1，三个下标都在界内；这道门只有在那条前提被打破时才会落空
    // （noUncheckedIndexedAccess 要求写出来）。不用 `!`/`as`：那两种写法会把洞焊回去。
    if (dot === undefined || name === undefined || open === undefined) continue
    const isEnumName =
      name.kind === ts.SyntaxKind.EnumKeyword ||
      (name.kind === ts.SyntaxKind.Identifier && name.getText(sourceFile) === 'enum')
    if (
      dot.kind === ts.SyntaxKind.DotToken &&
      isEnumName &&
      open.kind === ts.SyntaxKind.OpenParenToken
    ) {
      count += 1
    }
  }
  return count
}

/** Each scanned file parsed exactly once: the same module object feeds both the extractor and the count. */
const SCANNED = sourceFilesUnder(SRC_ROOT).map((file) => ({
  path: file,
  label: relative(SRC_ROOT, file),
  module: parseModuleFile(file)
}))
const ALL_SITES = SCANNED.flatMap((entry) => enumSites(entry.module, entry.label))

describe('every enum schema takes its members from an imported tuple', () => {
  it('self-check 1: the scan reached config-store and found the schema enums living there', () => {
    expect(SCANNED.map((entry) => entry.path)).toContain(CONFIG_STORE)
    const inConfigStore = ALL_SITES.filter((site) => site.file === relative(SRC_ROOT, CONFIG_STORE))
    // A floor, not a fixed count: adding a legitimately-derived enum field must not turn this red
    // (memory `expected-value-must-not-derive-from-mutation-target`). What stops the extractor from
    // silently finding too FEW is self-check 2, which reconciles against each file's own token stream.
    expect(inConfigStore.length).toBeGreaterThan(0)
    expect(ALL_SITES.length).toBeGreaterThan(0)
  })

  it('self-check 2: the AST extractor found every dot-spelled .enum( token sequence in each scanned file', () => {
    const mismatches = SCANNED.map((entry) => ({
      label: entry.label,
      lexemes: dotSpelledLexemes(entry.module.sourceFile),
      parsed: ALL_SITES.filter((site) => site.file === entry.label && site.dotSpelled).length
    })).filter((row) => row.lexemes !== row.parsed)
    expect(mismatches).toEqual([])
  })

  it('self-check 3: an array literal argument is reported, in every shape a re-fork can take', () => {
    const preamble = "import { z } from 'zod'\nimport { IDS } from './ssot.js'\n"
    // `.every` is vacuously true on an empty array, so an extractor that stopped finding ANY call would
    // pass every fixture below. The length floor is what makes each expectation mean "found it, and it
    // was reported as authored in place" rather than "found nothing".
    const offends = (body: string): boolean => {
      const sites = enumSites(parseModule(preamble + body), 'synthetic')
      return sites.length > 0 && sites.every((site) => site.importedFrom === null)
    }

    // The measured survivor: an EQUAL hand copy of today's members.
    expect(offends("const s = z.enum(['graphite', 'catppuccin-mocha'])")).toBe(true)
    // Laundered through a local const, and through a local const that is itself `as const`.
    expect(offends("const local = ['a', 'b'] as const\nconst s = z.enum(local)")).toBe(true)
    expect(offends("const a = ['a']\nconst b = a\nconst s = z.enum(b)")).toBe(true)
    // A function-scope shadow of an imported tuple must not inherit the import's credit.
    expect(offends("function build() {\n  const IDS = ['a', 'b'] as const\n  return z.enum(IDS)\n}")).toBe(true)
  })

  it('self-check 4: a genuinely derived argument is accepted, including through a projection', () => {
    const preamble = "import { z } from 'zod'\nimport { IDS, TIERS } from './ssot.js'\n"
    const acceptedRoots = (body: string): (string | null)[] =>
      enumSites(parseModule(preamble + body), 'synthetic').map((site) => site.importedFrom)

    expect(acceptedRoots('const s = z.enum(IDS)')).toEqual(['./ssot.js'])
    // The `notificationModeIds` shape: a cast-wrapped `.map` projection over an imported table. It is
    // accepted because it roots in an import — not because it is named in an exception list.
    expect(
      acceptedRoots(
        'const ids = TIERS.map((tier) => tier.id) as [string, ...string[]]\nconst s = z.enum(ids)'
      )
    ).toEqual(['./ssot.js'])
  })

  it('no enum schema authors its own member list', () => {
    const offenders = ALL_SITES.filter((site) => site.importedFrom === null).map(
      (site) => `${site.file}:${site.line} z.enum(${site.argumentText})`
    )
    expect(offenders).toEqual([])
  })
})
