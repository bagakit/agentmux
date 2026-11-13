import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Add the Host's existing exact optional Linux native dependency to this private
 * cross-platform artifact. Workspace dependencies, lock and live Hosts stay owned. */
export async function prepareLinuxAvatar(cache, repository) {
  const name = '@resvg/resvg-js-linux-x64-gnu'
  const parent = JSON.parse(await readFile(join(repository, 'apps/host/node_modules/@resvg/resvg-js/package.json'), 'utf8'))
  const version = parent.optionalDependencies[name]
  assert.match(version, /^\d+\.\d+\.\d+$/u)
  const lock = parse(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  const integrity = lock.packages[name + '@' + version]?.resolution?.integrity
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]+=*$/u)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const archive = join(cache, 'resvg-linux-x64-gnu-' + version + '.tgz')
  const digest = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  let source = 'private-cache', bytes = await readFile(archive).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (!bytes) {
    try {
      const packed = await promisify(execFile)('npm', ['pack', name + '@' + version, '--offline', '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org', '--pack-destination', cache],
        { env: { ...process.env, npm_config_logs_dir: join(cache, 'logs') }, timeout: 30_000 })
      const filename = JSON.parse(packed.stdout)[0].filename
      assert.ok(!filename.includes('/') && !filename.includes('\\'))
      bytes = await readFile(join(cache, filename)); source = 'original-offline-cache'
    } catch (error) {
      if (!/ENOTCACHED|cache mode|only-if-cached/u.test(String(error.stderr ?? error.message))) throw error
      const url = 'https://registry.npmjs.org/' + name + '/-/' + name.split('/')[1] + '-' + version + '.tgz'
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) }); assert.equal(response.ok, true)
      bytes = new Uint8Array(await response.arrayBuffer()); source = 'official-registry'
    }
    assert.equal(digest(bytes), integrity, 'Use only the original lock-approved native bytes')
    await writeFile(archive, bytes, { mode: 0o600 })
  }
  assert.equal(digest(bytes), integrity, 'The cached native archive must retain its original lock integrity')
  return { name, version, integrity, archive, source }
}

export async function addLinuxAvatar(artifact, cache, repository) {
  const selected = await prepareLinuxAvatar(cache, repository)
  const parent = await realpath(join(artifact, 'node_modules/@agentmux/host/node_modules/@resvg/resvg-js'))
  const directory = join(parent, 'node_modules', selected.name)
  await mkdir(directory, { recursive: true })
  await promisify(execFile)('tar', ['-xzf', selected.archive, '--strip-components=1', '-C', directory])
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  assert.equal(manifest.name, selected.name); assert.equal(manifest.version, selected.version)
  return { name: selected.name, version: selected.version, integrity: selected.integrity, source: selected.source }
}
