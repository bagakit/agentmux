import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const require = createRequire(join(root, 'packages/core/package.json'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Private artifacts only. Every AgentMux import is compiled from this candidate. */
export async function buildNoteFileLibraryRecovery(output) {
  output = resolve(output)
  const { build } = require('esbuild'), ts = require('typescript')
  const { bundleIdentityRuntime } = await import(pathToFileURL(join(root, 'packages/identity/scripts/runtime-bundle.mjs')).href)
  const identityRuntime = await bundleIdentityRuntime()
  const packageRoots = Object.fromEntries(['core', 'client-ui', 'layout', 'demand', 'capsule', 'connectors', 'relay', 'identity', 'diagnostic-evidence', 'git']
    .map(name => [name, join(root, 'packages', name)]))
  packageRoots.host = join(root, 'apps/host')
  const manifests = Object.fromEntries(Object.entries(packageRoots).map(([name, path]) => [name, JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))]))
  const sourceFor = specifier => {
    const [name, ...parts] = specifier.slice('@agentmux/'.length).split('/'), base = packageRoots[name]
    assert(base, 'An AgentMux dependency needs an explicit source package: ' + specifier)
    const key = parts.length ? './' + parts.join('/') : '.', exports = manifests[name].exports
    const pattern = Object.keys(exports).filter(item => item.includes('*') && key.startsWith(item.slice(0, -1))).sort((a, b) => b.length - a.length)[0]
    const entry = exports[key] ?? exports[pattern]
    assert(entry, 'No public export for ' + specifier)
    let target = typeof entry === 'string' ? entry : entry.browser ?? entry.import
    if (pattern && !exports[key]) target = target.replace('*', key.slice(pattern.length - 1))
    const candidates = [target.replace(/^\.\/dist\//, './').replace(/\.js$/, '.ts'), target.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts'), target.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.tsx'), target]
    const found = candidates.find(item => !item.startsWith('./dist/') && existsSync(resolve(base, item)))
    assert(found, 'Refusing an old dist dependency: ' + specifier)
    return resolve(base, found)
  }
  const loaded = new Map()
  const plugin = { name: 'candidate-source-and-original-dependencies', setup(builder) {
    builder.onLoad({ filter: /\.(?:[cm]?[tj]sx?|json)$/ }, async args => {
      if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
      const contents = await readFile(args.path, 'utf8'), hash = digest(contents)
      assert(!loaded.has(args.path) || loaded.get(args.path) === hash, 'Source changed while compiling: ' + args.path)
      loaded.set(args.path, hash)
      return { contents, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/.test(args.path) ? 'ts' : 'js' }
    })
    builder.onResolve({ filter: /^@agentmux\/identity\/runtime-source$/ }, () => ({ path: 'identity-runtime-source', namespace: 'original-generated' }))
    builder.onLoad({ filter: /.*/, namespace: 'original-generated' }, () => ({ contents: 'export const identityRuntimeSource = ' + JSON.stringify(identityRuntime.source), loader: 'js' }))
    builder.onResolve({ filter: /^@agentmux\// }, args => ({ path: sourceFor(args.path) }))
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.originalDependency) return
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      const actual = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { originalDependency: true } })
      assert(!actual.errors.length && actual.path, 'Original dependency is unresolved: ' + args.path)
      return { path: actual.path, external: true }
    })
  } }
  await mkdir(join(output, 'renderer/process'), { recursive: true })
  await mkdir(join(output, 'cli/bin'), { recursive: true })
  await mkdir(join(output, 'resources/bin'), { recursive: true })
  await symlink(join(root, 'packages/core/node_modules'), join(output, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  // Core locates its listener asset through its installed package identity.
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@agentmux/core', type: 'module', exports: { '.': './renderer/process/worker.mjs' } }) + '\n')

  // Execute the original Main injection, not a fixture-only parallel wiring.
  const ipcPath = join(root, 'apps/desktop/src/main/ipc.ts'), ipc = await readFile(ipcPath, 'utf8')
  loaded.set(ipcPath, digest(ipc))
  const parsed = ts.createSourceFile(ipcPath, ipc, ts.ScriptTarget.Latest, true), initializers = []
  const visit = node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'publicFiles' && node.initializer) initializers.push(node.initializer); ts.forEachChild(node, visit) }
  visit(parsed)
  assert.equal(initializers.length, 1)
  const expression = initializers[0].getText(parsed)
  assert(ts.isNewExpression(initializers[0]) && initializers[0].expression.getText(parsed) === 'FileReadOwner')
  const adapter = join(output, 'main-public-files.mjs')
  await writeFile(adapter, ts.transpileModule('export default scope => { const { FileReadOwner, noteFileWriter, files, notesStorageOwner, config, spatialState, spatialCatalog, noteSharedBlocks, args } = scope; return ' + expression + '; }', { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText)
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22', plugins: [plugin], metafile: true, logLevel: 'silent' }
  const worker = join(output, 'renderer/process/worker.mjs'), cli = join(output, 'cli/bin/amux')
  const notebookStore = join(output, 'notebook-store.mjs')
  const listener = join(output, 'dist/control-endpoint-listener-worker.js')
  const builds = await Promise.all([
    build({ ...common, entryPoints: [join(root, 'apps/desktop/test/helpers/note-file-library-recovery-worker.ts')], outfile: worker }),
    build({ ...common, entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(output, 'cli/dist/agentmux.js') }),
    build({ ...common, entryPoints: [join(root, 'packages/core/src/notebook-store.ts')], outfile: notebookStore }),
    build({ ...common, entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener })
  ])
  await copyFile(join(root, 'packages/core/bin/amux'), cli); await chmod(cli, 0o755)
  const helper = join(output, 'resources/bin/agentmux-workspace-move')
  const nativeInputs = execFileSync('cc', ['-MM', 'apps/host/native/workspace-move.c'], { cwd: root, encoding: 'utf8' })
    .replace(/\\\r?\n/g, ' ').replace(/^[^:]+:/, '').trim().split(/\s+/).map(path => resolve(root, path))
  for (const path of nativeInputs) loaded.set(path, digest(await readFile(path)))
  execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', join(root, 'apps/host/native/workspace-move.c'), '-o', helper])
  const sourcePaths = new Set([...nativeInputs, ...builds.flatMap(value => Object.keys(value.metafile.inputs).map(path => resolve(root, path)))])
  for (const path of [ipcPath, fileURLToPath(import.meta.url), join(root, 'packages/core/bin/amux'), join(root, 'apps/host/native/workspace-move.c'),
    ...['note-file-library-recovery.test.ts', 'note-file-library-recovery.config.mts', 'note-history-owner.test.ts'].map(path => join(root, 'apps/desktop/test', path)),
    ...Object.values(packageRoots).flatMap(path => ['package.json', 'tsconfig.json'].map(name => join(path, name)).filter(existsSync)),
    ...['package.json', 'tsconfig.base.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json'].map(path => join(root, path)),
    ...['scripts/runtime-bundle.mjs', 'src/runtime-entry.ts', 'src/index.ts'].map(path => join(root, 'packages/identity', path))]) sourcePaths.add(path)
  const inputs = Object.fromEntries(await Promise.all([...sourcePaths].filter(path => /^(?:apps\/|packages\/|package\.json$|tsconfig\.base\.json$)/.test(relative(root, path)) && !path.includes('/node_modules/')).sort().map(async path => {
    const current = digest(await readFile(path))
    assert(!loaded.has(path) || loaded.get(path) === current, 'Candidate changed before build receipt: ' + path)
    return [relative(root, path), current]
  })))
  assert(Object.keys(inputs).every(path => !path.includes('/dist/')), 'Candidate source may not transitively consume workspace dist')
  const artifacts = Object.fromEntries(await Promise.all([worker, cli, join(output, 'cli/dist/agentmux.js'), helper, adapter, notebookStore, listener, join(output, 'package.json')].map(async path => [relative(output, path), digest(await readFile(path))])))
  const manifest = { schema: 'agentmux.note-file-library-build.v1', root, output, inputs, artifacts, mainInjection: { source: 'apps/desktop/src/main/ipc.ts', sha256: inputs['apps/desktop/src/main/ipc.ts'], expressionSha256: digest(expression) } }
  await writeFile(join(output, 'build.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { worker, cli, helper, adapter, notebookStore, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Give an owned private output directory.')
  const result = await buildNoteFileLibraryRecovery(process.argv[2])
  console.log(JSON.stringify({ status: 'compiled-only', worker: result.worker, cli: result.cli, sourceCount: Object.keys(result.manifest.inputs).length }))
}
