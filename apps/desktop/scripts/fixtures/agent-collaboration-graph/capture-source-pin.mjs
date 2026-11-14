import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const product = file => /^(?:apps\/desktop\/src\/|packages\/[^/]+\/src\/)/.test(file)

export function createCaptureSourcePin({ root, revision }) {
  root = resolve(root)
  const commit = revision ? execFileSync('git', ['rev-parse', '--verify', revision + '^{commit}'], { cwd: root, encoding: 'utf8' }).trim() : null
  const files = {}, bytesByPath = new Map(), blobs = new Map(), pending = new Map()
  let draining = false
  const drain = () => {
    if (draining || !pending.size) return
    draining = true
    const batch = [...pending.values()]; pending.clear()
    const child = execFile('git', ['cat-file', '--batch'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, output) => {
      try {
        if (error) throw error
        let offset = 0
        for (const item of batch) {
          const newline = output.indexOf(10, offset), [object, type, length] = output.subarray(offset, newline).toString().split(' ')
          assert.equal(object, item.object); assert.equal(type, 'blob')
          const size = Number(length); assert.ok(Number.isSafeInteger(size) && size >= 0)
          const bytes = Buffer.from(output.subarray(newline + 1, newline + 1 + size))
          assert.equal(bytes.length, size); assert.equal(output[newline + 1 + size], 10)
          files[item.key] = { gitObject: object, sha256: digest(bytes), origin: 'git-blob' }
          item.resolve(bytes); offset = newline + 2 + size
        }
        assert.equal(offset, output.length)
      } catch (failure) { for (const item of batch) item.reject(failure) }
      finally { draining = false; if (pending.size) setTimeout(drain, 1) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(batch.map(item => item.object).join('\n') + '\n')
  }
  if (commit) for (const record of execFileSync('git', ['ls-tree', '-rz', commit, '--', 'apps/desktop/src', 'packages'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean)) {
    const [entry, file] = record.split('\t'), [, kind, object] = entry.split(' ')
    if (kind === 'blob' && product(file)) blobs.set(file, object)
  }
  const owns = file => Boolean(commit) && file.startsWith(root + sep) && product(relative(root, file))
  const read = async file => {
    if (!owns(file)) return readFile(file)
    const key = relative(root, file)
    if (!bytesByPath.has(key)) {
      const gitObject = blobs.get(key)
      assert.ok(gitObject, 'Consumed product input is absent from the declared Git ref: ' + key)
      bytesByPath.set(key, new Promise((resolve, reject) => { pending.set(key, { key, object: gitObject, resolve, reject }); if (!draining) setTimeout(drain, 1) }))
    }
    return bytesByPath.get(key)
  }
  return { revision: commit, files, owns, read,
    boundary: 'Only actual product source inputs are Git-pinned. Current fixture/harness, selected resolver/package/tsconfig metadata and installed dependencies are separately declared; this is not a hermetic repository snapshot.' }
}

export function pinnedSourceAfter(root, overlay, inputs) {
  const selected = Object.keys(inputs).filter(file => overlay.files[file]?.origin === 'git-blob')
  if (!selected.length) return {}
  const objects = selected.map(file => overlay.files[file].gitObject)
  const output = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: objects.join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 })
  const result = {}; let offset = 0
  for (const [index, file] of selected.entries()) {
    const newline = output.indexOf(10, offset), [object, type, length] = output.subarray(offset, newline).toString().split(' ')
    assert.equal(object, objects[index]); assert.equal(type, 'blob')
    const size = Number(length); assert.ok(Number.isSafeInteger(size) && size >= 0)
    const bytes = output.subarray(newline + 1, newline + 1 + size)
    assert.equal(bytes.length, size); assert.equal(output[newline + 1 + size], 10)
    result[file] = digest(bytes); offset = newline + 2 + size
  }
  assert.equal(offset, output.length)
  return result
}

export async function captureResolverMetadata(root) {
  const names = execFileSync('git', ['ls-files', '-z', '--', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ':**/package.json', ':**/tsconfig*.json', 'tsconfig*.json'], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString().split('\0').filter(Boolean)
  return Object.fromEntries(await Promise.all(names.filter(file => !file.includes('node_modules/')).map(async file => [file, digest(await readFile(join(root, file)))])))
}
