import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, statfsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(root, process.argv[2] ?? 'docs/reviews/evidence/local-file-preview-2026-10-04/source-main')
const ownerPath = 'apps/desktop/src/main/workspace-files.ts', ipcPath = 'apps/desktop/src/main/ipc.ts'
const sources = new Map([ownerPath, ipcPath].map(path => [path, readFileSync(resolve(root, path), 'utf8')]))
const digest = text => createHash('sha256').update(text).digest('hex')
const config = 'apps/desktop/test/fixtures/file-preview/vitest.config.ts'
const owning = ['apps/desktop/test/workspace-file-preview.test.ts', 'apps/desktop/test/workspace-file-preview-ipc.test.ts']
const cases = [
  { id: 'bytes-corrupted-through-utf8', path: ownerPath, replacements: [['bytes: snapshot.bytes,', "bytes: Buffer.from(Buffer.from(snapshot.bytes).toString('utf8')),"]], tests: owning },
  { id: 'snapshot-replaced-with-public-chunk', path: ownerPath, replacements: [['const snapshot = await this.snapshotBytes(workspace, requestedPath, options)', 'const snapshot = await this.readBytes(workspace, requestedPath, options)']], tests: owning },
  { id: 'unknown-binary-document-guard-disabled', path: ownerPath, replacements: [['if (fileBytesAreBinary(bytes)) {', 'if (false) {']], tests: owning.slice(0, 1) },
  { id: 'fatal-utf8-proof-disabled', path: ownerPath, replacements: [["new TextDecoder('utf-8', { fatal: true }).decode(bytes)", 'void bytes']], tests: owning.slice(0, 1) },
  { id: 'binary-text-save-protection-disabled', path: ownerPath, replacements: [['if (request.textOnly && before.binary) {', 'if (false && before.binary) {'], ['if (request.textOnly && immediatelyBeforeReplace.binary) {', 'if (false && immediatelyBeforeReplace.binary) {']], tests: owning.slice(0, 1) },
  { id: 'preview-byte-limit-disabled', path: ownerPath, replacements: [['totalBytes > request.maxFileBytes', 'totalBytes > Number.MAX_SAFE_INTEGER']], tests: owning.slice(0, 1) },
  { id: 'ipc-workspace-owner-replaced', path: ipcPath, replacements: [['await files.readPreview(workspace(config, workspaceId), path, options)', 'await files.readPreview(config.workspaces[0]!, path, options)']], tests: owning.slice(1) }
]
const fs = statfsSync(root)
assert(fs.bavail * fs.bsize > 128 * 1024 * 1024, 'Need free space to preserve and restore source safely')
mkdirSync(output, { recursive: true })
const run = (id, tests) => {
  const argv = ['run', '--config', config, ...tests, '--maxWorkers=1']
  const result = spawnSync(resolve(root, 'node_modules/.bin/vitest'), argv, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(resolve(output, `${id}.log`), log)
  assert(!result.error, result.error?.message)
  return { id, command: `node_modules/.bin/vitest ${argv.join(' ')}`, exitCode: result.status, assertionRed: result.status !== 0 && /AssertionError:/u.test(log), log: `${id}.log` }
}
const receipt = { schema: 'agentmux.workspace-file-preview-source-mutations.v1', originals: Object.fromEntries([...sources].map(([path, text]) => [path, digest(text)])), green: null, mutations: [], restored: null }
try {
  receipt.green = run('owning-green', owning)
  assert.equal(receipt.green.exitCode, 0, 'Owning source must be green before any mutation')
  for (const item of cases) {
    let mutated = sources.get(item.path)
    for (const [before, after] of item.replacements) {
      assert.equal(mutated.split(before).length, 2, `Mutation anchor must occur exactly once: ${item.id}`)
      mutated = mutated.replace(before, after)
    }
    try {
      writeFileSync(resolve(root, item.path), mutated)
      const result = run(item.id, item.tests)
      receipt.mutations.push({ ...result, source: item.path, mutationSha256: digest(mutated) })
      assert(result.assertionRed, `${item.id} must fail a loaded implementation assertion`)
    } finally { writeFileSync(resolve(root, item.path), sources.get(item.path)) }
  }
} finally {
  for (const [path, original] of sources) { writeFileSync(resolve(root, path), original); assert.equal(digest(readFileSync(resolve(root, path), 'utf8')), digest(original)) }
  receipt.restored = run('restored-green', [...owning, 'apps/desktop/test/workspace-file-bytes.test.ts', 'apps/desktop/test/ipc-parity.test.ts'])
  receipt.restoredSources = Object.fromEntries([...sources].map(([path]) => [path, digest(readFileSync(resolve(root, path), 'utf8'))]))
  writeFileSync(resolve(output, 'mutation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.restored.exitCode, 0, 'Restored exact source must pass the complete owning gate')
console.log(JSON.stringify({ mutations: receipt.mutations.length, assertionRed: receipt.mutations.filter(item => item.assertionRed).length, restored: receipt.restored.exitCode, output }))
