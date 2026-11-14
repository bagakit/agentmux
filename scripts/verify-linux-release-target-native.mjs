#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repository = fileURLToPath(new URL('..', import.meta.url))

function parse(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--archive') options.archive = resolve(argv[++index])
    else throw new Error('Usage: verify-linux-release-target-native.mjs [--archive FILE]')
  }
  return options
}

async function newestLinuxArchive() {
  const root = join(repository, '.local/package-delivery/artifacts/linux-x64')
  const generations = (await readdir(root).catch(() => [])).filter(name => !name.startsWith('.'))
  const ranked = []
  for (const generation of generations) {
    const receipt = await readFile(join(root, generation, 'receipt.json'), 'utf8').then(JSON.parse, () => null)
    if (!receipt?.archive) continue
    ranked.push({ generation, archive: join(root, generation, receipt.archive), completedAt: receipt.completedAt ?? 0, sha256: receipt.sha256 })
  }
  ranked.sort((left, right) => right.completedAt - left.completedAt)
  assert.ok(ranked[0], 'A linux-x64 artifact receipt must exist')
  return ranked[0]
}

async function listInnerCore(archive) {
  const outer = (await exec('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n')
  const inner = outer.find(name => name.endsWith('/core/core.tar.gz') || name === 'core/core.tar.gz')
  assert.ok(inner, `${archive} must contain core/core.tar.gz`)
  const extracted = await exec('tar', ['-xOzf', archive, inner], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const scratch = await mkdtemp(join(tmpdir(), 'amux-linux-core-'))
  try {
    const packed = join(scratch, 'core.tar.gz')
    await writeFile(packed, extracted.stdout)
    return (await exec('tar', ['-tzf', packed], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').filter(Boolean)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

export function assertLinuxReleaseNativeNames(names, archive = 'archive') {
  const linuxNode = names.filter(name => /(^|\/)linux_x64\/koffi\.node$/.test(name))
  const darwinNode = names.filter(name => /(^|\/)darwin_arm64\/koffi\.node$/.test(name))
  const darwinPackage = names.filter(name => name.includes('koffi-darwin-arm64'))
  assert.ok(linuxNode.length > 0, `${archive} must ship linux_x64/koffi.node`)
  assert.equal(darwinNode.length, 0, `${archive} must not ship Darwin koffi.node: ${darwinNode.slice(0, 8).join(', ')}`)
  assert.equal(darwinPackage.length, 0, `${archive} must not ship Darwin koffi: ${darwinPackage.slice(0, 8).join(', ')}`)
  return { linuxNode, darwinNode, darwinPackage }
}

async function main() {
  const options = parse(process.argv.slice(2))
  const selected = options.archive ? { archive: options.archive, sha256: null, generation: null } : await newestLinuxArchive()
  const names = await listInnerCore(selected.archive)
  const natives = assertLinuxReleaseNativeNames(names, selected.archive)
  process.stdout.write(JSON.stringify({
    archive: selected.archive, generation: selected.generation, sha256: selected.sha256,
    linuxNative: natives.linuxNode, darwinNative: natives.darwinNode, passed: true
  }) + '\n')
}

function invokedAsCli() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  }
}

if (invokedAsCli()) await main()
