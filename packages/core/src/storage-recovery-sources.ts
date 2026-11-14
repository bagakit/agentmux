import { basename, dirname, join, relative, resolve } from 'node:path'
import { watch } from 'node:fs'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore } from './agent-session-store.js'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from './errors.js'
import type { RecoveryInputSelector, RecoveryRestoreMember } from './storage-recovery.js'
import { snapshotRecoveryFile, snapshotRecoverySqlite, hashRecoveryFile, recoveryDirectorySource, recoveryDigest, type RecoveryGap, type RecoverySource, type RecoverySourceMember } from './storage-recovery.js'

/** Exact file contribution from its composing owner, without a second business parser. */
export function recoveryFileSource(id: string, path: string, format: 'file' | 'sqlite' = 'file'): RecoverySource {
  return { id, ownedPaths: [path], async capture(directory) {
    const file = join(directory, 'original')
    try { if (format === 'sqlite') await snapshotRecoverySqlite(path, file); else await snapshotRecoveryFile(path, file); const attributes = await lstat(file)
      return { revision: String(attributes.size) + ':' + attributes.mtimeMs, members: [{ id: 'original', file, target: path, kind: 'file', capturedAt: Date.now() }], gaps: [] }
    } catch (error) { return { revision: 'unavailable', members: [], gaps: [{ sourceId: id, code: (error as NodeJS.ErrnoException).code ?? 'RECOVERY_SOURCE_UNAVAILABLE' }] } }
  }, subscribe(changed, unavailable) {
    const watcher = watch(dirname(path), (_event, name) => { if (name && String(name) === basename(path)) changed() })
    watcher.on('error', error => { unavailable?.({ sourceId: id, code: (error as NodeJS.ErrnoException).code ?? 'RECOVERY_WATCH_UNAVAILABLE' }); changed() })
    return () => watcher.close()
  } }
}

