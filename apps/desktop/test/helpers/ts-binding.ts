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
 * - `findNewExpressions` matches by constructor identifier text only; it does not verify the constructor
 *   itself binds to a given module. A faked `class BrowserWindow` in scope would be enumerated as a site
 *   (that is a different exploit than the four findings here). Conversely, a construction that hides the
 *   name — `const BW = BrowserWindow; new BW(...)`, or `new electron.BrowserWindow(...)` via a namespace
 *   import — is NOT matched and therefore NOT checked. Callers relying on this for an exhaustive scan
 *   must accept that renamed/qualified constructors are a blind spot.
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
 * EVERY `new <ctorName>(...)` under `root`. Returning all sites (not the first) is what lets a caller
 * build an allow-list over the whole scan surface — the fix finding 4 needs, since the second
 * BrowserWindow is precisely the one a first-only extractor never sees.
 */
export function findNewExpressions(root: ts.Node, ctorName: string): ts.NewExpression[] {
  const found: ts.NewExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ctorName) {
      found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
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
