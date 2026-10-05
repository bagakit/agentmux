import { isScratchTopicId, scratchTopicDirectoryName, scratchTopicIdFromDirectoryName } from '../shared/scratch-topic-identity.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { constants, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export const SCRATCH_DIRECTORY_IDENTITY_PATH = '.agentmux/directory-identity.json'
export const SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH = '.agentmux/directory-identity.pending.json'
export const SCRATCH_DIRECTORY_ALIAS_PENDING_PATH = '.agentmux/directory-identity.pending.alias'
const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')
const invalid = message => Object.assign(new Error(message), { code: 'DIRECTORY_IDENTITY_INVALID' })
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const hash = path => createHash('sha256').update(path).digest('hex')

const roles = ['scratch', 'topics', 'motes']
export function moteDirectoryName(topicId) {
  if (!isScratchTopicId(topicId)) throw invalid('The full Mote content identity is unconfirmed.')
  return hash(topicId).slice(0, 16)
}

function identityCandidates(context, name, role) {
  return [...new Set((role ? context.roots[role] ?? [] : roles.flatMap(key => context.roots[key] ?? []))
    .map(root => join(root, name)))]
}

export function directoryIdentityRecord(original) {
  if (typeof original === 'string') {
    const name = basename(original)
    if (!scratchTopicIdFromDirectoryName(name)) throw invalid('The original directory name is unconfirmed.')
    return { version: 2, identityDirectoryName: name, identityPathHash: hash(original) }
  }
  const name = basename(original.original ?? '')
  const id = original.topicId
  if (!isScratchTopicId(id) || !original.original) throw invalid('The original full content identity is unconfirmed.')
  const matched = roles.filter(role => identityCandidates(original, name, role).includes(original.original))
  if (matched.length !== 1 || !(name === scratchTopicDirectoryName(id) || matched[0] === 'motes' && name === moteDirectoryName(id)))
    throw invalid('The original identity root or name is unconfirmed.')
  return { version: 3, topicId: id, identityRoot: matched[0], identityDirectoryName: name, identityPathHash: hash(original.original) }
}

function verifiedRecord(value, original) {
  if (typeof original === 'string') {
    const expected = directoryIdentityRecord(original)
    const legacy = value?.version === 1 && Object.keys(value).sort().join(',') === 'identityDirectoryPath,version' && value.identityDirectoryPath === original
    const current = value?.version === 2 && Object.keys(value).sort().join(',') === 'identityDirectoryName,identityPathHash,version' && value.identityDirectoryName === expected.identityDirectoryName && value.identityPathHash === expected.identityPathHash
    if (!legacy && !current) throw invalid('Directory identity is unconfirmed. Repair the original identity record before retrying.')
    return { identityDirectoryPath: original, needsUpgrade: legacy, expectedRecord: expected }
  }
  const keys = value && Object.keys(value).sort().join(',')
  const legacy = value?.version === 1 && keys === 'identityDirectoryPath,version' && typeof value.identityDirectoryPath === 'string'
  const relative = value?.version === 2 && keys === 'identityDirectoryName,identityPathHash,version'
  const current = value?.version === 3 && keys === 'identityDirectoryName,identityPathHash,identityRoot,topicId,version'
  if (!legacy && !relative && !current) throw invalid('Directory content identity record is invalid.')
  const name = legacy ? basename(value.identityDirectoryPath) : value.identityDirectoryName
  const id = current ? value.topicId : typeof name === 'string' ? scratchTopicIdFromDirectoryName(name) : null
  if (!isScratchTopicId(id) || original.topicId && original.topicId !== id ||
      !(name === scratchTopicDirectoryName(id) || current && value.identityRoot === 'motes' && name === moteDirectoryName(id)) ||
      current && !roles.includes(value.identityRoot)) throw invalid('Directory full content ID or original root is unconfirmed.')
  const candidates = identityCandidates(original, name, current ? value.identityRoot : undefined)
    .filter(path => legacy ? path === value.identityDirectoryPath : /^[0-9a-f]{64}$/.test(value.identityPathHash) && hash(path) === value.identityPathHash)
  if (candidates.length !== 1 || original.original && original.original !== candidates[0])
    throw invalid('The exact original directory address is unconfirmed. Existing bindings and files are kept.')
  const identityDirectoryPath = candidates[0]
  return { identityDirectoryPath, topicId: id, needsUpgrade: !current,
    expectedRecord: directoryIdentityRecord({ ...original, topicId: id, original: identityDirectoryPath }) }
}

/** The legacy witness is exposed only with an explicit recovery diagnostic, never v2 success. */
export class DirectoryIdentityUpgradeRequiredError extends Error {
  code = 'DIRECTORY_IDENTITY_UPGRADE_REQUIRED'
  constructor(original) {
    super('Directory metadata upgrade is unconfirmed. Its confirmed original identity, files and healthy Agent work are kept. Restore storage access, then retry directory identity repair.')
    this.identityDirectoryPath = original
  }
}