/** The semantic owner contributes only its own state namespace, excluding ctxmux and recovery storage. */
export function semanticRecoverySource(directory: string, recoveryDirectory: string, ownedPaths: readonly string[],
  validateIdentity?: (members: readonly RecoveryRestoreMember[]) => Promise<void>): RecoverySource {
  const authorityRoots = ['agent-creation-trusted-sources', 'agent-message-trusted-sources'].map(name => resolve(directory, name))
  const authorityFile = (target: string) => authorityRoots.some(root => resolve(target) === root || resolve(target).startsWith(root + '/'))
  const source = recoveryDirectorySource('core.semantic', directory, { restoreInertFiles: true, watchPaths: ownedPaths, exclude: path => {
    const selected = ownedPaths.some(target => path === target || path.startsWith(target + '/') || target.startsWith(path + '/'))
    return path !== directory && !selected || path === recoveryDirectory || path.startsWith(recoveryDirectory + '/') ||
      /(?:\.lock|\.identity-candidate|\.recovery-candidate)$/u.test(path)
  } })
  return { ...source, async prepareRestore(members, output) {
    const unavailable = members.filter(member => authorityFile(member.target))
    if (unavailable.length) return { state: 'unavailable', selectors: unavailable.map(member => ({ memberId: member.id, reason: 'RECOVERY_AUTHORITY_REAPPROVAL_REQUIRED' })) }
    await validateIdentity?.(members)
    await mkdir(output, { mode: 0o700 })
    const prepared = []
    for (const member of members) {
      const file = join(output, recoveryDigest(member.id)); await snapshotRecoveryFile(member.file, file)
      prepared.push({ ...member, file, sha256: (await hashRecoveryFile(file)).sha256 })
    }
    return { state: 'prepared', members: prepared }
  }, async restoreMissing(member) {
    // A backup proves historical approval, never a current permission grant.
    // Missing pins may have been deliberately revoked by their original owner.
    if (authorityFile(member.target)) throw new AgentMuxError('The original source permission needs explicit approval through its existing trust owner. The backup and healthy Agents were retained.', 'RECOVERY_AUTHORITY_REAPPROVAL_REQUIRED')
    if (/\/(?:semantic-runtime|agent-creation-identity)\.json(?:\.original)?$/u.test(member.target)) {
      const counterpart = member.target.endsWith('.original') ? member.target.slice(0, -9) : member.target + '.original'
      try { if ((await hashRecoveryFile(counterpart)).sha256 !== member.sha256) return 'conflict' }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return await source.restoreMissing!(member)
  } }
}

/** Explicitly selected original Session owner; SQLite capture is implemented under its stable lock. */
export function sessionRecoverySource(store: AgentMuxFileAgentSessionStore): RecoverySource {
  const previewInput = async (file: string, selector: RecoveryInputSelector) => {
    const original = new AgentMuxFileAgentSessionStore(file)
    const [before, current] = await Promise.all([original.readHistorySource(selector.agentSessionId), store.readHistorySource(selector.agentSessionId)])
    const binding = (value: typeof before) => value && ({ hostId: value.hostId, providerId: value.history?.providerId,
      workspacePath: value.history?.workspacePath, nativeHandle: value.history?.nativeHandle })
    if (!before || !current || !isDeepStrictEqual(binding(before), binding(current)) || await store.readRecordDeletion(selector.agentSessionId)) throw new AgentMuxError('The retained input belongs to another original Session binding or deleted record.', 'STORAGE_RECOVERY_INVALID')
    const input = await original.readPromptAdmission(selector.agentSessionId, { runId: selector.runId }, selector.submissionId)
    if (!input) throw new AgentMuxError('The selected original input evidence is unavailable.', 'STORAGE_RECOVERY_INVALID')
    return await store.previewRecoveryPromptAdmission(input)
  }
  return { id: 'core.sessions', ownedPaths: [store.path, store.path + '.sqlite-identity', store.path + '.sqlite-identity.original'], capture: directory => store.captureRecovery(directory),
    prepareRestore: async (members, directory) => {
      await mkdir(directory, { mode: 0o700 })
      const database = members.find(member => member.id === 'database')
      let prepared: Awaited<ReturnType<typeof store.prepareRecoveryRestore>> | undefined
      if (database) {
        const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(database.file, { readOnly: true })
        let incarnation: string; try { incarnation = String(db.prepare('SELECT incarnation FROM identity').get()?.incarnation ?? '') } finally { db.close() }
        prepared = await store.prepareRecoveryRestore({ sourcePath: database.file, stagingPath: join(directory, 'session'), operationId: database.operationId, expectedIncarnation: incarnation })
        if (prepared.state === 'unavailable') return { state: 'unavailable', selectors: prepared.selectors.map(selector => ({ agentSessionId: selector.agentSessionId, reason: selector.reason })) }
      }
      const result = []
      for (const member of members) {
        const file = member.id === 'database' && prepared?.state === 'prepared' ? prepared.file : join(directory, recoveryDigest(member.id))
        if (member.id !== 'database') await snapshotRecoveryFile(member.file, file)
        result.push({ ...member, file, sha256: (await hashRecoveryFile(file)).sha256 })
      }
      return { state: 'prepared', members: result, ...(prepared?.state === 'prepared' ? { metadata: { heldInitialInputs: prepared.heldInitialInputs, heldFutureIntents: prepared.heldFutureIntents } } : {}) }
    },
    previewInput: async (file, selector) => { const { current, next } = await previewInput(file, selector); return { baselineHash: recoveryDigest(JSON.stringify(current)), resultHash: recoveryDigest(JSON.stringify(next)) } },
    restoreInput: async (file, selector, baselineHash, resultHash) => {
      const { current, next } = await previewInput(file, selector)
      if (recoveryDigest(JSON.stringify(next)) !== resultHash || ![baselineHash, resultHash].includes(recoveryDigest(JSON.stringify(current)))) throw new AgentMuxError('The exact original input changed after preflight. Reinspect this operation.', 'STALE_AGENT_SESSION')
      // Even an equal record reconfirms the original Store transaction and durable ACK.
      await store.settlePromptAdmission(current, next)
    },
    restoreMissing: member => store.restoreRecoveryMember(member), subscribe: (changed, unavailable) => {
      const stop = store.observeDurableChanges(changed)
      let watcher: ReturnType<typeof watch>
      try { watcher = watch(dirname(store.path), (_event, name) => {
        if (name && [basename(store.path), basename(store.path) + '.sqlite-identity', basename(store.path) + '.sqlite-identity.original'].includes(String(name))) changed()
      }); watcher.on('error', error => { unavailable?.({ sourceId: 'core.sessions', code: (error as NodeJS.ErrnoException).code ?? 'RECOVERY_WATCH_UNAVAILABLE' }); changed() }) }
      catch (error) { stop(); throw error }
      return () => { stop(); watcher.close() }
    } }
}

/** A source set is composed by the same Client that owns these durable namespaces. */
export function coreJournalRecoverySource(id: string, paths: readonly string[]): RecoverySource {
  const directorySources = paths.map((path, index) => recoveryDirectorySource(id + ':' + index, path))
  return { id, ownedPaths: paths,
    subscribe(changed, unavailable) { const stops = directorySources.map(source => source.subscribe?.(changed, gap => unavailable?.({ ...gap, sourceId: id }))); return () => { for (const stop of stops) stop?.() } },
    async capture(directory) {
      const members: RecoverySourceMember[] = [], gaps: RecoveryGap[] = []
      for (let index = 0; index < directorySources.length; index++) {
        const source = directorySources[index]!, output = join(directory, String(index)); await mkdir(output, { mode: 0o700 })
        // Missing optional owner namespaces are explicit not-created coverage,
        // rather than empty snapshots masquerading as retained originals.
        try { await lstat(paths[index]!) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { gaps.push({ sourceId: id, memberId: String(index), code: 'RECOVERY_OWNER_NOT_CREATED' }); continue }
          throw error
        }
        const capture = await source.capture(output)
        for (const member of capture.members) members.push({ ...member, id: `${index}/${member.id}` })
        gaps.push(...capture.gaps.map(gap => ({ ...gap, sourceId: id })))
      }
      return { revision: recoveryDigest(JSON.stringify(members.map(member => [member.id, member.capturedAt]))), members, gaps }
    }
  }
}

/** Retained legacy originals are evidence, never a second live catalog. */
export function legacySessionRecoverySource(storePath: string): RecoverySource {
  const id = 'core.session-originals'
  return { id, async capture(directory) {
    const prefix = basename(storePath) + '.original-', members: RecoverySourceMember[] = []
    for (const name of await readdir(dirname(storePath))) if (name.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(name.slice(prefix.length))) {
      const target = join(dirname(storePath), name), file = join(directory, name.slice(prefix.length))
      await snapshotRecoveryFile(target, file)
      if ((await hashRecoveryFile(file)).sha256 !== name.slice(prefix.length)) throw new Error('The original Session import archive changed.')
      members.push({ id: name, target, file, kind: 'file', capturedAt: Date.now() })
    }
    return { revision: recoveryDigest(JSON.stringify(members.map(member => member.id))), members, gaps: [] }
  } }
}
