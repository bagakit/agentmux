#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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

const options = parse(process.argv.slice(2))
const selected = options.archive ? { archive: options.archive, sha256: null, generation: null } : await newestLinuxArchive()
const names = await listInnerCore(selected.archive)
const linux = names.filter(name => name.includes('koffi-linux-x64') || /linux_x64\/koffi\.node$/.test(name))
const darwin = names.filter(name => name.includes('koffi-darwin-arm64') || /darwin_arm64\/koffi\.node$/.test(name))
assert.ok(linux.some(name => name.endsWith('koffi.node') || name.includes('koffi-linux-x64')), `${selected.archive} must ship @koromix/koffi-linux-x64`)
assert.equal(darwin.length, 0, `${selected.archive} must not ship Darwin koffi: ${darwin.slice(0, 8).join(', ')}`)
process.stdout.write(JSON.stringify({
  archive: selected.archive, generation: selected.generation, sha256: selected.sha256,
  linuxNative: linux, darwinNative: darwin, passed: true
}) + '\n')
