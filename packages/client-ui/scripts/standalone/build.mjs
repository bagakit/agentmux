import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { radixOverlayAliases } from '../radix-overlay-aliases.ts'
import { standalonePatternDocs, supportedExamples, supportedExportMap } from '../supported-entries.mjs'
import { writeNotices } from './licenses.mjs'

const pkg = resolve(import.meta.dirname, '../..')
const source = join(pkg, 'src')
const require = createRequire(import.meta.url)
const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest')).resolve('vite')).href)
const workspace = supportedExportMap('workspace')
const distribution = supportedExportMap('distribution')
const externals = /^(?:react|react-dom)(?:\/|$)/u
const diagnostics = items => items.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function internal(path, base) {
  const name = relative(base, path)
  return name !== '..' && !name.startsWith('../') && !isAbsolute(name)
}

async function readPackage(name) {
  // Some packages omit package.json from their exports. The installed entry identifies its owning package.
  const entry = require.resolve(name)
  const root = installedPackageRoot(entry)
  assert.ok(root, 'No owning npm package for ' + name)
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
}

function installedPackageRoot(path) {
  return /^(.+\/node_modules\/(?:@[^/]+\/)?[^/]+)\/[^\0?]+$/u.exec(path)?.[1]
}

function emitDeclarations(entries, dist) {
  const configPath = join(pkg, 'tsconfig.build.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.ok(!config.error, config.error && diagnostics([config.error]))
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, pkg, {}, configPath)
  assert.deepEqual(options.errors, [], diagnostics(options.errors))
  const program = ts.createProgram(entries, { ...options.options, outDir: dist, emitDeclarationOnly: true, sourceMap: false })
  for (const input of program.getSourceFiles()) {
    if (!input.isDeclarationFile) assert.ok(internal(input.fileName, source), 'A portable declaration needs a workspace source')
    assert.ok(!/\/node_modules\/@agentmux\//u.test(input.fileName), 'A portable declaration needs a private package')
  }
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, diagnostics(errors))
  const result = program.emit()
  assert.ok(!result.emitSkipped, diagnostics(result.diagnostics))
}

async function declarationDependencies(dist) {
  const dependencies = new Set()
  for (const file of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.d.ts')) continue
    const body = await readFile(join(file.parentPath, file.name), 'utf8')
    for (const { fileName } of ts.preProcessFile(body, true, true).importedFiles) {
      if (fileName.startsWith('.') || externals.test(fileName)) continue
      const name = fileName.split('/').slice(0, fileName.startsWith('@') ? 2 : 1).join('/')
      assert.ok(!name.startsWith('@agentmux/'), 'Private declaration dependency ' + name)
      dependencies.add(name)
    }
  }
  return Object.fromEntries(await Promise.all([...dependencies].sort().map(async name => [name, (await readPackage(name)).version])))
}

async function copyDocumentation(directory) {
  const readme = await readFile(join(pkg, 'README.md'), 'utf8')
  const portable = /^## Portable entries\n([\s\S]*?)^## Workspace modules/mu.exec(readme)?.[1]?.trim()
  assert.ok(portable, 'The package README must contain its portable entry documentation')
  for (const file of [...standalonePatternDocs, 'examples/host.css', ...Object.keys(supportedExamples).map(name => `examples/${name}.tsx`)]) {
    const destination = join(directory, file)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(pkg, file), destination)
  }
  const patternLinks = await Promise.all(standalonePatternDocs.map(async file => {
    const source = await readFile(join(directory, file), 'utf8')
    const title = /^# ([^\n]+)/u.exec(source)?.[1]
    assert.ok(title, 'A standalone pattern must have a title ' + file)
    return `- [${title}](${file})`
  }))
  const sections = [
    '# @agentmux/client-ui',
    'This private archive contains the components and patterns available to a standalone React host. It is intended for local qualification.',
    '## Portable entries',
    portable,
    '## Pattern contracts',
    'The location pattern includes an independent React entry. Reading continuity and interaction receipts describe behaviors an independent host can implement.',
    patternLinks.join('\n'),
    'See [Third-party notices](THIRD_PARTY_NOTICES.md) for bundled material.',
  ]
  await writeFile(join(directory, 'README.md'), sections.join('\n\n') + '\n')
}

