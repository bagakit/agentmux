import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat, statfs, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
// Match Vite's build CLI before the in-memory config runner creates its server.
process.env.NODE_ENV = 'production'
const require = createRequire(join(desktop, 'package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = require('electron'), fixture = join(import.meta.dirname, 'fixtures/renderer-react-singleton')
const output = join(root, '.tmp/renderer-react-singleton')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), inputs = new Map()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.renderer-react-singleton.v1', attempt, qualified: false, sourceStable: false,
  configurations: [], inputs: {}, resource: {}, scope: {
    originalAppOrRuntimeTouched: false, installationQualified: false,
    actual: 'Production Vite configurations, installed byte-identical dependencies, original Menu/Dialog consumers and sandboxed private Electron browser',
    controlled: 'External absolute entry and symlinked component package dependency roots; only removal of dedupe is the semantic mutant',
    historicalPhysicalImportPath: 'unknown: the reported installed bundle did not retain its original source map' } }
const owned = ['apps/desktop/electron.vite.config.ts', 'apps/desktop/vite.web.config.ts', 'apps/desktop/vite.gallery.config.ts',
  'apps/desktop/scripts/verify-renderer-react-singleton.mjs',
  'apps/desktop/scripts/fixtures/renderer-react-singleton/entry.tsx',
  'apps/desktop/scripts/fixtures/renderer-react-singleton/main.cjs']
