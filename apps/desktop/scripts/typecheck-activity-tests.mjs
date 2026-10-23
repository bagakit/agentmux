import assert from 'node:assert/strict'
import { readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { candidateResolve } from './candidate-package-resolve.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/components/ActivityView.tsx'

function testConfiguration(root) {
  const config = resolve(root, 'apps/desktop/tsconfig.test.json')
  const raw = ts.readConfigFile(config, ts.sys.readFile)
  assert.equal(raw.error, undefined, 'Read original Desktop test compiler configuration')
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(config), {}, config)
  assert.deepEqual(parsed.errors, [], 'Parse original Desktop test compiler options')
  return parsed
}

/** Discover actual imports, including aliases, dynamic imports and test-helper callers. */
export function activityTestFiles(root = repository) {
  const files = []
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/\.(?:ts|tsx|mts)$/u.test(entry.name)) files.push(path)
    }
  }
  scan(resolve(root, 'apps/desktop/test'))
  scan(resolve(root, 'packages/client-ui/test'))
  const known = new Set(files), dependencies = new Map()
  const options = testConfiguration(root).options
  const cache = ts.createModuleResolutionCache(root, file => file, options)
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = new Set()
    function visit(node) {
      const literal = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      if (literal && ts.isStringLiteral(literal)) {
        const target = ts.resolveModuleName(literal.text, file, options, ts.sys, cache).resolvedModule?.resolvedFileName
        if (target) imports.add(target)
      }
      ts.forEachChild(node, visit)
    }
    visit(source); dependencies.set(file, imports)
  }
  const selected = new Set([resolve(root, owner)])
  let changed
  do {
    changed = false
    for (const [file, imports] of dependencies) if (!selected.has(file) && [...imports].some(target => selected.has(target))) {
      selected.add(file); changed = true
    }
  } while (changed)
  const result = [...selected].filter(file => known.has(file)).sort()
  assert.ok(result.length > 0, 'Actual Activity test callers must be nonempty')
  return result
}

/** Same strict test options, narrowed roots; all diagnostics of this original program count. */
export function checkActivityTests(root = repository) {
  root = realpathSync(root)
  const parsed = testConfiguration(root)
  const roots = activityTestFiles(root)
  const testRoots = roots.length
  for (const file of parsed.fileNames) if (/\.d\.[cm]?ts$/u.test(file) && !roots.includes(file)) roots.push(file)
  const options = { ...parsed.options, noEmit: true, incremental: false }
  const host = ts.createCompilerHost(options), resolutions = new Map(), manifests = new Map()
  host.resolveModuleNames = (names, containingFile) => names.map(specifier => {
    if (!specifier.startsWith('@agentmux/')) return ts.resolveModuleName(specifier, containingFile, options, ts.sys).resolvedModule
    const file = candidateResolve(root, specifier, { types: true,
      onManifest: (path, bytes) => manifests.set(relative(root, path), bytes.toString()) })
    assert.ok(realpathSync(file).startsWith(root + '/'), 'Actual first-party test signature belongs to this checkout')
    resolutions.set(specifier, relative(root, file))
    // Vite's existing wildcard declarations type assets; CSS is not a TypeScript source file.
    if (file.endsWith('.css')) return undefined
    const extension = file.endsWith('.d.mts') ? ts.Extension.Dmts : file.endsWith('.mts') ? ts.Extension.Mts
      : file.endsWith('.d.ts') ? ts.Extension.Dts : file.endsWith('.tsx') ? ts.Extension.Tsx
        : extname(file) === '.mjs' ? ts.Extension.Mjs : ts.Extension.Ts
    return { resolvedFileName: file, extension, isExternalLibraryImport: false }
  })
  const program = ts.createProgram(roots, options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  return { roots, testRoots, diagnostics, program, resolutions, manifests }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = checkActivityTests()
  if (result.diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
    getCurrentDirectory: () => repository, getCanonicalFileName: file => file, getNewLine: () => '\n'
  }))
  process.stdout.write(JSON.stringify({ testRoots: result.testRoots, sourceFiles: result.program.getSourceFiles().length,
    firstPartyExports: result.resolutions.size, manifests: result.manifests.size, diagnostics: result.diagnostics.length }) + '\n')
  if (result.diagnostics.length) process.exitCode = 1
}
