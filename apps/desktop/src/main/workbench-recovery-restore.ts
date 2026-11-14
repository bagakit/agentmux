import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxError, durableWriteFile, recoveryDigest, type RecoveryPreparation, type RecoveryRestoreMember } from '@agentmux/core'

export const recoveryUnavailable = (reason: string) => new AgentMuxError('The original Desktop member cannot be restored while its current owner is unconfirmed. Keep the source and current work.', reason)
const stamp = (value: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')

/** The local-user maintenance transport is authority; a supplied path is not. */
export async function readWorkbenchRecoveryMember(member: RecoveryRestoreMember, target: string): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readWorkbenchRecoveryBytes(member, target))
}

export async function readWorkbenchRecoveryBytes(member: RecoveryRestoreMember, target: string): Promise<Buffer> {
  if (member.kind !== 'file' || member.target !== target || !/^[a-f0-9]{64}$/u.test(member.sha256)) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
  const handle = await open(member.file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || (before.mode & 0o077n) !== 0n || process.getuid && before.uid !== BigInt(process.getuid())) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_UNPROTECTED')
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), current = await lstat(member.file, { bigint: true })
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(current) || recoveryDigest(bytes) !== member.sha256) throw recoveryUnavailable('DESKTOP_RECOVERY_SOURCE_CHANGED')
    return bytes
  } finally { await handle.close() }
}

/** A lost publish ACK may be reconciled after UI opens, without a new write. */
export async function confirmExistingWorkbenchRecoveryMember(member: RecoveryRestoreMember, target: string): Promise<'same' | 'conflict' | null> {
  if (member.kind !== 'file' || member.target !== target) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
  let handle
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw recoveryUnavailable('DESKTOP_RECOVERY_MEMBER_MISMATCH')
    if (recoveryDigest(await handle.readFile()) !== member.sha256) return 'conflict'
    await handle.sync()
    // This confirms only the same existing inode, never falls back to publish.
    for (let directory = dirname(target);; directory = dirname(directory)) {
      const parent = await open(directory, 'r'); try { await parent.sync() } finally { await parent.close() }
      if (directory === dirname(directory)) break
    }
    if (stamp(before) !== stamp(await handle.stat({ bigint: true })) || stamp(before) !== stamp(await lstat(target, { bigint: true }))) throw recoveryUnavailable('DESKTOP_RECOVERY_TARGET_CHANGED')
    return 'same'
  } finally { await handle.close() }
}

/** All selected members are checked before any original target is touched. */
export async function prepareWorkbenchRecoveryMembers(members: RecoveryRestoreMember[], directory: string,
  prepare: (member: RecoveryRestoreMember) => Promise<string | Buffer>): Promise<RecoveryPreparation> {
  const prepared: RecoveryRestoreMember[] = [], selectors: Extract<RecoveryPreparation, { state: 'unavailable' }>['selectors'] = []
  for (const member of members) {
    try {
      const value = await prepare(member), file = join(directory, recoveryDigest(member.id))
      await durableWriteFile(file, value, { mode: 0o600, requireDirectorySync: true })
      prepared.push({ ...member, file, sha256: recoveryDigest(value) })
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException)?.code ?? 'DESKTOP_RECOVERY_UNAVAILABLE'
      const sessions = (error as { agentSessionIds?: string[] })?.agentSessionIds
      if (sessions?.length) for (const agentSessionId of sessions) selectors.push({ memberId: member.id, agentSessionId, reason })
      else selectors.push({ memberId: member.id, reason })
    }
  }
  return selectors.length ? { state: 'unavailable', selectors } : { state: 'prepared', members: prepared }
}

/** Only the original Desktop document owner interprets its durable envelope. */
export function holdRecoveredWorkbenchDocument(raw: string): string {
  const envelope = JSON.parse(raw), state = envelope?.state
  if (!state || typeof state !== 'object' || Array.isArray(state) || typeof envelope.version !== 'number' || !Number.isFinite(envelope.version)) throw recoveryUnavailable('WORKBENCH_USER_STATE_INVALID')
  const launches = state.pendingAgentLaunches
  if (launches !== undefined && (!launches || typeof launches !== 'object' || Array.isArray(launches))) throw recoveryUnavailable('DESKTOP_RECOVERY_PENDING_LAUNCH_UNCONFIRMED')
  // A backup is not the original Core creation admission. Do not turn an old
  // launch selector into a fresh permission to create or dispatch its prompt.
  if (launches && Object.keys(launches).length) throw Object.assign(recoveryUnavailable('DESKTOP_RECOVERY_PENDING_LAUNCH_UNCONFIRMED'), { agentSessionIds: Object.keys(launches) })
  const queues = state.agentSteerQueues
  if (queues !== undefined) {
    if (!queues || typeof queues !== 'object' || Array.isArray(queues)) throw recoveryUnavailable('DESKTOP_RECOVERY_QUEUE_INVALID')
    for (const [id, queue] of Object.entries(queues)) {
      if (!Array.isArray(queue) || queue.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw recoveryUnavailable('DESKTOP_RECOVERY_QUEUE_INVALID')
      queues[id] = queue.map(entry => ({ ...entry, awaitingExplicitSend: true }))
    }
  }
  return JSON.stringify(envelope) + '\n'
}
