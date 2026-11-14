import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import ts from 'typescript'
import { runProbeProcess } from '../../../apps/desktop/scripts/probe-process.mjs'
import { supportedExamples, supportedExportMap, verifyWorkspaceExportMap } from './supported-entries.mjs'

const pkg = resolve(import.meta.dirname, '..')
const root = resolve(pkg, '../..')
const scratch = join(root, '.tmp/client-ui-supported-entries', 'run-' + randomUUID())
const buildDir = join(scratch, 'browser')
const manifestFile = join(pkg, 'package.json')
const manifestBytes = await readFile(manifestFile)
const manifest = JSON.parse(manifestBytes)
const require = createRequire(import.meta.url)
const vite = createRequire(require.resolve('vitest')).resolve('vite')
const { build, version: esbuild } = createRequire(vite)('esbuild')

const workspace = supportedExportMap('workspace')
const distribution = supportedExportMap('distribution')
const forbidden = /(?:^|\/)(?:apps\/|packages\/(?!client-ui\/)[^/]+\/|node_modules\/(?:@tiptap\/|@xterm\/|@agentmux\/(?!client-ui\/))|client-ui\/(?:src|dist)\/(?:note|terminal)\/|client-ui\/(?:src|dist)\/platform\.)/
const receipt = {
  environment: { node: process.versions.node, esbuild, target: 'Chromium', minified: true, css: 'local public styles' },
  sources: {}, entries: {}, node: {}, mutations: {}, chromium: null, passed: false
}
const iconConsumers = { feedback: 'components/InlineRenameField.tsx', locations: 'patterns/agent-work-location.tsx' }
const bundleOptions = { absWorkingDir: root, jsx: 'automatic', bundle: true, metafile: true, logLevel: 'silent',
  platform: 'browser', format: 'esm', minify: true, define: { 'process.env.NODE_ENV': '"production"' } }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const load = file => readFile(resolve(pkg, file))

function verifyTypes(files, distOnly, edit) {
  const options = {
    noEmit: true, strict: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [],
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  }
  const host = ts.createCompilerHost(options)
  const read = host.readFile.bind(host)
  host.readFile = file => {
    const source = read(file)
    if (distOnly && file === manifestFile) return JSON.stringify({ ...manifest, exports: distribution })
    return file === edit?.file ? source + edit.suffix : source
  }
  const program = ts.createProgram(files, options, host)
  const graph = program.getSourceFiles().map(file => relative(root, file.fileName))
  const prohibited = graph.filter(file => forbidden.test(file))
  assert.deepEqual(prohibited, [], 'Public declaration graph reached a private owner')
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n'
  }))
  return new Set(graph.filter(path => path.startsWith('packages/client-ui/')))
}

function verifyIconRenderingLeaf(inputs) {
  assert.ok(inputs.some(file => file.endsWith('/theme/semantic-icon.tsx')))
  assert.ok(!inputs.some(file => /\/theme\/(?:icon-sprite|icon-assets|theme-catalog|schema)\.ts$/.test(file)),
    'Rendering a glyph should use the host sprite and omit its catalog')
}

