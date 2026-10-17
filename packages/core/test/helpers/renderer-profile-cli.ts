import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { transform } from 'esbuild'
import ts from 'typescript'
export { build } from 'esbuild'

/** Emit the actual reachable CLI as separate ESM files, matching Core's published src/dist layout. */
export async function compileRendererProfileCli(root: string, directory: string, frozen: Record<string, string>, loaded?: string): Promise<string> {
  const core = join(root, 'packages/core'), sourceRoot = join(core, 'src'), packageRoot = join(directory, 'cli-core')
  const entry = join(packageRoot, 'dist/agentmux.js'), compilationReads: Record<string, string> = {}
  const outputFiles: Record<string, { sha256: string; bytes: number }> = {}
  const modules: Array<{ source: string; output: string; imports: string[] }> = [], pending = [{ source: join(sourceRoot, 'agentmux.ts'), output: entry }]
  const emitted = new Map<string, string>(), hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  await mkdir(packageRoot)
  await symlink(join(core, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  const inside = (parent: string, path: string) => { const part = relative(parent, path); return part !== '..' && !part.startsWith('../') && !part.startsWith('/') }
  async function sourceBytes(path: string) {
    const name = relative(root, path), contents = frozen[name] ?? await readFile(path, 'utf8')
    compilationReads[name] = hash(contents)
    if (loaded) appendFileSync(loaded, JSON.stringify({ path: name, sha256: compilationReads[name], kind: 'cli-compiled-source' }) + '\n')
    return contents
  }
  async function output(path: string, contents: string) {
    if (!inside(packageRoot, path)) throw new Error('CLI emitted dependency escapes its private package: ' + path)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents)
    outputFiles[relative(directory, path)] = { sha256: hash(contents), bytes: Buffer.byteLength(contents) }
  }
  // The exact package type/exports and original JSON assets retain their original relative locations.
  await output(join(packageRoot, 'package.json'), await sourceBytes(join(core, 'package.json')))
  async function localSource(path: string) {
    const extension = extname(path), candidates = extension === '.js' ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx', path] :
      extension === '.mjs' ? [path.slice(0, -4) + '.mts', path] : extension === '.cjs' ? [path.slice(0, -4) + '.cts', path] : [path]
    for (const candidate of candidates) {
      if (!inside(core, candidate)) throw new Error('CLI local dependency escapes Core: ' + candidate)
      if (Object.hasOwn(frozen, relative(root, candidate))) return candidate
      try { if ((await stat(candidate)).isFile()) return candidate } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    throw new Error('Missing original CLI module or asset: ' + path)
  }
  while (pending.length) {
    const { source, output: destination } = pending.shift()!
    const prior = emitted.get(destination)
    if (prior) { if (prior !== source) throw new Error('Ambiguous CLI module output: ' + destination); continue }
    emitted.set(destination, source)
    const original = await sourceBytes(source), extension = extname(source)
    if (extension === '.json') { await output(destination, original); continue }
    if (!/\.[cm]?[jt]sx?$/.test(extension)) throw new Error('Unsupported original CLI asset: ' + source)
    const loader = extension.endsWith('tsx') ? 'tsx' : extension === '.ts' || extension === '.mts' || extension === '.cts' ? 'ts' : 'js'
    const result = await transform(original, { loader, format: 'esm', target: 'node24', sourcefile: source })
    await output(destination, result.code)
    const ast = ts.createSourceFile(destination, result.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), imports: string[] = []
    const edges: string[] = []
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) edges.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) edges.push(node.arguments[0].text)
      // Worker/JSON URLs are real emitted assets, not imports that may be silently externalized.
      if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL' && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[1]?.getText(ast) === 'import.meta.url' && /\.(?:[cm]?js|json)$/.test(node.arguments[0].text)) edges.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const specifier of new Set(edges)) {
      imports.push(specifier)
      if (!specifier.startsWith('.')) continue // Original package imports resolve through this WT's own Core dependencies.
      const dependency = await localSource(resolve(dirname(source), specifier))
      pending.push({ source: dependency, output: resolve(dirname(destination), specifier) })
    }
    modules.push({ source: relative(root, source), output: relative(directory, destination), imports })
  }
  await writeFile(join(directory, 'compilation.json'), JSON.stringify({ sourceReads: compilationReads,
    emission: 'esbuild-single-module-esm', bundled: false, modules, outputFiles,
    compiledEntry: entry, compiledSha256: hash(await readFile(entry)), nativeOrApp: false }))
  return entry
}
