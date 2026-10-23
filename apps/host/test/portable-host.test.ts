import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const { inspectPortableHost, writePortableHostLaunchers } = await import(pathToFileURL(join(import.meta.dirname, '../scripts/portable-host.mjs')).href)
const { inspectPackageClosure } = await import(pathToFileURL(join(import.meta.dirname, '../../../scripts/package-dependencies.mjs')).href)
const exec = promisify(execFile), cleanup: string[] = []
afterEach(async () => { for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'amux-host-closure-')); cleanup.push(root); return root }
async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
async function manifest(root: string, name: string, version: string, fields = {}) {
  await put(join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', ...fields }))
}
async function hostFixture(root: string) {
  const host = join(root, 'node_modules/@agentmux/host'), core = join(host, 'node_modules/@agentmux/core')
  await manifest(host, '@agentmux/host', '1.0.0', { dependencies: { '@agentmux/core': '1.0.0', leaf: '1.0.0' },
    optionalDependencies: { 'absent-native': '1.0.0' }, devDependencies: { 'development-only': '1.0.0' } })
  await manifest(core, '@agentmux/core', '1.0.0', { dependencies: { leaf: '2.0.0' } })
  await manifest(join(host, 'node_modules/leaf'), 'leaf', '1.0.0')
  await manifest(join(core, 'node_modules/leaf'), 'leaf', '2.0.0')
  await manifest(join(host, 'node_modules/development-only'), 'development-only', '1.0.0')
  await put(join(host, 'dist/index.js'), 'console.log(JSON.stringify({ entry: "host", args: process.argv.slice(2) }))')
  await put(join(core, 'dist/agentmux.js'), 'console.log(JSON.stringify({ entry: "rpc", args: process.argv.slice(2) }))')
  return { host, core }
}

it('inventories the actual installed runtime graph without mixing versions or development dependencies', async () => {
  const root = await fixture(), { host, core } = await hostFixture(root)
  // A real package cycle is an edge, not recursive copying or a second package identity.
  await manifest(join(core, 'node_modules/leaf'), 'leaf', '2.0.0', { dependencies: { '@agentmux/host': '1.0.0' } })
  const inventory = await inspectPackageClosure(host)
  expect(inventory.packages.map((p: { name: string; version: string }) => [p.name, p.version])).toEqual([
    ['@agentmux/host', '1.0.0'], ['@agentmux/core', '1.0.0'], ['leaf', '2.0.0'], ['leaf', '1.0.0']
  ])
  const original = inventory.packages[inventory.root]
  expect(original.dependencies).toContainEqual({ name: 'absent-native', optional: true, packageId: null })
  expect(original.dependencies.find((d: { name: string }) => d.name === 'leaf').packageId).toBe(3)
  expect(inventory.packages[1].dependencies).toEqual([{ name: 'leaf', optional: false, packageId: 2 }])
  expect(inventory.packages[2].dependencies).toEqual([{ name: '@agentmux/host', optional: false, packageId: 0 }])
  expect(inventory.packages.every((p: { manifestSha256: string }) => /^[a-f0-9]{64}$/.test(p.manifestSha256))).toBe(true)
  expect(await readdir(root)).toEqual(['node_modules'])
})

it('preserves a required dependency failure instead of qualifying an incomplete Host closure', async () => {
  const root = await fixture(), { host } = await hostFixture(root)
  await manifest(host, '@agentmux/host', '1.0.0', { dependencies: { 'missing-runtime-leaf': '1.0.0' } })
  await expect(inspectPortableHost(host)).rejects.toMatchObject({ code: 'PACKAGE_DEPENDENCY_UNAVAILABLE' })
  expect(await readdir(root)).toEqual(['node_modules'])
})

it('launches the Host and original RPC CLI separately with the selected Node and unchanged literal arguments', async () => {
  const root = await fixture(), directory = join(root, 'candidate with spaces'), { host } = await hostFixture(directory)
  const node = join(root, "node's selected executable"), marker = join(root, 'node-selection')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(marker, '')
  await writeFile(node, '#!/bin/sh\nprintf "%s\\n" selected >> ' + quote(marker) + '\nexec ' + quote(process.execPath) + ' "$@"\n', { mode: 0o755 })
  await writePortableHostLaunchers(directory, node)
  const inventory = await inspectPortableHost(host)
  expect(inventory).toMatchObject({ schema: 'agentmux.portable-host-inventory.v1', minimumNodeMajor: 24 })
  const hostReply = await exec(join(directory, 'bin/agentmux-host'), ['--store', 'original store with spaces'], { env: { ...process.env, NODE_PATH: '' } })
  expect(JSON.parse(hostReply.stdout)).toEqual({ entry: 'host', args: ['--store', 'original store with spaces'] })
  const args = ['--endpoint', 'unix:original socket', 'system', 'endpoint', '--stdio']
  const rpcReply = await exec(join(directory, 'bin/amux'), args, { env: { ...process.env, NODE_PATH: '' } })
  expect(JSON.parse(rpcReply.stdout)).toEqual({ entry: 'rpc', args })
  expect(await readFile(marker, 'utf8')).toBe('selected\nselected\n')
  expect(inventory.entries.host).not.toBe(inventory.entries.cli)
  expect((await readdir(join(directory, 'bin'))).sort()).toEqual(['agentmux-host', 'amux'])
  const original = await readFile(join(directory, 'bin/amux'))
  await expect(writePortableHostLaunchers(directory, node)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(directory, 'bin/amux'))).toEqual(original)
})