const configs = [
  ['electron', 'apps/desktop/electron.vite.config.ts'], ['web', 'apps/desktop/vite.web.config.ts'], ['gallery', 'apps/desktop/vite.gallery.config.ts']
].filter(([name]) => !process.argv.includes('--electron-only') || name === 'electron')
receipt.scope.selectedConfigurations = configs.map(([name]) => name)
async function bind(path) {
  const absolute = resolve(path), hash = sha(await readFile(absolute))
  if (inputs.has(absolute)) assert.equal(inputs.get(absolute), hash, 'Consumed input changed')
  inputs.set(absolute, hash)
}
async function available() { const facts = await statfs(root); return facts.bavail * facts.bsize }
async function resourceGuard() {
  // Harness reserve only, never a product disk quota or a qualification oracle.
  assert.ok(await available() > 128 * 1024 * 1024, 'Insufficient shared disk space for the bounded private browser fixture')
}
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) result.push(...await files(path))
    else if (item.isFile()) result.push(path)
  }
  return result
}
async function packageRoot(entry) {
  let directory = dirname(await realpath(entry))
  while (directory !== dirname(directory)) {
    try { const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); return { directory, pkg } } catch {}
    directory = dirname(directory)
  }
  throw new Error('Actual dependency package metadata missing: ' + entry)
}
async function cloneDependency(name, resolver, foreignModules) {
  const source = await packageRoot(resolver.resolve(name)), destination = join(foreignModules, name)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source.directory, destination, { recursive: true, dereference: false })
  const entries = await files(source.directory)
  for (const original of entries) {
    const copy = join(destination, relative(source.directory, original))
    const bytes = await readFile(original)
    assert.deepEqual(await readFile(copy), bytes, 'Foreign dependency must retain exact installed bytes')
    await bind(original); await bind(copy)
  }
  return { name, version: source.pkg.version, original: source.directory, copy: destination,
    files: entries.length, bytes: (await Promise.all(entries.map(path => stat(path)))).reduce((sum, item) => sum + item.size, 0) }
}
function runBrowser(directory, evidence, userData, variant) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolveRun, reject) => {
    const child = spawn(electron, ['--disable-gpu', '--disable-breakpad', join(fixture, 'main.cjs'), directory, evidence, userData, variant],
      { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => {
      timedOut = true
      // Only the process group created by this exact private invocation is signalled.
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') reject(error) }
    }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut, stdout, stderr }) })
  })
}
function aliasRows(alias) { return Array.isArray(alias) ? [...alias] : Object.entries(alias ?? {}).map(([find, replacement]) => ({ find, replacement })) }
try {
  receipt.resource.beforeBytes = await available()
  await resourceGuard()
  for (const path of owned) await bind(join(root, path))
  await bind(electron); await bind(require.resolve('vite')); await bind(require.resolve('electron/package.json'))
  const foreign = join(attempt, 'foreign'), foreignModules = join(foreign, 'node_modules')
  await mkdir(foreignModules, { recursive: true })
  const contextResolver = createRequire(require.resolve('@radix-ui/react-dialog'))
  receipt.dependencies = []
  for (const [name, resolver] of [['react', require], ['react-dom', require], ['@radix-ui/react-context', contextResolver]]) {
    receipt.dependencies.push(await cloneDependency(name, resolver, foreignModules))
  }
  for (const dependency of receipt.dependencies) {
    assert.equal(typeof dependency.version, 'string')
    assert.ok(dependency.version.length > 0, 'Actual installed dependency version must be nonempty')
  }
  const foreignRequire = createRequire(join(foreign, 'package.json'))
  const absoluteContext = foreignRequire.resolve('@radix-ui/react-context').replace(/\.js$/u, '.mjs')
  await stat(absoluteContext)
  const linked = join(foreign, 'packages/linked-overlay'), link = join(attempt, 'linked-node-modules/linked-overlay')
  await mkdir(linked, { recursive: true }); await mkdir(dirname(link), { recursive: true })
  await writeFile(join(linked, 'package.json'), '{"name":"private-linked-overlay","type":"module","exports":"./index.mjs"}\n')
  await writeFile(join(linked, 'index.mjs'), [
    'import * as React from "react"', 'import {createPortal,version} from "react-dom"',
    'import {createContext} from "@radix-ui/react-context"', 'const [Boundary]=createContext("LinkedDependency")',
    'export const dependencyReact=React,dependencyPortal=createPortal,dependencyDomVersion=version',
    'export function LinkedBoundary({children}){return React.createElement(Boundary,{owner:"linked-package"},children)}'
  ].join('\n') + '\n')
  await symlink(linked, link, 'dir'); assert.equal(await realpath(link), linked)
  for (const path of [join(linked, 'package.json'), join(linked, 'index.mjs')]) await bind(path)
  const workspaceAliases = [
    { find: '@agentmux/layout', replacement: join(root, 'packages/layout/src/index.ts') },
    { find: '@agentmux/core/spatial-layout', replacement: join(root, 'packages/core/src/spatial-layout.ts') }
  ]
  for (const path of ['packages/layout/package.json', 'packages/core/package.json']) await bind(join(root, path))
  for (const [name, path] of configs) {
    await resourceGuard()
    const previousDirectory = process.cwd()
    let loaded
    try {
      // The official runner loader avoids .vite-temp writes through borrowed node_modules.
      process.chdir(attempt)
      loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(root, path), desktop, 'silent', undefined, 'runner')
    } finally { process.chdir(previousDirectory) }
    assert.ok(loaded)
    for (const dependency of loaded.dependencies) await bind(dependency)
    const actual = name === 'electron' ? loaded.config.renderer : loaded.config
    assert.ok(actual.resolve.dedupe.includes('react') && actual.resolve.dedupe.includes('react-dom'), 'Actual production configuration must provide both singleton owners')
    const originalAliases = aliasRows(actual.resolve.alias)
    assert.ok(originalAliases.length > 0, 'Original Radix ownership aliases must remain nonempty')
    const plugins = (actual.plugins ?? []).flat(Infinity).filter(Boolean).map(plugin => {
      if (!['agentmux-pdfjs-viewer-assets', 'agentmux-file-diagram-assets'].includes(plugin.name)) return plugin
      const copy = { ...plugin }; delete copy.writeBundle; return copy
    })
    const configuration = { name, path, originalResolve: actual.resolve,
      privateResourceCropping: ['only PDF/diagram writeBundle copy hooks disabled; other plugin hooks retained', 'private fixture entry/outDir/cacheDir/base and no publicDir copy', 'library fixture NODE_ENV explicitly production, matching the normal production HTML build'],
      variants: [] }
    receipt.configurations.push(configuration)
    for (const variant of ['candidate', 'without-dedupe']) {
      await resourceGuard()
      const directory = join(attempt, name + '-' + variant)
      const moduleIds = new Set()
      const collector = { name: 'fixture-exact-consumed-source', async generateBundle() {
        for (const id of this.getModuleIds()) {
          if (id.startsWith('\0')) continue
          const file = id.split('?')[0]
          if (!file.startsWith('/')) continue
          moduleIds.add(file)
          if (file.startsWith(root + '/')) await bind(file)
          else {
            assert.ok(file.includes('/node_modules/') || file.startsWith(attempt + '/'), 'No other worktree source can qualify this candidate: ' + file)
            await bind(file)
          }
        }
      } }
      await build({ ...actual, configFile: false, publicDir: false, base: './', cacheDir: join(attempt, 'vite-cache'), logLevel: 'silent',
        define: { ...actual.define, 'process.env.NODE_ENV': JSON.stringify('production') },
        resolve: { ...actual.resolve, dedupe: variant === 'candidate' ? actual.resolve.dedupe : [], alias: [
          ...originalAliases, ...workspaceAliases,
          { find: '@fixture/absolute-context', replacement: absoluteContext },
          { find: '@fixture/linked-overlay', replacement: join(link, 'index.mjs') }
        ] }, plugins: [...plugins, collector],
        build: { ...actual.build, outDir: directory, emptyOutDir: true, copyPublicDir: false, sourcemap: true,
          lib: { entry: join(fixture, 'entry.tsx'), name: 'RendererSingletonProbe', formats: ['iife'] },
          rollupOptions: { input: join(fixture, 'entry.tsx'), output: { format: 'iife', name: 'RendererSingletonProbe', inlineDynamicImports: true, entryFileNames: 'entry.js' } } } })
      await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="entry.js"></script>\n')
      const groups = { react: new Set(), reactDom: new Set() }
      for (const id of moduleIds) {
        const match = /^(.*\/node_modules\/(react|react-dom))\//u.exec(id)
        if (match) groups[match[2] === 'react' ? 'react' : 'reactDom'].add(match[1])
      }
      const expectedOwners = variant === 'candidate' ? 1 : 2
      assert.equal(groups.react.size, expectedOwners, 'Nonempty actual compiled React roots')
      assert.equal(groups.reactDom.size, expectedOwners, 'Nonempty actual compiled ReactDOM roots')
      for (const consumer of ['PaneSplitMenu.tsx', 'HoverDropdownMenu.tsx', 'ConfirmationDialog.tsx', 'WindowOverlayHost.tsx']) {
        assert.ok([...moduleIds].some(id => id === join(desktop, 'src/renderer/src/components', consumer)), 'Original production consumer missing: ' + consumer)
      }
      await writeFile(join(directory, 'module-inputs.json'), JSON.stringify([...moduleIds], null, 2) + '\n')
      const report = join(directory, 'browser-receipt.json')
      const executed = await runBrowser(directory, report, join(attempt, 'electron-user-data'), variant)
      await writeFile(join(directory, 'browser.log'), executed.stdout + executed.stderr)
      const browser = JSON.parse(await readFile(report, 'utf8'))
      assert.equal(executed.signal, null); assert.equal(executed.timedOut, false)
      assert.equal(executed.code, variant === 'candidate' ? 0 : 1, 'Only actual expected browser completion is semantic evidence')
      assert.equal(browser.passed, true); assert.equal(browser.cases.length, 2)
      assert.deepEqual(browser.cases.map(row => row.trigger), ['absolute-entry', 'linked-package'])
      const compiled = []
      for (const file of await files(directory)) if (/\.(?:js|map|html)$/u.test(file)) compiled.push({ path: relative(directory, file), sha256: sha(await readFile(file)), bytes: (await stat(file)).size })
      configuration.variants.push({ variant, executed: { code: executed.code, signal: executed.signal, timedOut: executed.timedOut },
        compiled, moduleOwnerRoots: { react: [...groups.react], reactDom: [...groups.reactDom] }, report, browser,
        semanticRed: variant === 'without-dedupe' && browser.cases.every(row => row.expectedNativeFailure === true) })
      await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      console.log(JSON.stringify({ configuration: name, variant, actualExitCode: executed.code, cases: browser.cases.length, semanticRed: variant === 'without-dedupe' }))
    }
  }
  receipt.sourceStable = (await Promise.all([...inputs].map(async ([path, hash]) => sha(await readFile(path)) === hash))).every(Boolean)
  assert.equal(receipt.sourceStable, true)
  receipt.qualified = receipt.configurations.length === configs.length && receipt.configurations.every(config => config.variants.length === 2 && config.variants[1].semanticRed)
  receipt.fullConfigurationClosure = configs.length === 3
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  receipt.inputs = Object.fromEntries([...inputs].map(([path, hash]) => [relative(root, path), hash]))
  receipt.resource.afterBytes = await available()
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: join(attempt, 'receipt.json'), sha256: sha(await readFile(join(attempt, 'receipt.json'))) }, null, 2) + '\n')
  console.log(JSON.stringify({ qualified: receipt.qualified, fullConfigurationClosure: receipt.fullConfigurationClosure,
    sourceStable: receipt.sourceStable, receipt: join(attempt, 'receipt.json'), failure: receipt.failure?.message }))
  if (!receipt.qualified) process.exitCode = 1
}
