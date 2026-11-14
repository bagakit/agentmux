#!/usr/bin/env node
import assert from 'node:assert/strict'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repository = fileURLToPath(new URL('..', import.meta.url))
const { inspectLockfilePackagePlatforms, inspectPackageDependencies, visitRuntimePackageClosure } =
  await import(pathToFileURL(join(repository, 'scripts/package-dependencies.mjs')).href)

async function resolveKoffiRoot() {
  for (const candidate of [
    join(repository, 'packages/core/node_modules/koffi'),
    join(repository, '../../packages/core/node_modules/koffi')
  ]) {
    if (await lstat(candidate).then(() => true, () => false)) return candidate
  }
  throw new Error('koffi is not installed in this worktree or the shared checkout')
}

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

test('pnpm-lock.yaml records the linux-x64 koffi optional native', async () => {
  const packages = inspectLockfilePackagePlatforms(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  const linux = packages.get('@koromix/koffi-linux-x64@3.3.7')
  assert.ok(linux, 'lockfile must list @koromix/koffi-linux-x64@3.3.7')
  assert.deepEqual(linux.os, ['linux'])
  assert.deepEqual(linux.cpu, ['x64'])
  assert.match(linux.integrity, /^sha512-[A-Za-z0-9+/=]+$/)
  const darwin = packages.get('@koromix/koffi-darwin-arm64@3.3.7')
  assert.deepEqual(darwin?.os, ['darwin'])
  assert.deepEqual(darwin?.cpu, ['arm64'])
})

test('host koffi graph keeps Darwin optional and omits absent Linux optional', async () => {
  const dependencies = await inspectPackageDependencies(await resolveKoffiRoot())
  assert.ok(dependencies.find(value => value.name === '@koromix/koffi-darwin-arm64')?.sourceDirectory)
  assert.equal(dependencies.find(value => value.name === '@koromix/koffi-linux-x64')?.sourceDirectory ?? null, null)
})

test('linux-x64 target drops Darwin koffi and materializes the lockfile linux optional', async () => {
  const linux = await mkdtemp(join(tmpdir(), 'amux-koffi-linux-'))
  try {
    await put(join(linux, 'package.json'), JSON.stringify({
      name: '@koromix/koffi-linux-x64', version: '3.3.7', os: ['linux'], cpu: ['x64']
    }) + '\n')
    await put(join(linux, 'linux_x64/koffi.node'), 'fixture-linux-native\n')
    const requested = []
    const dependencies = await inspectPackageDependencies(await resolveKoffiRoot(), null, {
      target: { os: 'linux', cpu: 'x64' },
      lockfilePath: join(repository, 'pnpm-lock.yaml'),
      materializeOptionalPackage: async (name, platform) => {
        requested.push({ name, os: platform.os, cpu: platform.cpu })
        return name === '@koromix/koffi-linux-x64' ? linux : null
      }
    })
    assert.deepEqual(requested, [{ name: '@koromix/koffi-linux-x64', os: ['linux'], cpu: ['x64'] }])
    assert.equal(dependencies.find(value => value.name === '@koromix/koffi-darwin-arm64')?.sourceDirectory ?? null, null)
    assert.equal(await readFile(join(dependencies.find(value => value.name === '@koromix/koffi-linux-x64').sourceDirectory, 'linux_x64/koffi.node'), 'utf8'), 'fixture-linux-native\n')
  } finally { await rm(linux, { recursive: true, force: true }) }
})

test('target materialize copies matching optional files and leaves foreign natives out of the destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-target-graph-'))
  try {
    const core = join(root, 'core'), darwin = join(core, 'node_modules/@native/darwin-arm64')
    await put(join(core, 'package.json'), JSON.stringify({
      name: '@agentmux/core', version: '0.0.0',
      optionalDependencies: { '@native/darwin-arm64': '1.0.0', '@native/linux-x64': '1.0.0' }
    }) + '\n')
    await put(join(core, 'index.cjs'), 'module.exports = {}\n')
    await put(join(darwin, 'package.json'), JSON.stringify({
      name: '@native/darwin-arm64', version: '1.0.0', os: ['darwin'], cpu: ['arm64']
    }) + '\n')
    await put(join(darwin, 'index.cjs'), 'module.exports = { native: "darwin" }\n')
    const linux = join(root, 'linux-optional')
    await put(join(linux, 'package.json'), JSON.stringify({
      name: '@native/linux-x64', version: '1.0.0', os: ['linux'], cpu: ['x64']
    }) + '\n')
    await put(join(linux, 'index.cjs'), 'module.exports = { native: "linux" }\n')
    const lockfile = join(root, 'pnpm-lock.yaml')
    await put(lockfile, [
      'packages:',
      "  '@native/darwin-arm64@1.0.0':",
      '    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}',
      '    cpu: [arm64]',
      '    os: [darwin]',
      "  '@native/linux-x64@1.0.0':",
      '    resolution: {integrity: sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB}',
      '    cpu: [x64]',
      '    os: [linux]',
      ''
    ].join('\n'))
    const copy = async (source, target) => {
      await mkdir(target, { recursive: true })
      for (const file of ['package.json', 'index.cjs']) await copyFile(join(source, file), join(target, file))
    }
    const host = join(root, 'host')
    await visitRuntimePackageClosure([{ sourceDirectory: core, target: host }], copy)
    assert.equal(JSON.parse(await readFile(join(host, 'node_modules/@native/darwin-arm64/package.json'), 'utf8')).name, '@native/darwin-arm64')
    await assert.rejects(readFile(join(host, 'node_modules/@native/linux-x64/package.json')), { code: 'ENOENT' })

    const selected = join(root, 'linux')
    await visitRuntimePackageClosure([{ sourceDirectory: core, target: selected }], copy, {
      target: { os: 'linux', cpu: 'x64' },
      lockfilePath: lockfile,
      materializeOptionalPackage: async name => name === '@native/linux-x64' ? linux : null
    })
    assert.equal(JSON.parse(await readFile(join(selected, 'node_modules/@native/linux-x64/package.json'), 'utf8')).name, '@native/linux-x64')
    await assert.rejects(readFile(join(selected, 'node_modules/@native/darwin-arm64/package.json')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
