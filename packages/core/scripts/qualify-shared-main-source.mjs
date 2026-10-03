import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Refuse only this proof when shared main would consume a different Source. */
export async function qualifySharedMainSource(root, selectedPaths, declaredCommit) {
  const directory = await realpath(root)
  const git = async args => (await execute('git', args, { cwd: directory, maxBuffer: 16 * 1024 * 1024 })).stdout
  const top = await git(['rev-parse', '--show-toplevel']).catch(() => null)
  if (top === null || await realpath(top.trim()) !== directory) return null
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  if (branch?.trim() !== 'main') return null
  const commit = declaredCommit ?? (await git(['rev-parse', 'HEAD'])).trim()
  const tree = await git(['ls-tree', '-r', '-z', commit, '--', ...selectedPaths])
  const entries = tree.split('\0').filter(Boolean).map(line => {
    const [metadata, path] = line.split('\t'), [mode, type, oid] = metadata.split(' ')
    if (type !== 'blob' || !path) throw new Error('Selected proof Source is not a regular Git blob.')
    return { path, oid }
  })
  if (!entries.length) throw new Error('Selected proof Source is empty; no Main qualification was made.')
  const algorithm = commit.length === 64 ? 'sha256' : 'sha1', mismatches = []
  for (const { path, oid } of entries) {
    const bytes = await readFile(join(directory, path)).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    const actual = bytes === null ? null : createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (actual !== oid) mismatches.push({ path, declaredBlob: oid, actualBlob: actual })
  }
  const expectedPaths = new Set(entries.map(entry => entry.path))
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...selectedPaths])
  for (const path of untracked.split('\0').filter(Boolean)) {
    if (!expectedPaths.has(path)) mismatches.push({ path, declaredBlob: null, actualBlob: 'untracked Source' })
  }
  if (mismatches.length) {
    const error = new Error(`Selected Source differs from declared Main ${commit}; refusing this proof before build, copy or mutation. Existing files, index and Runs are kept. ${JSON.stringify(mismatches)}`)
    error.code = 'VERIFY_SELECTED_SOURCE_MISMATCH'
    throw error
  }
  return { commit, selectedPaths, files: entries.length }
}