await mkdir(buildDir, { recursive: true })
try {
  verifyWorkspaceExportMap(manifest.exports)
  const evidenceSources = ['scripts/supported-entries.mjs', 'scripts/verify-supported-entries.mjs',
    'scripts/supported-entries-electron.cjs', 'examples/host.css']
  receipt.sources = Object.fromEntries(await Promise.all(evidenceSources.map(async file => [file, sha(await load(file))])))
  receipt.sources['package.json'] = sha(manifestBytes)
  const names = Object.keys(supportedExamples)
  assert.ok(names.length > 0, 'A reusable entry must have a runnable example')
  const files = names.map(name => resolve(pkg, 'examples', name + '.tsx'))
  const sourceTypes = verifyTypes(files, false)
  const publishedTypes = verifyTypes(files, true)
  for (const [name, family] of Object.entries(supportedExamples)) {
    for (const entry of Object.keys(family.entries)) {
      assert.ok(sourceTypes.has(relative(root, resolve(pkg, workspace[entry].types))), 'Actual source declaration consumer omitted ' + entry)
      assert.ok(publishedTypes.has(relative(root, resolve(pkg, distribution[entry].types))), 'Actual compiled declaration consumer omitted ' + entry)
      const entryUrl = import.meta.resolve('@agentmux/client-ui' + entry.slice(1))
      assert.equal(entryUrl, pathToFileURL(resolve(pkg, distribution[entry].import)).href)
      const exported = await import(entryUrl)
      assert.ok(Object.keys(exported).length > 0, 'Node entry must load original code for ' + entry)
      receipt.node[entry] = { symbols: Object.keys(exported).length, compiled: sha(await load(distribution[entry].import)) }
    }
    for (const entry of family.styles) {
      const original = await load(workspace[entry])
      assert.ok(original.byteLength > 0, 'Public CSS is nonempty for ' + entry)
      assert.deepEqual(await load(distribution[entry]), original, 'Compiled CSS matches its public owner for ' + entry)
    }
    const source = 'import { createRoot } from "react-dom/client"; import Example from "./examples/' + name +
      '.tsx"; createRoot(document.getElementById("app")).render(<Example />)'
    const options = { ...bundleOptions, stdin: { contents: source, loader: 'tsx', resolveDir: pkg },
      outfile: join(buildDir, name + '.js') }
    const output = await build(options)
    const inputs = Object.keys(output.metafile.inputs)
    assert.deepEqual(inputs.filter(file => forbidden.test(file)), [], 'Public browser runtime reached a private owner')
    for (const entry of Object.keys(family.entries)) {
      assert.ok(inputs.includes(relative(root, resolve(pkg, workspace[entry].browser))), 'Example loads actual browser entry ' + entry)
    }
    for (const entry of family.styles) {
      assert.ok(inputs.includes(relative(root, resolve(pkg, workspace[entry]))), 'Example loads actual local stylesheet ' + entry)
    }
    assert.ok(inputs.some(input => input.endsWith('/examples/' + name + '.tsx')))
    const keys = Object.values(output.metafile.outputs)
    const implementedJs = await readFile(options.outfile)
    const entryReceipt = { browserSources: inputs.filter(input => input.startsWith('packages/client-ui/')),
      jsBytes: keys.find(file => file.entryPoint)?.bytes, gzipJsBytes: gzipSync(implementedJs).byteLength,
      jsSHA256: sha(implementedJs), exampleSHA256: sha(await load('examples/' + name + '.tsx')),
      cssBytes: keys.find(file => !file.entryPoint)?.bytes }
    assert.ok(entryReceipt.jsBytes > 0 && entryReceipt.cssBytes > 0)
    if (iconConsumers[name]) {
      verifyIconRenderingLeaf(inputs)
      const consumer = resolve(pkg, 'src', iconConsumers[name])
      const original = await readFile(consumer, 'utf8')
      const catalogImport = original.replace('../theme/semantic-icon.js', '../theme/icons.js')
      assert.notEqual(original, catalogImport)
      const previous = await build({ ...options, write: false, plugins: [{ name: 'full-icon-catalog', setup(plugin) {
        plugin.onLoad({ filter: /\.tsx$/ }, args => args.path === consumer
          ? { contents: catalogImport, loader: 'tsx' } : undefined)
      } }] })
      const previousInputs = Object.keys(previous.metafile.inputs)
      assert.throws(() => verifyIconRenderingLeaf(previousInputs), /Rendering a glyph should use the host sprite/)
      const previousJs = previous.outputFiles.find(file => file.path === options.outfile).contents
      entryReceipt.catalogImport = { baselineJsBytes: previousJs.byteLength,
        baselineGzipJsBytes: gzipSync(previousJs).byteLength, source: relative(root, consumer),
        originalSHA256: sha(original), loadedSHA256: sha(catalogImport) }
      assert.ok(entryReceipt.catalogImport.baselineGzipJsBytes > entryReceipt.gzipJsBytes)
      receipt.mutations[name + '-icon-catalog'] = 'real entry import restored the omitted catalog in its browser graph'
    }
    receipt.entries[name] = entryReceipt
    await writeFile(join(buildDir, name + '.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="stylesheet" href="./foundation.css"><link rel="stylesheet" href="./host.css">' +
      '<link rel="stylesheet" href="./' + name + '.css">' +
      '<div id="app"></div>' + (name === 'theme' ? '' : '<script type="module" src="./host-theme.js"></script>') +
      '<script type="module" src="./' + name + '.js"></script></html>')
  }
  await writeFile(join(buildDir, 'foundation.css'), await load(distribution['./styles/palette.css']))
  await writeFile(join(buildDir, 'theme-defaults.css'), await load(distribution['./styles/theme-defaults.css']))
  await writeFile(join(buildDir, 'host.css'), await load('examples/host.css'))
  await build({ ...bundleOptions, stdin: { loader: 'js', resolveDir: pkg, contents:
    'import { mountThemeRuntime, updateThemeSelection } from "@agentmux/client-ui/theme"; ' +
    'mountThemeRuntime(window); window.selectExampleAppearance = appearance => updateThemeSelection({appAppearance:appearance});' },
    outfile: join(buildDir, 'host-theme.js') })

  const { resolveTheme } = await import('@agentmux/client-ui/theme/model')
  assert.equal(resolveTheme({ appAppearance: 'system' }, false).mode, 'light')
  assert.equal(resolveTheme({ appAppearance: 'system' }, true).mode, 'dark')
  assert.equal(typeof globalThis.document, 'undefined', 'Node theme model loads without a document')

  const noCss = { ...manifest.exports }
  delete noCss['./styles/buttons.css']
  assert.throws(() => verifyWorkspaceExportMap(noCss), /Missing or different exact export \.\/styles\/buttons.css/)
  receipt.mutations['missing-css'] = 'exact style export rejected even with workspace wildcard'
  assert.throws(() => verifyWorkspaceExportMap({}), /Workspace export set cannot be empty/)
  receipt.mutations['empty-exports'] = 'empty export set rejected'
  const buttonTypes = resolve(pkg, distribution['./components/Button'].types)
  for (const [name, dependency] of [
    ['core-in-action', "import('@agentmux/core').AgentProviderId"],
    ['app-in-action', "import('../../../../apps/mobile/src/navigation/home-preference.js').MobileHome"]
  ]) {
    assert.throws(() => verifyTypes([files[0]], true, {
      file: buttonTypes, suffix: '\nexport type InjectedDeepDependency = ' + dependency + '\n'
    }), /Public declaration graph reached a private owner/)
    receipt.mutations[name] = 'private type reached in the actual compiled action graph'
  }

  const desktop = createRequire(resolve(root, 'apps/desktop/package.json'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const argumentsForProcess = [resolve(import.meta.dirname, 'supported-entries-electron.cjs'), scratch, ...names]
  receipt.process = await runProbeProcess(desktop('electron'), argumentsForProcess, { cwd: root, env, timeoutMs: 30000 })
  assert.equal(receipt.process.exitConfirmed, true, 'Private browser process exit is confirmed')
  receipt.chromium = JSON.parse(await readFile(join(scratch, 'browser-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, receipt.chromium.error)
  assert.deepEqual(Object.keys(receipt.chromium.cases), names)
  receipt.passed = true
} catch (error) {
  receipt.error = error.message
  process.exitCode = 1
} finally {
  if (!receipt.process || receipt.process.exitConfirmed) {
    await rm(buildDir, { recursive: true, force: true })
    await rm(join(scratch, 'profile'), { recursive: true, force: true })
  }
  await writeFile(join(scratch, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, join(scratch, 'receipt.json')), error: receipt.error }))
}
