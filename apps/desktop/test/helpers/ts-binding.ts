import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * Binding-resolving AST helpers shared by the window-security reachability guards.
 *
 * Why a shared helper exists (and why every judgement in it goes through the type checker, not text):
 * this repo's isolation guards have repeatedly failed the SAME way — they matched a symbol by its
 * spelling, so a same-named local shadow (`const join = …`, `const windowSecurityWebPreferences = …`)
 * kept the callee text identical while pointing the value somewhere hostile, and the suite stayed green.
 * A guard that asks "does this identifier RESOLVE to the import I expect?" cannot be fooled by a rename,
 * because the answer comes from the binder, not the characters.
 *
 * `parseModule` builds a single-file `ts.Program` (noResolve/noLib) whose checker gives real binding
 * information for one file without touching disk lib.d.ts or the imported modules — every judgement here
 * needs only single-file bindings (does this name resolve to a local decl, or to a named import from
 * module X?), which the binder produces in single-file mode. The SAME construction path serves both the
 * real source files (via `parseModuleFile`) and synthetic self-check fixtures, so there is no "strong
 * judge on the real file, weak judge in the self-check" split.
 *
 * Known blind spots of this helper (stated so callers do not lean on what it cannot do):
 * - It resolves bindings, not runtime values: it can tell an imported `join` from a shadow `join`, but
 *   it does not evaluate what a function returns. Value-level guarantees must come from a behavioral
 *   test calling the real function.
 * - `findNewExpressions` resolves the constructor callee to a NAME through the shapes a construction can
 *   legitimately take — a bare identifier, a `const BW = BrowserWindow` alias (transitively), a
 *   namespace/qualified member (`electron.BrowserWindow`), a string element-access
 *   (`electron['BrowserWindow']`), and the transparent wrappers (parentheses, and both arms of a
 *   `cond ? A : B` callee) — and matches that name against the set the caller asks for. It matches by
 *   the resolved name, NOT by proving the constructor binds to `electron`: a faked `class BrowserWindow`
 *   in scope, or a namespace member named `BrowserWindow` on some other object, is still enumerated as a
 *   site (that over-inclusion is safe for an isolation allow-list — an extra site only ever adds a check).
 *   What it still cannot see (declared so a future construction does not slip past silently): a subclass
 *   whose `super(...)` is the real construction (`class S extends BrowserWindow { constructor(o){
 *   super(o) } }`), a computed element-access key that is not a string literal (`electron[key]`), and a
 *   callee that is itself a call (`new (getCtor())()`). Consequence if one of those ships: that window's
 *   webPreferences would not be on the scanned allow-list, i.e. it could carry isolation off unseen.
 *   Catching them needs either type-level constructor identity (a resolving Program, which this
 *   single-file no-lib checker deliberately is not) or const-folding an arbitrary expression; both are
 *   disproportionate to the shapes any audited construction here actually uses, which are the ones above.
 */
export interface ParsedModule {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

export function parseModule(source: string, label = '/synthetic/module.ts'): ParsedModule {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === label ? sourceFile : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (name) => name === label,
    readFile: (name) => (name === label ? source : undefined)
  }
  const program = ts.createProgram(
    [label],
    { noResolve: true, noLib: true, target: ts.ScriptTarget.ESNext },
    host
  )
  return { sourceFile, checker: program.getTypeChecker() }
}

/** Parse a real source file on disk under the same single-file checker the synthetic fixtures use. */
export function parseModuleFile(path: string): ParsedModule {
  return parseModule(readFileSync(path, 'utf8'), path)
}

/** The declaration this identifier resolves to. `null` means no declaration is visible in this file. */
export function declarationOf(module: ParsedModule, node: ts.Node): ts.Declaration | null {
  return module.checker.getSymbolAtLocation(node)?.declarations?.[0] ?? null
}

/**
 * If this declaration is a named import, the module specifier it was imported from; otherwise `null`
 * (a local declaration, a same-named shadow, or an unresolved name). This is the discriminator that
 * separates "the real imported symbol" from "a same-named local" — the exact bypass findings 1 and 2
 * describe.
 */
export function importedModuleOf(declaration: ts.Declaration | null): string | null {
  if (declaration === null || !ts.isImportSpecifier(declaration)) return null
  // ImportSpecifier → NamedImports → ImportClause → ImportDeclaration
  const specifier = declaration.parent.parent.parent.moduleSpecifier
  return ts.isStringLiteral(specifier) ? specifier.text : null
}

/** The names named-imported from a given module specifier (an import RELATION, not a text match). */
export function namedImportsFrom(module: ParsedModule, moduleSpecifier: string): string[] {
  const names: string[] = []
  module.sourceFile.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleSpecifier
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text)
      }
    }
  })
  return names
}

/**
 * The NAME the constructor callee of a `new` expression resolves to, folding through the shapes a real
 * construction takes, or `null` if it resolves to none of them. This is what makes `findNewExpressions`
 * a binding-aware scan rather than a text match:
 * - a bare identifier that IS one of the wanted names, OR a `const`-bound alias of one (transitively:
 *   `const A = BrowserWindow; const B = A; new B()`), via the binder;
 * - a property access / namespace member whose member name is wanted (`electron.BrowserWindow`);
 * - a string element-access whose key is wanted (`electron['BrowserWindow']`);
 * - the transparent wrappers: parentheses, and BOTH arms of a conditional callee `new (c ? A : B)()`.
 * `depth` bounds the alias/wrapper recursion so a pathological self-referential source cannot loop.
 */
function resolvedConstructorName(module: ParsedModule, expr: ts.Expression, depth = 0): string | null {
  if (depth > 16) return null
  if (ts.isParenthesizedExpression(expr)) return resolvedConstructorName(module, expr.expression, depth + 1)
  if (ts.isConditionalExpression(expr)) {
    return (
      resolvedConstructorName(module, expr.whenTrue, depth + 1) ??
      resolvedConstructorName(module, expr.whenFalse, depth + 1)
    )
  }
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression
    return ts.isStringLiteralLike(key) ? key.text : null
  }
  if (ts.isIdentifier(expr)) {
    const declaration = declarationOf(module, expr)
    // Follow a local `const alias = <ctor>` binding to what it aliases, so a renamed constructor is
    // resolved to its real name. A named import (or no visible decl) has no initializer to follow, so
    // the identifier's own text is the answer — which is correct for the bare imported constructor.
    if (declaration !== null && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return resolvedConstructorName(module, declaration.initializer, depth + 1)
    }
    return expr.text
  }
  return null
}

/**
 * EVERY `new <ctor>(...)` under `root` whose callee resolves (via {@link resolvedConstructorName}) to one
 * of `ctorNames`. Returning all sites (not the first) is what lets a caller build an allow-list over the
 * whole scan surface — the fix finding 4 needs, since the second/third window is precisely the one a
 * first-only extractor never sees. Passing several names in one call is what lets the scan cover every
 * webContents-bearing constructor (BrowserWindow AND WebContentsView), not just windows.
 */
export function findNewExpressions(module: ParsedModule, ctorNames: readonly string[]): ts.NewExpression[] {
  const wanted = new Set(ctorNames)
  const found: ts.NewExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const name = resolvedConstructorName(module, node.expression)
      if (name !== null && wanted.has(name)) found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return found
}

/** The initializer expression of property `name` in an object literal, or `null` if that key is absent. */
export function propertyInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of obj.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) {
      return property.initializer
    }
  }
  return null
}

/** Is this expression the meta-property `import.meta.dirname`? */
export function isImportMetaDirname(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'dirname' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  )
}
