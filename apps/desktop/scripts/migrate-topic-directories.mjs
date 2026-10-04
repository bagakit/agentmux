import { spawn } from 'node:child_process'
import { constants, lstat, mkdir, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const directoryPattern = /^topic--(launcher|session|view)--([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/
const defaultHelper = resolve(import.meta.dirname, '../resources/bin/agentmux-workspace-move')
const code = error => error?.code ?? 'DIRECTORY_MIGRATION_FAILED'
const issue = (error, fallback) => ({ code: code(error), message: error instanceof Error ? error.message : fallback })
const failure = (message, errorCode) => Object.assign(new Error(message), { code: errorCode })
const identity = info => ({ dev: info.dev.toString(), ino: info.ino.toString() })
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino

async function optionalInfo(path) {
  try { return await lstat(path, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function requireDirectory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('A migration root is not a regular directory.', 'DIRECTORY_MIGRATION_ROOT_INVALID')
  return info
}

async function ensureDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return await requireDirectory(path)
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function classify(path, id) {
  if (id === 'launcher:leader') return 'mote'
  const soul = await optionalInfo(join(path, 'SOUL.md'))
  if (!soul) return 'topic'
  if (soul.isFile() && !soul.isSymbolicLink()) return 'mote'
  throw failure('SOUL.md is not a confirmed regular file; this object is not classified or moved.', 'DIRECTORY_MIGRATION_KIND_UNKNOWN')
}

async function readIdentity(directory, expected) {
  const metadata = join(directory, '.agentmux')
  const parent = await optionalInfo(metadata)
  if (!parent) return null
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw failure('Object metadata is not a regular directory.', 'DIRECTORY_IDENTITY_INVALID')
  const path = join(metadata, 'directory-identity.json')
  const info = await optionalInfo(path)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096n) throw failure('Directory identity is not a bounded regular file.', 'DIRECTORY_IDENTITY_INVALID')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size > 4096) throw failure('Directory identity is not a bounded regular file.', 'DIRECTORY_IDENTITY_INVALID')
    let value
    try { value = JSON.parse(await handle.readFile('utf8')) }
    catch { throw failure('Directory identity metadata is unreadable or invalid.', 'DIRECTORY_IDENTITY_INVALID') }
    if (!value || value.version !== 1 || value.identityDirectoryPath !== expected ||
        Object.keys(value).sort().join(',') !== 'identityDirectoryPath,version') {
      throw failure('Directory identity does not match this original Scratch object.', 'DIRECTORY_IDENTITY_INVALID')
    }
    return value
  } finally { await handle.close() }
}

async function retainIdentity(directory, expected) {
  const previous = await readIdentity(directory, expected)
  if (previous) return previous
  const metadata = join(directory, '.agentmux')
  await ensureDirectory(metadata)
  const path = join(metadata, 'directory-identity.json')
  let handle
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readIdentity(directory, expected)
    if (!existing) throw failure('The identity write result is unknown.', 'DIRECTORY_IDENTITY_INVALID')
    return existing
  }
  // An incomplete write is retained as an explicit error, never overwritten on retry.
  try {
    await handle.writeFile(JSON.stringify({ version: 1, identityDirectoryPath: expected }) + '\n')
    await handle.sync()
  } finally { await handle.close() }
  await syncDirectory(metadata)
  await syncDirectory(directory)
  const confirmed = await readIdentity(directory, expected)
  if (!confirmed) throw failure('The saved directory identity could not be confirmed.', 'DIRECTORY_IDENTITY_INVALID')
  return confirmed
}

async function runHelper(helperPath, args) {
  const child = spawn(helperPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', value => { stderr += value })
  const result = await new Promise((resolveChild, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolveChild({ exitCode, signal }))
  })
  if (result.exitCode !== 0) {
    const operation = stderr.match(/operation=([^\s]+)/)?.[1]
    const uncertain = result.signal || !operation || operation.startsWith('after-commit-')
    throw failure(`Atomic directory migration did not confirm success (${result.signal ?? result.exitCode}): ${stderr.trim()}`, uncertain ? 'DIRECTORY_MIGRATION_RESULT_UNKNOWN' : 'DIRECTORY_MIGRATION_HELPER_FAILED')
  }
}

async function confirmAlias(source, destination, original, expectedLink) {
  const sourceInfo = await lstat(source, { bigint: true })
  const destinationInfo = await requireDirectory(destination)
  if (!sourceInfo.isSymbolicLink() || await readlink(source) !== expectedLink ||
      !sameIdentity(identity(destinationInfo), original) || await realpath(source) !== await realpath(destination) ||
      !sameIdentity(identity(await stat(source, { bigint: true })), original) ||
      !await readIdentity(destination, source)) {
    throw failure('The migrated directory and its original alias could not be confirmed.', 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
  }
}

/** Only exact legacy Scratch objects are migrated. Caller owns activation and Run continuity. */
export async function migrateTopicDirectories({ home = homedir(), execute = false, helperPath = defaultHelper } = {}) {
  const root = join(resolve(home), '.agentmux')
  const legacyRoot = join(root, 'scratch')
  const report = { version: 1, mode: execute ? 'execute' : 'dry-run', legacyRoot, objects: [], looseEntries: [], issues: [], success: true }
  let rootInfo
  try {
    if (!await optionalInfo(root)) return report
    rootInfo = await requireDirectory(root)
    if (!await optionalInfo(legacyRoot)) return report
    await requireDirectory(legacyRoot)
  } catch (error) {
    report.issues.push(issue(error, 'The original directory could not be inspected.'))
    report.success = false
    return report
  }
  const entries = await readdir(legacyRoot)
  entries.sort()
  for (const name of entries) {
    const match = directoryPattern.exec(name)
    if (!match) { report.looseEntries.push(name); continue }
    const id = `${match[1]}:${match[2]}`
    const sourcePath = join(legacyRoot, name)
    const row = { id, sourcePath, identityDirectoryPath: sourcePath, state: 'unknown' }
    report.objects.push(row)
    try {
      const sourceInfo = await lstat(sourcePath, { bigint: true })
      if (sourceInfo.isSymbolicLink()) {
        const link = await readlink(sourcePath)
        const parent = link === `../motes/${name}` ? 'motes' : link === `../topics/${name}` ? 'topics' : null
        if (!parent) throw failure('The existing link is not an exact migrated object alias.', 'DIRECTORY_MIGRATION_ALIAS_INVALID')
        await requireDirectory(join(root, parent))
        const destinationPath = join(root, parent, name)
        const destinationInfo = await requireDirectory(destinationPath)
        const kind = await classify(destinationPath, id)
        if (parent !== (kind === 'mote' ? 'motes' : 'topics')) throw failure('The alias destination conflicts with the confirmed object kind.', 'DIRECTORY_MIGRATION_ALIAS_INVALID')
        await confirmAlias(sourcePath, destinationPath, identity(destinationInfo), link)
        Object.assign(row, { kind, destinationPath, ...identity(destinationInfo), state: 'already-migrated' })
        continue
      }
      if (!sourceInfo.isDirectory()) throw failure('The original entity is not a regular directory.', 'DIRECTORY_MIGRATION_KIND_UNKNOWN')
      const kind = await classify(sourcePath, id)
      const parent = kind === 'mote' ? 'motes' : 'topics'
      const destinationPath = join(root, parent, name)
      Object.assign(row, { kind, destinationPath, ...identity(sourceInfo) })
      const parentInfo = await optionalInfo(join(root, parent))
      if (parentInfo && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())) throw failure('The canonical root is not a regular directory.', 'DIRECTORY_MIGRATION_ROOT_INVALID')
      if (await optionalInfo(destinationPath)) throw failure('The canonical target already exists; neither object is replaced.', 'DIRECTORY_MIGRATION_TARGET_EXISTS')
      await readIdentity(sourcePath, sourcePath)
      if (!execute) { row.state = 'planned'; continue }
      if (process.platform !== 'darwin') throw failure('Atomic alias exchange is unavailable on this platform; the original object remains available.', 'DIRECTORY_MIGRATION_UNSUPPORTED')
      await ensureDirectory(join(root, parent))
      await syncDirectory(root)
      await retainIdentity(sourcePath, sourcePath)
      await runHelper(helperPath, ['--alias-swap', root, rootInfo.dev.toString(), rootInfo.ino.toString(), `scratch/${name}`, `${parent}/${name}`, sourceInfo.dev.toString(), sourceInfo.ino.toString()])
      await confirmAlias(sourcePath, destinationPath, identity(sourceInfo), `../${parent}/${name}`)
      row.state = 'migrated'
    } catch (error) {
      row.state = error.code === 'DIRECTORY_MIGRATION_KIND_UNKNOWN' || error.code === 'DIRECTORY_MIGRATION_RESULT_UNKNOWN' ? 'unknown' : 'error'
      row.issue = issue(error, 'The object migration could not be confirmed.')
      report.success = false
    }
  }
  return report
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let execute = false, modeSeen = false, home = homedir(), helperPath = defaultHelper
  try {
    for (let index = 2; index < process.argv.length; index += 1) {
      const arg = process.argv[index]
      if (arg === '--execute' || arg === '--dry-run') {
        if (modeSeen) throw new Error('Choose one migration mode.')
        modeSeen = true; execute = arg === '--execute'
      } else if (arg === '--home' || arg === '--helper-path') {
        const value = process.argv[++index]
        if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${arg}.`)
        if (arg === '--home') home = value
        else helperPath = resolve(value)
      } else if (arg === '--help') {
        process.stdout.write('Usage: migrate-topic-directories.mjs [--dry-run | --execute] [--home HOME] [--helper-path HELPER]\n')
        process.exit(0)
      } else throw new Error(`Unknown option: ${arg}`)
    }
    const report = await migrateTopicDirectories({ home, execute, helperPath })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (!report.success) process.exitCode = 1
  } catch (error) {
    process.stderr.write(JSON.stringify({ issue: issue(error, 'Migration failed.') }) + '\n')
    process.exitCode = 1
  }
}
