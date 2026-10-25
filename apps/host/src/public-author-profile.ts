import { createHash } from 'node:crypto'
import { parsePreparedAuthorProfile, readSessionHistoryImageBytes as imageBytes, type AgentPreparedAuthorProfile } from '@agentmux/core'
import { resolveUserProfile, validProfileAvatar, type UserProfile } from './mote-user-profile.js'

/** The original human producer prepares display data; receivers never substitute their own profile. */
export function preparePublicUserProfile(input?: Partial<UserProfile>): AgentPreparedAuthorProfile | undefined {
  const profile = resolveUserProfile(input)
  const name = typeof profile.displayName === 'string' ? profile.displayName.trim() : ''
  const result: AgentPreparedAuthorProfile = name && name.length <= 80 && !/[\x00-\x1f\x7f]/u.test(name) ? { name } : {}
  if (typeof profile.avatar === 'string' && profile.avatar && validProfileAvatar(profile.avatar)) try {
    const [prefix, dataBase64] = profile.avatar.split(',')
    const mimeType = prefix === 'data:image/png;base64' ? 'image/png' : 'image/jpeg'
    const bytes = Buffer.from(dataBase64!, 'base64'), image = imageBytes(bytes, 144 * 1024, mimeType)
    if (image.status === 'read') result.avatar = { dataBase64: dataBase64!, mimeType, byteLength: bytes.length,
      width: image.width, height: image.height, revision: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
  } catch { /* Optional self-description never blocks original human input. */ }
  return result.name || result.avatar ? parsePreparedAuthorProfile(result) : undefined
}
