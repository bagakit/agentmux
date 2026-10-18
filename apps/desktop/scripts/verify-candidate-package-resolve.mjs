import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { candidateModule, candidateResolve } from './candidate-package-resolve.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
test('current Core and connector exports resolve from their original checkout manifests', async () => {
  for (const [specifier, target] of [
    ['@agentmux/core/observation-read', 'packages/core/src/observation-read.ts'],
    ['@agentmux/diagnostic-evidence', 'packages/diagnostic-evidence/src/index.ts'],
    ['@agentmux/connectors', 'packages/connectors/src/index.ts'],
    ['@agentmux/connectors/adapters/feishu', 'packages/connectors/src/adapters/feishu/index.ts'],
    ['@agentmux/connectors/adapters/discord', 'packages/connectors/src/adapters/discord/index.ts']
  ]) {
    let manifest
    const file = candidateResolve(root, specifier, { browser: true, source: true,
      onManifest: (file, bytes) => { manifest = { file, bytes } } })
    assert.equal(file, await realpath(path.join(root, target)))
    assert.deepEqual(manifest.bytes, await readFile(manifest.file))
    assert.ok(manifest.file.startsWith(root + path.sep))
  }
})

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'amux-export-proof-'))
  try {
    const root = path.join(directory, 'candidate'), pkg = path.join(root, 'packages', 'new-owner')
    await mkdir(path.join(pkg, 'src/nested'), { recursive: true })
    await mkdir(path.join(pkg, 'dist/nested'), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@agentmux/new-owner', exports: {
      './*': { browser: './src/*.ts', import: './dist/*.js' },
      './nested/*': { browser: './src/nested/*.ts', import: './dist/nested/*.js' },
      './exact': { browser: './src/chosen.js', import: './dist/chosen.js' }
    } }))
    for (const file of ['src/capability.ts', 'dist/capability.js', 'src/nested/capability.ts', 'dist/nested/capability.js', 'src/chosen.js', 'dist/chosen.js']) {
      await writeFile(path.join(pkg, file), 'export const original = true\n')
    }
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
