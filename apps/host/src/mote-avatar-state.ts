import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { avatarSeriesCanonical, isMoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { parseMoteAvatarOperationId, type MoteAvatarTarget, type MoteAvatarOperation } from '@agentmux/core/mote-avatar-write'

/** The original appearance preference owns the choice; reading never publishes one. */
export function savedMoteAvatarSnapshot(appearance: {
  spaceObjectIcons?: Record<string, unknown>
  spaceObjectIconRevisions?: Record<string, unknown>
}, objectKey: string, drawing?: string) {
  const icons = appearance.spaceObjectIcons
  const present = !!icons && Object.hasOwn(icons, objectKey)
  const value = present ? icons![objectKey] : undefined
  const revision = 'sha256:' + createHash('sha256').update(avatarSeriesCanonical({
    ...(value === undefined ? { present: false } : { present: true, value }),
    publication: appearance.spaceObjectIconRevisions?.[objectKey] ?? null,
    ...(drawing ? { drawing } : {})
  })).digest('hex')
  return { choice: structuredClone(value ?? null), revision }
}

/** Shared with the original Desktop writer; no new operation journal or schema. */
export async function moteAvatarOperationDirectory(original: string, create = false): Promise<string> {
  let current = original
  for (const name of ['', '.agentmux', 'avatar-operations']) {
    if (name) current = join(current, name)
    if (create && name) {
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current)
      throw new Error('The original avatar operation directory is unconfirmed.')
    if (create) { const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync() } finally { await handle.close() } }
  }
  if (create) for (const parent of [join(original, '.agentmux'), original]) {
    const handle = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  return current
}

export async function readMoteAvatarOperation(original: string, target: MoteAvatarTarget, operationId: string): Promise<MoteAvatarOperation | undefined> {
  parseMoteAvatarOperationId(operationId)
  try {
    const file = join(await moteAvatarOperationDirectory(original), operationId + '.json')
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let bytes: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error('The original avatar receipt is unreadable.')
      bytes = await handle.readFile()
      const after = await handle.stat()
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('The original avatar receipt changed while reading.')
    } finally { await handle.close() }
    const record = JSON.parse(bytes.toString()) as { schema: string; target: MoteAvatarTarget; operation: MoteAvatarOperation }
    if (record.schema !== 'agentmux.avatar-operation.v1' || avatarSeriesCanonical(record.target) !== avatarSeriesCanonical(target) ||
      record.operation?.operationId !== operationId || !/^sha256:[a-f0-9]{64}$/u.test(record.operation.requestHash) ||
      !['intent', 'asset', 'publication-unknown', 'published'].includes(record.operation.phase) || !['unknown', 'confirmed'].includes(record.operation.durability) ||
      record.operation.phase !== 'intent' && !isMoteAvatarSeriesChoice(record.operation.choice) || record.operation.durability === 'confirmed' && record.operation.phase !== 'published')
      throw new Error('The original avatar receipt is unreadable. Keep this operationId and inspect its original file.')
    return record.operation
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
