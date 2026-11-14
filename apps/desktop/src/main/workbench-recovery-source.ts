import { createHash } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotRecoveryFile, type RecoveryGap, type RecoverySourceMember } from '@agentmux/core'

export type WorkbenchRecoveryFile = { id: string; target: string }
export type WorkbenchRecoveryNamespace = { id: string; directory: string; accepts(name: string): boolean }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const stamp = (value: Awaited<ReturnType<typeof lstat>>) =>
  [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':')
const code = (error: unknown) => {
  const value = (error as NodeJS.ErrnoException)?.code
  return typeof value === 'string' && /^[A-Z_0-9-]{1,100}$/u.test(value) ? value : 'RECOVERY_SOURCE_UNAVAILABLE'
}

/** Lightweight change observation. No reads of user contents, copies, or producer ACKs. */
export async function inspectWorkbenchRecoveryFiles(files: readonly WorkbenchRecoveryFile[], namespaces: readonly WorkbenchRecoveryNamespace[] = []): Promise<string> {
  const revisions: unknown[] = []
  const inspect = async ({ id, target }: WorkbenchRecoveryFile) => {
    try { const value = await lstat(target); revisions.push([id, stamp(value), value.isFile()]) }
    catch (error) { revisions.push([id, code(error)]) }
  }
  for (const file of files) await inspect(file)
  for (const namespace of namespaces) {
    try {
      const names = (await readdir(namespace.directory)).sort()
      revisions.push([namespace.id, names])
      for (const name of names) if (namespace.accepts(name)) await inspect({ id: namespace.id + '/' + name, target: join(namespace.directory, name) })
    } catch (error) { revisions.push([namespace.id, code(error)]) }
  }
  return digest(JSON.stringify(revisions))
}

/** Only original Main owners select members. This is a file cut, never another business Store. */
export async function captureWorkbenchRecoveryFiles(sourceId: string, directory: string,
  files: readonly WorkbenchRecoveryFile[], namespaces: readonly WorkbenchRecoveryNamespace[] = []) {
  const members: RecoverySourceMember[] = [], gaps: RecoveryGap[] = [], revisions: string[] = []
  const capture = async ({ id, target }: WorkbenchRecoveryFile) => {
    const file = join(directory, digest(id))
    try {
      const before = await lstat(target)
      const revision = await snapshotRecoveryFile(target, file)
      const after = await lstat(target)
      if (stamp(before) !== stamp(after)) {
        await rm(file, { force: true })
        gaps.push({ sourceId, memberId: id, code: 'RECOVERY_SOURCE_CHANGED' }); return
      }
      revisions.push(id + ':' + stamp(after))
      members.push({ id, file, target, kind: 'file', capturedAt: Date.now(), revision })
    } catch (error) { gaps.push({ sourceId, memberId: id, code: code(error) }) }
  }
  for (const file of files) await capture(file)
  for (const namespace of namespaces) {
    let observed = false
    try {
      const before = (await readdir(namespace.directory)).sort()
      observed = true
      for (const name of before) {
        const id = namespace.id + '/' + name
        if (!namespace.accepts(name)) { gaps.push({ sourceId, memberId: id, code: 'RECOVERY_MEMBER_UNRECOGNIZED' }); continue }
        await capture({ id, target: join(namespace.directory, name) })
      }
      if (JSON.stringify(before) !== JSON.stringify((await readdir(namespace.directory)).sort()))
        gaps.push({ sourceId, memberId: namespace.id, code: 'RECOVERY_DIRECTORY_CHANGED' })
    } catch (error) {
      // These namespaces are created only by an admitted original operation.
      // Confirmed current absence contributes no invented empty member.
      if (observed || (error as NodeJS.ErrnoException).code !== 'ENOENT') gaps.push({ sourceId, memberId: namespace.id, code: code(error) })
    }
  }
  return { revision: digest(JSON.stringify({ revisions, gaps })), members, gaps }
}