export async function stagePortableArchive(directory, { mutateScroll = false } = {}) {
  directory = resolve(directory)
  const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  const dist = join(directory, 'dist')
  const entries = Object.fromEntries(Object.entries(distribution).filter(([, target]) => typeof target === 'object')
    .map(([name, target]) => [target.import.slice('./dist/'.length, -'.js'.length), resolve(pkg, workspace[name].browser)]))
  await mkdir(dist, { recursive: true })
  emitDeclarations(Object.values(entries), dist)
  let scrollMutation
  const outputs = await build({
    configFile: false,
    root: pkg,
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: radixOverlayAliases },
    plugins: mutateScroll ? [{ name: 'break-scroll-document-ownership', enforce: 'pre', transform(code, id) {
      if (!/\/react-remove-scroll-bar\/dist\/[^/]+\/component\.js$/u.test(id)) return
      const declaration = 'var ownerDocument = props.ownerDocument || globalThis.document;'
      assert.equal(code.split(declaration).length, 2, 'Expected the installed per-document scroll lock')
      assert.equal(scrollMutation, undefined, 'One original document-lock implementation must load')
      const altered = code.replace(declaration, 'var ownerDocument = globalThis.document;')
      scrollMutation = { id, originalSHA256: digest(code), alteredSHA256: digest(altered) }
      return altered
    } }] : [],
    build: {
      outDir: dist, emptyOutDir: false, target: 'es2022', minify: false, sourcemap: false,
      lib: { entry: entries, formats: ['es'] },
      rollupOptions: { external: id => externals.test(id), output: {
        entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js'
      } }
    }
  })
  const chunks = (Array.isArray(outputs) ? outputs : [outputs]).flatMap(output => output.output).filter(item => item.type === 'chunk')
  const byPath = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
  for (const chunk of chunks) for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
    assert.ok(byPath.has(dependency) || externals.test(dependency), 'Unbundled private runtime dependency ' + dependency)
  }
  function reaches(entry, destination, seen = new Set()) {
    if (entry === destination) return true
    if (seen.has(entry)) return false
    seen.add(entry)
    return byPath.get(entry)?.imports.some(dependency => reaches(dependency, destination, seen)) ?? false
  }
  const moduleIds = [...new Set(chunks.flatMap(chunk => Object.entries(chunk.modules).filter(([, data]) => data.renderedLength > 0).map(([id]) => id)))].filter(id => !id.startsWith('\0'))
  if (mutateScroll) assert.ok(scrollMutation && moduleIds.includes(scrollMutation.id), 'The archive did not retain the altered scroll lock')
  const packageRoots = new Set()
  for (const id of moduleIds) {
    if (internal(id, source)) continue
    const owner = installedPackageRoot(id)
    assert.ok(owner && internal(owner, resolve(pkg, '../..')) && !/\/node_modules\/@agentmux\//u.test(owner), 'A portable runtime needs an unapproved module')
    packageRoots.add(owner)
  }
  const overlay = {}
  for (const [name, owner] of Object.entries(radixOverlayAliases)) {
    const roots = [...packageRoots].filter(root => root.endsWith('/node_modules/' + name))
    assert.deepEqual(roots, [installedPackageRoot(owner)], 'Overlay requires one resolved ' + name)
    const providers = chunks.filter(chunk => Object.keys(chunk.modules).includes(owner)).map(chunk => chunk.fileName)
    assert.equal(providers.length, 1)
    for (const entry of ['components/Modal.js', 'components/HoverDropdownMenu.js']) {
      assert.ok(reaches(entry, providers[0]), entry + ' must use the shared ' + name)
    }
    overlay[name] = { chunk: providers[0], sha256: digest(await readFile(owner)) }
  }
  for (const [entry, target] of Object.entries(distribution)) {
    if (typeof target !== 'string') continue
    const file = join(directory, target)
    await mkdir(dirname(file), { recursive: true })
    await copyFile(join(pkg, workspace[entry]), file)
  }
  const glyphPath = join(source, 'theme/icon-glyphs.ts')
  assert.ok(moduleIds.includes(glyphPath), 'The archive must attribute its included vector geometry')
  const lucide = installedPackageRoot(require.resolve('lucide-react'))
  assert.equal((await readPackage('lucide-react')).version, '0.468.0', 'Verify the embedded glyph provenance')
  packageRoots.add(lucide)
  const patchDirectory = resolve(pkg, '../../patches')
  const patches = {}
  for (const file of (await readdir(patchDirectory)).filter(name => name.endsWith('.patch'))) {
    const id = file.slice(0, -'.patch'.length).replace('__', '/')
    const separator = id.lastIndexOf('@')
    const packageName = id.slice(0, separator), version = id.slice(separator + 1)
    for (const root of packageRoots) {
      if (!root.endsWith('/node_modules/' + packageName)) continue
      if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version === version) patches[id] = digest(await readFile(join(patchDirectory, file)))
    }
  }
  const provenance = await writeNotices(directory, packageRoots, await readFile(glyphPath), patches)
  await copyDocumentation(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, private: true, type: 'module',
    files: ['dist', 'docs', 'examples', 'THIRD_PARTY_NOTICES.md', 'PROVENANCE.json'],
    exports: distribution, dependencies: await declarationDependencies(dist), peerDependencies: manifest.peerDependencies
  }, null, 2) + '\n')
  return { overlay, provenance, ...(scrollMutation ? { scrollMutation: {
    package: 'react-remove-scroll-bar', originalSHA256: scrollMutation.originalSHA256, alteredSHA256: scrollMutation.alteredSHA256
  } } : {}) }
}
