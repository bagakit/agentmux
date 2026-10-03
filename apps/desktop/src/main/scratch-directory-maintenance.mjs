import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, readlink, realpath, stat, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { inspectDirectoryIdentity, retainDirectoryIdentity, normalizeDirectoryIdentity, moteDirectoryName,
  SCRATCH_DIRECTORY_IDENTITY_PATH, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH } from './scratch-directory-identity.mjs'

const directoryPattern = /^topic--(launcher|session|view)--([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/
const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')
const failure = (message, code) => Object.assign(new Error(message), { code })
const issue = error => ({ code: error?.code ?? 'DIRECTORY_MIGRATION_FAILED', message: error instanceof Error ? error.message : String(error) })
const identity = info => ({ dev: info.dev.toString(), ino: info.ino.toString() })
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function optionalInfo(path) { try { return await lstat(path, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function requireDirectory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('A directory maintenance root or object is not regular.', 'DIRECTORY_MIGRATION_ROOT_INVALID')
  return info
}
async function syncDirectory(path) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync() } finally { await handle.close() } }
async function ensureDirectory(path) { try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error } return await requireDirectory(path) }
async function classify(path, id) {
  if (id === 'launcher:leader') return 'mote'
  const soul = await optionalInfo(join(path, 'SOUL.md'))
  if (!soul) return 'topic'
  if (soul.isFile() && !soul.isSymbolicLink()) return 'mote'
  throw failure('SOUL.md is not a confirmed regular file; this object is not moved.', 'DIRECTORY_MIGRATION_KIND_UNKNOWN')
}
async function runHelper(helperPath, args, hooks = {}) {
  const phases = [[3, '--before-commit-barrier', hooks.beforeSwap], [5, '--after-commit-barrier', hooks.afterSwap],
    [7, hooks.afterStageCreate ? '--after-stage-create-barrier' : '--after-witness-barrier', hooks.afterStageCreate ?? hooks.afterWitness],
    [9, '--before-finalize-barrier', hooks.beforeFinalize], [11, '--last-swap-barrier', hooks.lastSwap]]
  for (const [, flag, action] of phases) if (action) args.push(flag)
  if (hooks.syncFault) args.push('--alias-sync-fault', hooks.syncFault)
  const child = spawn(helperPath, args, { stdio: ['ignore', 'ignore', 'pipe', ...Array(10).fill('pipe')] })
  let stderr = '', fault
  child.stderr.on('data', bytes => { stderr += bytes })
  for (const [fd, , action] of phases) if (action) child.stdio[fd].once('data', () => {
    void Promise.resolve().then(() => action(child)).then(() => child.stdio[fd + 1].end('R'), error => { fault = error; child.kill('SIGKILL') })
  })
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  if (result.code !== 0) throw failure(`Directory exchange is unconfirmed (${result.signal ?? result.code}): ${stderr.trim() || fault?.message || ''}. Original content and transaction witnesses are kept; retry this same maintenance repair.`, 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
}
async function exchange({ root, rootInfo, source, destination, object, context, helperPath, hooks }) {
  const actualObject = await realpath(object), current = await inspectDirectoryIdentity(actualObject, context)
  if (!current) throw failure('The original identity record is unavailable.', 'DIRECTORY_IDENTITY_INVALID')
  const raw = current.pending ?? current.current
  const objectInfo = await requireDirectory(actualObject)
  await runHelper(helperPath, ['--alias-swap', root, String(rootInfo.dev), String(rootInfo.ino), relative(root, source), relative(root, destination),
    String(objectInfo.dev), String(objectInfo.ino), '--witness', SCRATCH_DIRECTORY_IDENTITY_PATH, SCRATCH_DIRECTORY_IDENTITY_PENDING_PATH,
    SCRATCH_DIRECTORY_ALIAS_PENDING_PATH, String(current.parent.dev), String(current.parent.ino), String(raw.info.dev), String(raw.info.ino), digest(raw.bytes)], hooks)
  const newObject = await requireDirectory(await realpath(destination)), oldAlias = await lstat(source, { bigint: true })
  if (!same(newObject, objectInfo) || !oldAlias.isSymbolicLink() || await readlink(source) !== `../${relative(root, destination)}` ||
      !same(await stat(source, { bigint: true }), objectInfo)) throw failure('Original aliases changed after the confirmed exchange.', 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
  const confirmed = await inspectDirectoryIdentity(destination, context)
  if (!confirmed || confirmed.needsUpgrade || confirmed.identityDirectoryPath !== current.identityDirectoryPath)
    throw failure('Original identity confirmation is unavailable after exchange.', 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
}

/** The sole explicit/startup directory write owner. Discovery and preview never mutate. */
export async function migrateTopicDirectories({ home = homedir(), scratchRoot = join(resolve(home), '.agentmux/scratch'), execute = false,
  motesOnly = false, helperPath = defaultHelper, nativeOptions = {} } = {}) {
  scratchRoot = resolve(scratchRoot)
  const logicalRoot = dirname(scratchRoot), roots = { scratch: scratchRoot, topics: join(logicalRoot, 'topics'), motes: join(logicalRoot, 'motes') }
  const report = { version: 1, mode: execute ? 'execute' : 'dry-run', legacyRoot: scratchRoot, objects: [], looseEntries: [], issues: [], success: true }
  let root, rootInfo
  try { if (!await optionalInfo(logicalRoot)) return report; root = await realpath(logicalRoot); rootInfo = await requireDirectory(root) }
  catch (error) { report.issues.push(issue(error)); report.success = false; return report }
  const context = { roots: { scratch: [], topics: [], motes: [] } }, ids = new Set(), hashEntries = []
  for (const role of ['scratch', 'topics', 'motes']) {
    try {
      if (!await optionalInfo(roots[role])) { context.roots[role] = [roots[role]]; continue }
      await requireDirectory(roots[role]); const actual = await realpath(roots[role])
      context.roots[role] = [...new Set([roots[role], actual])]
      for (const name of (await readdir(actual)).sort()) {
        const match = directoryPattern.exec(name)
        if (match) ids.add(`${match[1]}:${match[2]}`)
        else if (role === 'motes' && /^[0-9a-f]{16}$/.test(name)) hashEntries.push({ path: join(actual, name), name })
        else if (role === 'scratch') report.looseEntries.push(name)
      }
    } catch (error) { report.issues.push({ ...issue(error), root: role }); report.success = false }
  }
  for (const entry of hashEntries) {
    try {
      const info = await lstat(entry.path)
      // Its known long-ID row must prove the exact same-operation stage before any write.
      if (info.isSymbolicLink() && [...ids].some(id => moteDirectoryName(id) === entry.name)) continue
      await requireDirectory(entry.path)
      const saved = await inspectDirectoryIdentity(entry.path, context)
      if (!saved?.topicId || moteDirectoryName(saved.topicId) !== entry.name) throw failure('The short directory full identity is unconfirmed.', 'DIRECTORY_IDENTITY_INVALID')
      ids.add(saved.topicId)
    } catch (error) { report.issues.push({ ...issue(error), directoryName: entry.name }); report.success = false }
  }
  for (const id of [...ids].sort()) {
    const long = `topic--${id.replace(':', '--')}`, short = moteDirectoryName(id), local = { ...context, topicId: id }
    const addresses = [...(context.roots.scratch.length ? [join(roots.scratch, long)] : []),
      ...(context.roots.topics.length ? [join(roots.topics, long)] : []),
      ...(context.roots.motes.length ? [join(roots.motes, long), join(roots.motes, short)] : [])]
    const row = { id, sourcePath: addresses[0], identityDirectoryPath: addresses[0], state: 'unknown' }; report.objects.push(row)
    try {
      const entries = []
      for (const address of addresses) { const info = await optionalInfo(address); if (info) entries.push({ address, actual: resolve(root, relative(logicalRoot, address)), info }) }
      const physicals = entries.filter(e => e.info.isDirectory() && !e.info.isSymbolicLink())
      if (physicals.length !== 1) throw failure('Original object locations conflict or are unavailable; all bytes are kept.', physicals.length > 1 ? 'DIRECTORY_MIGRATION_TARGET_EXISTS' : 'DIRECTORY_MIGRATION_ALIAS_INVALID')
      let physical = physicals[0].actual, logicalPhysical = physicals[0].address
      const objectInfo = physicals[0].info, saved = await inspectDirectoryIdentity(physical, local)
      if (basename(physical) === short && (!saved || saved.topicId !== id)) throw failure('The short directory has no confirmed full ID.', 'DIRECTORY_IDENTITY_INVALID')
      const kind = await classify(physical, id)
      Object.assign(row, { kind, sourcePath: logicalPhysical, ...identity(objectInfo), identityDirectoryPath: saved?.identityDirectoryPath ?? logicalPhysical,
        destinationPath: kind === 'mote' ? join(roots.motes, short) : join(roots.topics, long) })
      if (motesOnly && kind !== 'mote') { row.state = 'unchanged'; continue }
      const witnessStage = await optionalInfo(join(physical, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH))
      const witnessLink = witnessStage?.isSymbolicLink() ? await readlink(join(physical, SCRATCH_DIRECTORY_ALIAS_PENDING_PATH)) : null
      const stagedTarget = witnessLink?.startsWith('../') ? resolve(logicalRoot, witnessLink.slice(3)) : null
      let ownedSource = null
      for (const entry of entries.filter(e => e.info.isSymbolicLink())) {
        const link = await readlink(entry.address), target = resolve(dirname(entry.address), link)
        if (!addresses.includes(target) || target === entry.address) {
          if (witnessStage && saved?.pending && saved.current && same(saved.pending.info, saved.current.info) &&
              same(witnessStage, entry.info) && link === witnessLink && stagedTarget === entry.address && target === entry.address) continue
          throw failure('An existing alias is not the exact same owned object or stage.', target === entry.address ? 'DIRECTORY_MIGRATION_TARGET_EXISTS' : 'DIRECTORY_MIGRATION_ALIAS_INVALID')
        }
        if (await realpath(entry.address) !== await realpath(physical)) throw failure('The alias does not reach the original object.', 'DIRECTORY_MIGRATION_ALIAS_INVALID')
        if (witnessStage && same(entry.info, witnessStage)) { if (ownedSource) throw failure('The original staged alias is ambiguous.', 'DIRECTORY_MIGRATION_ALIAS_INVALID'); ownedSource = entry.actual }
      }
      if (!saved && entries.some(e => e.info.isSymbolicLink())) throw failure('The relocated original identity record is missing.', 'DIRECTORY_IDENTITY_INVALID')
      if (saved?.aliasPending && (!saved.pending || !witnessStage)) throw failure('This operation is missing an original witness. Preserve its residue and inspect the same object.', 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
      if (!execute) { row.state = basename(physical) === short && !saved?.needsUpgrade ? 'already-migrated' : 'planned'; continue }
      if (process.platform !== 'darwin') throw failure('Atomic alias exchange is unavailable; original working capability is retained.', 'DIRECTORY_MIGRATION_UNSUPPORTED')
      if (!saved?.aliasPending) {
        if (saved) await normalizeDirectoryIdentity(physical, local, { helperPath })
        else await retainDirectoryIdentity(physical, { ...local, original: row.identityDirectoryPath }, { helperPath })
      }
      const destinationRoot = kind === 'mote' ? roots.motes : roots.topics
      await ensureDirectory(destinationRoot); await syncDirectory(root)
      if (saved?.aliasPending && ownedSource) {
        if (stagedTarget !== logicalPhysical) throw failure('The committed operation does not witness this exact destination.', 'DIRECTORY_MIGRATION_RESULT_UNKNOWN')
        await exchange({ root, rootInfo, source: ownedSource, destination: physical, object: physical, context: local, helperPath, hooks: nativeOptions })
        if (kind !== 'mote' || basename(physical) === short) { row.state = 'already-migrated'; continue }
      }
      const steps = []
      if (kind === 'mote' && dirname(logicalPhysical) === roots.scratch) steps.push(join(root, 'motes', long))
      if (kind === 'mote') steps.push(join(root, 'motes', short))
      else if (dirname(logicalPhysical) === roots.scratch) steps.push(join(root, 'topics', long))
      let moved = false
      for (const destination of steps) if (destination !== physical) {
        await exchange({ root, rootInfo, source: physical, destination, object: physical, context: local, helperPath, hooks: nativeOptions })
        physical = destination; moved = true
      }
      row.state = moved ? 'migrated' : kind === 'mote' ? 'already-migrated' : 'identity-confirmed'
    } catch (error) { row.issue = issue(error); row.state = error.code === 'DIRECTORY_MIGRATION_KIND_UNKNOWN' || error.code === 'DIRECTORY_MIGRATION_RESULT_UNKNOWN' ? 'unknown' : 'error'; report.success = false }
  }
  return report
}

