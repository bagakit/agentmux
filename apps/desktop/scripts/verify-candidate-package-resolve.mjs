import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { candidateAlias, candidateModule, candidateResolve } from './candidate-package-resolve.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
test('current Core, Host and connector exports resolve from their original checkout manifests', async () => {
  for (const [specifier, target] of [
    ['@agentmux/core/observation-read', 'packages/core/src/observation-read.ts'],
    ['@agentmux/host/mote-resources', 'apps/host/src/mote-resources.ts'],
    ['@agentmux/host/mote-chat-agents', 'apps/host/src/mote-chat-agents.ts'],
    ['@agentmux/host/mote-model', 'apps/host/src/mote-model.ts'],
    ['@agentmux/host/credential-administration', 'apps/host/src/credential-administration.ts'],
    ['@agentmux/diagnostic-evidence', 'packages/diagnostic-evidence/src/index.ts'],
    ['@agentmux/connectors', 'packages/connectors/src/index.ts'],
    ['@agentmux/connectors/adapters/feishu', 'packages/connectors/src/adapters/feishu/index.ts'],
    ['@agentmux/connectors/adapters/discord', 'packages/connectors/src/adapters/discord/index.ts']
  ]) {
    const manifests = new Map()
    const file = candidateResolve(root, specifier, { browser: true, source: true,
      onManifest: (file, bytes) => manifests.set(file, bytes) })
    assert.equal(file, await realpath(path.join(root, target)))
    const manifest = await realpath(path.join(root, target.split('/src/')[0], 'package.json'))
    assert.deepEqual(manifests.get(manifest), await readFile(manifest))
    assert.deepEqual(manifests.get(path.join(root, 'pnpm-workspace.yaml')), await readFile(path.join(root, 'pnpm-workspace.yaml')))
    for (const [file, bytes] of manifests) {
      assert.deepEqual(bytes, await readFile(file))
      assert.ok(file.startsWith(root + path.sep))
    }
  }
})

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'amux-export-proof-'))
  try {
    const root = path.join(directory, 'candidate'), pkg = path.join(root, 'packages', 'new-owner')
    await mkdir(path.join(pkg, 'src/nested'), { recursive: true })
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - apps/*\n')
    await mkdir(path.join(pkg, 'src/styles'), { recursive: true })
    await mkdir(path.join(pkg, 'dist/nested'), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentmux/new-owner', exports: {
      './*': { browser: './src/*.ts', import: './dist/*.js' },
      './nested/*': { browser: './src/nested/*.ts', import: './dist/nested/*.js' },
      './exact': { browser: './src/chosen.js', import: './dist/chosen.js' },
      './styles.css': './src/styles/exact.css', './styles/*': './src/styles/*'
    } }))
    for (const file of ['src/capability.ts', 'dist/capability.js', 'src/nested/capability.ts', 'dist/nested/capability.js', 'src/chosen.js', 'dist/chosen.js']) {
      await writeFile(path.join(pkg, file), 'export const original = true\n')
    }
    for (const name of ['exact', 'wildcard']) await writeFile(path.join(pkg, 'src/styles', name + '.css'), '.candidate-' + name + ' { color: green }\n')
    await run({ directory: await realpath(directory), root: await realpath(root), pkg: await realpath(pkg) })
  } finally { await rm(directory, { recursive: true }) }
}

test('an unlisted package preserves exact, wildcard and browser export meaning', async () => fixture(async ({ root, pkg }) => {
  assert.equal(candidateResolve(root, '@agentmux/new-owner/capability'), path.join(pkg, 'dist/capability.js'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/capability', { browser: true }), path.join(pkg, 'src/capability.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/nested/capability', { browser: true }), path.join(pkg, 'src/nested/capability.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/exact', { browser: true, source: true }), path.join(pkg, 'src/chosen.js'))
  assert.throws(() => candidateResolve(root, '@agentmux/new-owner'), /Missing declared candidate export/u)
}))

test('workspace membership and manifest names select app packages independently of directory names', async () => fixture(async ({ root, pkg }) => {
  const app = path.join(root, 'apps', 'different-directory')
  await mkdir(app, { recursive: true })
  const manifestPath = path.join(app, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ name: '@agentmux/app-owner', exports: { './capability': './capability.js' } }))
  await writeFile(path.join(app, 'capability.js'), 'export const original = true\n')
  const observed = new Map()
  assert.equal(candidateResolve(root, '@agentmux/app-owner/capability', {
    onManifest: (file, bytes) => observed.set(file, bytes)
  }), path.join(app, 'capability.js'))
  assert.deepEqual([...observed.keys()].sort(), [path.join(root, 'pnpm-workspace.yaml'), path.join(pkg, 'package.json'), manifestPath].sort())
  for (const [file, bytes] of observed) assert.deepEqual(bytes, await readFile(file))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\n  - apps/*\n  - '!apps/different-directory'\n")
  assert.throws(() => candidateResolve(root, '@agentmux/app-owner/capability'), /Expected one declared candidate package/u)
}))

test('duplicate manifest identities are rejected rather than selected by directory order', async () => fixture(async ({ root, pkg }) => {
  const duplicate = path.join(root, 'apps', 'another-directory')
  await mkdir(duplicate, { recursive: true })
  await writeFile(path.join(duplicate, 'package.json'), await readFile(path.join(pkg, 'package.json')))
  assert.throws(() => candidateResolve(root, '@agentmux/new-owner/capability'), /Expected one declared candidate package/u)
}))

test('type resolution consumes the original declaration export rather than the runtime entry', async () => fixture(async ({ root, pkg }) => {
  const manifest = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'))
  manifest.exports['./typed'] = { types: './dist/typed-entry.d.ts', browser: './src/capability.ts', import: './dist/capability.js' }
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(pkg, 'dist/typed-entry.d.ts'), 'export declare const original: true\n')
  assert.equal(candidateResolve(root, '@agentmux/new-owner/typed', { types: true }), path.join(pkg, 'dist/typed-entry.d.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/typed', { types: true, browser: true }), path.join(pkg, 'dist/typed-entry.d.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/typed', { browser: true }), path.join(pkg, 'src/capability.ts'))
}))

test('source resolution preserves generated exports and selects source only when the implementation exists', async () => fixture(async ({ root, pkg }) => {
  const manifest = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'))
  manifest.exports['./generated'] = { types: './dist/generated-entry.d.ts', import: './dist/generated.js' }
  manifest.exports['./implemented'] = { types: './dist/capability.d.ts', import: './dist/capability.js' }
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(pkg, 'dist/generated-entry.d.ts'), 'export declare const original: true\n')
  await writeFile(path.join(pkg, 'dist/generated.js'), 'export const original = true\n')
  await writeFile(path.join(pkg, 'dist/capability.d.ts'), 'export declare const original: true\n')
  assert.equal(candidateResolve(root, '@agentmux/new-owner/generated', { source: true }), path.join(pkg, 'dist/generated.js'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/generated', { types: true, source: true }), path.join(pkg, 'dist/generated-entry.d.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/implemented', { source: true }), path.join(pkg, 'src/capability.ts'))
  assert.equal(candidateResolve(root, '@agentmux/new-owner/implemented', { types: true, source: true }), path.join(pkg, 'src/capability.ts'))
}))

test('a declared first-party export cannot escape through a shared node_modules target', async () => fixture(async ({ directory, root, pkg }) => {
  const shared = path.join(directory, 'shared/node_modules/owner')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'escape.ts'), 'export const foreign = true\n')
  await symlink(path.join(shared, 'escape.ts'), path.join(pkg, 'src/escape.ts'))
  assert.throws(() => candidateResolve(root, '@agentmux/new-owner/escape', { browser: true }), /Candidate export escaped/u)
  await mkdir(path.join(root, 'packages/foreign'))
  await symlink(path.join(shared, 'escape.ts'), path.join(root, 'packages/foreign/package.json'))
  assert.throws(() => candidateResolve(root, '@agentmux/foreign'), /Candidate manifest escaped/u)
}))

test('loaded first-party modules stay in the candidate while ordinary dependencies may be shared', async () => fixture(async ({ directory, root, pkg }) => {
  assert.equal(candidateModule(root, path.join(pkg, 'src/capability.ts')), path.join(pkg, 'src/capability.ts'))
  const foreign = path.join(directory, 'other/packages/owner/index.ts')
  await mkdir(path.dirname(foreign), { recursive: true }); await writeFile(foreign, 'export const foreign = true\n')
  assert.throws(() => candidateModule(root, foreign), /First-party build input escaped/u)
  const dependency = path.join(directory, 'shared/node_modules/dependency/index.js')
  await mkdir(path.dirname(dependency), { recursive: true }); await writeFile(dependency, 'export const dependency = true\n')
  assert.equal(candidateModule(root, dependency), dependency)
}))

for (const name of ['exact', 'wildcard']) test('Vite CSS imports consume candidate ' + name + ' exports instead of a shared foreign package', async () => fixture(async ({ directory, root: candidate, pkg }) => {
  const require = createRequire(path.join(root, 'apps/desktop/package.json'))
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const foreign = path.join(directory, 'foreign/packages/new-owner')
  await mkdir(path.join(foreign, 'src/styles'), { recursive: true })
  await writeFile(path.join(foreign, 'package.json'), await readFile(path.join(pkg, 'package.json')))
  await writeFile(path.join(foreign, 'src/styles', name + '.css'), '.foreign-' + name + ' { color: red }\n')
  await mkdir(path.join(directory, 'node_modules/@agentmux'), { recursive: true })
  await symlink(foreign, path.join(directory, 'node_modules/@agentmux/new-owner'))
  const specifier = '@agentmux/new-owner/' + (name === 'exact' ? 'styles.css' : 'styles/wildcard.css')
  const inputs = new Set(), manifests = new Map()
  await writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="./entry.css">')
  await writeFile(path.join(directory, 'entry.css'), `@import '${specifier}';\n`)
  const built = await build({ configFile: false, root: directory, logLevel: 'silent',
    resolve: { alias: [candidateAlias(candidate, { browser: true, source: true,
      onManifest: (file, bytes) => manifests.set(file, bytes) })] },
    css: { postcss: { plugins: [{ postcssPlugin: 'assert-candidate-css-inputs', Once(styles) {
      styles.walk(node => {
        const file = node.source?.input.file
        if (file) inputs.add(candidateModule(candidate, file))
      })
    } }] } }, build: { outDir: path.join(directory, 'compiled'), write: false, minify: false, reportCompressedSize: false } })
  assert.deepEqual([...inputs], [path.join(pkg, 'src/styles', name + '.css')])
  assert.deepEqual([...manifests.keys()].sort(), [path.join(candidate, 'pnpm-workspace.yaml'), path.join(pkg, 'package.json')].sort())
  for (const [file, bytes] of manifests) assert.deepEqual(bytes, await readFile(file))
  const emitted = built.output.find(file => file.fileName.endsWith('.css'))
  assert.ok(emitted && emitted.source.includes('.candidate-' + name))
  assert.ok(!emitted.source.includes('.foreign-'))
}))