/** A read-only, bounded inspection shared by the original reader and metadata maintenance. */
export async function inspectDirectoryIdentity(directory, original) {
  const metadata = join(directory, '.agentmux')
  let parent
  try { parent = await lstat(metadata, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid('Directory identity metadata is not a regular directory.')
  async function record(path) {
    let handle
    try { handle = await open(join(directory, path), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || info.size > 4096) throw invalid('Directory identity metadata is not a bounded regular file.')
      const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 4096 || (await handle.stat({ bigint: true })).size > 4096) throw invalid('Directory identity metadata is not a bounded regular file.')
      const bytes = buffer.subarray(0, bytesRead).toString('utf8')
      let value
      try { value = JSON.parse(bytes) } catch { throw invalid('Directory identity metadata is unreadable or invalid.') }
      return { record: value, bytes, info, ...verifiedRecord(value, original) }
    } finally { await handle.close() }
  }
  // Pending is the moved original record, not a second identity or a guessed current address.
  let pending = await record(SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH)
  let current = await record(SCRATCH_DIRECTORY_IDENTITY_PATH)
  if (!pending && !current) {
    pending = await record(SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH)
    current = await record(SCRATCH_DIRECTORY_IDENTITY_PATH)
  }
  const after = await lstat(metadata, { bigint: true })
  if (!after.isDirectory() || after.isSymbolicLink() || !same(parent, after)) throw invalid('Directory identity metadata changed while reading.')
  if (!current && !pending) {
    if ((await readdir(metadata)).some(name => name === 'directory-identity.pending.json' || name === 'directory-identity.pending.alias' || /^directory-identity\..+\.tmp$/.test(name)))
      throw invalid('Directory identity publication is unfinished and its original witness is unavailable. Its existing files and workfaces are kept; inspect the same object before retrying.')
    return null
  }
  const witness = pending ?? current
  if (pending && current && (pending.identityDirectoryPath !== current.identityDirectoryPath || pending.topicId !== current.topicId))
    throw invalid('Pending and current records do not witness the same original object.')
  const entries = await readdir(metadata)
  const aliasStage = entries.some(name => name === 'directory-identity.pending.alias' || name.startsWith('directory-identity.pending.alias.'))
  const aliasPending = aliasStage ||
    Boolean(pending && current && same(pending.info, current.info))
  return { ...witness, needsUpgrade: Boolean(pending || current.needsUpgrade || aliasPending), aliasPending, aliasStage, parent, current, pending }
}

export async function readDirectoryIdentity(directory, original) {
  const inspected = await inspectDirectoryIdentity(directory, original)
  if (inspected?.aliasPending) throw new DirectoryAliasConfirmationRequiredError(inspected.identityDirectoryPath)
  if (inspected?.needsUpgrade) throw new DirectoryIdentityUpgradeRequiredError(inspected.identityDirectoryPath)
  return inspected?.identityDirectoryPath ?? null
}

export class DirectoryAliasConfirmationRequiredError extends DirectoryIdentityUpgradeRequiredError {
  constructor(original) {
    super(original)
    this.message = 'Directory relocation is unconfirmed. Its original identity, files and healthy Agent work are kept. Retry the same directory maintenance repair to confirm the original aliases and durable storage.'
  }
}

async function runFilePublication(mode, directory, root, before, temporary, options) {
  const currentPath = SCRATCH_DIRECTORY_IDENTITY_PATH, pendingPath = SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH
  const expected = before.pending ?? before.current
  const wanted = mode === '--file-confirm' ? before.current.bytes : JSON.stringify(before.expectedRecord) + '\n'
  const args = [mode, directory, String(root.dev), String(root.ino), currentPath,
    '.agentmux/' + basename(temporary), pendingPath, String(before.parent.dev), String(before.parent.ino),
    String(expected.info.dev), String(expected.info.ino), hash(expected.bytes), hash(wanted)]
  const beforeCommit = mode === '--file-publish' ? options.beforeCommit : options.beforeConfirm
  const afterClaim = mode === '--file-publish' ? options.afterClaim : undefined
  if (beforeCommit) args.push('--before-commit-barrier')
  if (afterClaim) args.push('--after-commit-barrier')
  if (mode === '--file-publish' && options.publicationSyncFault) args.push('--file-sync-fault')
  const child = spawn(options.helperPath ?? defaultHelper, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
  let stderr = '', fault
  child.stderr.on('data', bytes => { stderr += bytes })
  const barrier = (index, action) => {
    if (!action) return
    child.stdio[index].once('data', () => { void Promise.resolve().then(action).then(() => child.stdio[index + 1].end('R'), error => { fault = error; child.kill('SIGKILL') }) })
  }
  barrier(3, beforeCommit); barrier(5, afterClaim)
  await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) accept()
      else reject(Object.assign(new Error(`Directory identity publication is unconfirmed: ${stderr.trim() || fault?.message || signal || code}`),
        { code: 'DIRECTORY_IDENTITY_TRANSACTION_UNKNOWN', helperSignal: signal, cause: fault }))
    })
  })
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Reencode the same inspected object; pending retains an unconfirmed operation's original bytes. */
export async function normalizeDirectoryIdentity(directory, original, options = {}) {
  const before = await inspectDirectoryIdentity(directory, original)
  if (!before) return { state: 'unchanged' }
  // A readable current record cannot retire an alias operation's same-inode witness.
  if (before.aliasPending) throw new DirectoryAliasConfirmationRequiredError(before.identityDirectoryPath)
  if (!before.needsUpgrade) {
    const handle = await open(join(directory, SCRATCH_DIRECTORY_IDENTITY_PATH), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
    await syncDirectory(join(directory, '.agentmux')); await syncDirectory(directory)
    const confirmed = await inspectDirectoryIdentity(directory, original)
    if (!confirmed || confirmed.bytes !== before.bytes || confirmed.needsUpgrade || !same(confirmed.info, before.info)) throw invalid('Directory identity changed while confirming its original record.')
    return { state: 'unchanged' }
  }
  const root = await lstat(directory, { bigint: true }), metadata = join(directory, '.agentmux')
  if (!root.isDirectory() || root.isSymbolicLink()) throw invalid('The identity object is not a confirmed regular directory.')
  const temporary = join(metadata, `directory-identity.${process.pid}.${randomUUID()}.tmp`)
  let nativeStarted = false
  const needsPublication = before.current?.needsUpgrade !== false
  try {
    if (needsPublication) {
      await options.beforeWrite?.()
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify(before.expectedRecord) + '\n'); await handle.sync() }
      finally { await handle.close() }
    }
    await options.beforeReplace?.()
    const current = await inspectDirectoryIdentity(directory, original), currentRoot = await lstat(directory, { bigint: true })
    const sameRecord = (a, b) => !a && !b || a && b && a.bytes === b.bytes && same(a.info, b.info)
    if (!current || !sameRecord(current.current, before.current) || !sameRecord(current.pending, before.pending) || !same(current.parent, before.parent) ||
        !currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !same(root, currentRoot))
      throw invalid('The original identity record changed before saving. Its current bytes are kept; inspect the original object before retrying.')
    nativeStarted = true
    if (needsPublication) await runFilePublication('--file-publish', directory, root, before, temporary, options)
    if (needsPublication) await options.afterReplace?.()
    const published = await inspectDirectoryIdentity(directory, original)
    const expectedCurrent = needsPublication ? JSON.stringify(before.expectedRecord) + '\n' : before.current.bytes
    if (!published?.pending || published.current?.needsUpgrade !== false ||
        !sameRecord(published.pending, before.pending ?? before.current) || published.current.bytes !== expectedCurrent)
      throw invalid('The same original publication witness changed or is unconfirmed. Its later bytes are kept; inspect the same object before retrying.')
    const retired = join(metadata, `directory-identity.${process.pid}.${randomUUID()}.retired.tmp`)
    await runFilePublication('--file-confirm', directory, root, published, retired, options)
    const confirmed = await inspectDirectoryIdentity(directory, original)
    if (!confirmed || confirmed.needsUpgrade) throw invalid('The identity upgrade could not be confirmed.')
    return { state: 'upgraded' }
  } catch (cause) {
    let pending
    try { pending = await lstat(join(directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (pending) throw Object.assign(new Error('Directory identity publication or durable confirmation is unknown. Original bytes, content and identity are kept; inspect the same object and retry its original repair.', { cause }),
      { code: 'DIRECTORY_IDENTITY_WRITE_UNKNOWN', replacementApplied: true, originalBytes: before.bytes, helperSignal: cause.helperSignal })
    throw cause
  } finally {
    // A started native action may have retained a competing record at its private stage name.
    if (!nativeStarted) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

/** New migrations write the relative representation before the canonical object is exposed. */
export async function retainDirectoryIdentity(directory, original, options = {}) {
  const previous = await inspectDirectoryIdentity(directory, original)
  if (previous) {
    await normalizeDirectoryIdentity(directory, original, options)
    return await inspectDirectoryIdentity(directory, original)
  }
  const metadata = join(directory, '.agentmux')
  try { await mkdir(metadata, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const parent = await lstat(metadata, { bigint: true })
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid('Directory identity metadata is not a regular directory.')
  const path = join(directory, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH)
  let handle
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await inspectDirectoryIdentity(directory, original)
    if (!existing) throw invalid('The identity write result is unknown.')
    await normalizeDirectoryIdentity(directory, original, options)
    return await inspectDirectoryIdentity(directory, original)
  }
  // Partial creation remains an explicit error; a retry never overwrites it.
  try { await handle.writeFile(JSON.stringify(directoryIdentityRecord(original)) + '\n'); await handle.sync() }
  finally { await handle.close() }
  await syncDirectory(metadata); await syncDirectory(directory)
  await normalizeDirectoryIdentity(directory, original, options)
  const confirmed = await inspectDirectoryIdentity(directory, original)
  if (!confirmed || confirmed.needsUpgrade) throw invalid('The saved directory identity could not be confirmed.')
  return confirmed
}
