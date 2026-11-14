import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { candidateResolve } from '../../candidate-package-resolve.mjs'

export const flows = ['survey-browser-creation', 'survey-system-page', 'survey-profile-binding'].map(name =>
  'apps/desktop/src/renderer/src/lib/' + name + '.ts')
export const hash = value => createHash('sha256').update(value).digest('hex')
export function exactMutation(root, file, before, after) {
  const source = readFileSync(resolve(root, file), 'utf8')
  assert.equal(source.split(before).length, 2, 'One exact production anchor required: ' + file)
  return { file, before, after, sourceSHA256: hash(source), loadedSHA256: hash(source.replace(before, after)) }
}

/** Structural proof only. Type-only dependencies on the original AppState remain legal. */
export function checkRuntimeBoundary(root, mutation) {
  const ts = createRequire(resolve(root, 'apps/desktop/package.json'))('typescript'), loaded = [], violations = []
  for (const file of flows) {
    const original = readFileSync(resolve(root, file), 'utf8'), code = mutation?.file === file ? original.replace(mutation.before, mutation.after) : original
    loaded.push({ file, sourceSHA256: hash(original), loadedSHA256: hash(code) })
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
    function runtimeTarget(value) {
      if (!value || !ts.isStringLiteralLike(value)) return
      const target = ts.resolveModuleName(value.text, resolve(root, file), { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule?.resolvedFileName
      if (target && resolve(target) === resolve(root, 'apps/desktop/src/renderer/src/store.ts')) violations.push({ file, specifier: value.text })
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause, named = clause?.namedBindings
        if (!clause || !clause.isTypeOnly && (clause.name || !named || !ts.isNamedImports(named) || named.elements.some(item => !item.isTypeOnly))) runtimeTarget(node.moduleSpecifier)
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly))) runtimeTarget(node.moduleSpecifier)
      else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) runtimeTarget(node.moduleReference.expression)
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) runtimeTarget(node.arguments[0])
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { classification: 'runtime-module-structure', loaded, violations }
}

/** Compile the actual contracts and their negative consumer; unrelated Store diagnostics stay separate. */
export function checkTypes(root, mutation, exposeNegativeCases = false, identityRuntime) {
  const ts = createRequire(resolve(root, 'apps/desktop/package.json'))('typescript')
  const fixture = 'apps/desktop/test/fixtures/survey-opening-capabilities.ts'
  const originalFixture = readFileSync(resolve(root, fixture), 'utf8')
  const negativeCases = originalFixture.match(/@ts-expect-error/gu)?.length ?? 0
  assert.ok(negativeCases >= 5, 'Real capability negative cases must be nonempty')
  const configPath = resolve(root, 'apps/desktop/tsconfig.test.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  const options = { ...parsed.options, noEmit: true, declaration: false, incremental: false }
  const host = ts.createCompilerHost(options), loaded = []
  host.getSourceFile = (file, languageVersion) => {
    const original = ts.sys.readFile(file)
    if (original === undefined) return undefined
    const name = relative(root, file)
    let code = mutation?.file === name ? original.replace(mutation.before, mutation.after) : original
    if (exposeNegativeCases && name === fixture) code = code.replace(/\/\/ @ts-expect-error[^\n]*/gu, '')
    if ([...flows, fixture].includes(name) || file === identityRuntime) loaded.push({ file: name, sourceSHA256: hash(original), loadedSHA256: hash(code) })
    return ts.createSourceFile(file, code, languageVersion, true)
  }
  const candidates = new Map()
  host.resolveModuleNames = (names, containing) => names.map(name => {
    if (name === '@agentmux/identity/runtime-source') {
      assert.ok(identityRuntime, 'A privately generated current identity module is required')
      return { resolvedFileName: identityRuntime, isExternalLibraryImport: false }
    }
    if (!name.startsWith('@agentmux/')) return ts.resolveModuleName(name, containing, options, host).resolvedModule
    if (!candidates.has(name)) candidates.set(name, candidateResolve(root, name, { source: true, types: true }))
    const file = candidates.get(name)
    // Vite's existing ambient asset declarations own CSS/images, not the TS parser.
    return /\.(?:[cm]?[jt]sx?|json)$/u.test(file) ? { resolvedFileName: file, isExternalLibraryImport: false } : undefined
  })
  const program = ts.createProgram([resolve(root, fixture), resolve(root, 'apps/desktop/src/renderer/src/global.d.ts')], options, host)
  const firstPartyFiles = program.getSourceFiles().map(source => relative(root, source.fileName)).filter(file => file.startsWith('packages/'))
  assert.ok(firstPartyFiles.length > 0 && !firstPartyFiles.some(file => /^packages\/[^/]+\/dist\//u.test(file)), 'TypeScript must consume first-party Source, not dist')
  assert.ok(program.getSourceFile(identityRuntime), 'TypeScript must consume the same fresh identity module')
  const scoped = [fixture, ...flows], format = diagnostic => ({ file: diagnostic.file ? relative(root, diagnostic.file.fileName) : null,
    code: diagnostic.code, line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })
  const diagnostics = scoped.flatMap(file => {
    const source = program.getSourceFile(resolve(root, file)); assert.ok(source, 'Actual TypeScript consumer not loaded: ' + file)
    return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map(format)
  })
  const store = program.getSourceFile(resolve(root, 'apps/desktop/src/renderer/src/store.ts'))
  const unrelatedStoreDiagnostics = store ? program.getSemanticDiagnostics(store).map(format) : []
  return { classification: 'scoped-typescript-contract', negativeCases, diagnostics, unrelatedStoreDiagnostics, loaded, firstPartyFiles }
}
