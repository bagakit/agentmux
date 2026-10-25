import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { decodeBase64 } from './hosted-value.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { imageBytes } from './session-history-resource.js'

/** Public self-description, never authentication or input authority. */
export type AgentAuthorProfile = {
  name?: string
  avatar?: { revision: string; mimeType: 'image/png' | 'image/jpeg'; byteLength: number; width: number; height: number }
}
/** Original prepared bytes stay in the Input owner, not Conversation pages. */
export type AgentPreparedAuthorProfile = Omit<AgentAuthorProfile, 'avatar'> & {
  avatar?: NonNullable<AgentAuthorProfile['avatar']> & { dataBase64: string }
}
const MAX_AVATAR_BYTES = 144 * 1024
function invalid(): never { throw new AgentMuxError('The original public author profile is invalid.', 'INVALID_AUTHOR_PROFILE') }
export function parseAuthorProfile(value: unknown): AgentAuthorProfile {
  const p = rpcRecord(value, ['name', 'avatar'], 'INVALID_AUTHOR_PROFILE')
  if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || /[\x00-\x1f\x7f]/u.test(p.name))) invalid()
  let avatar: AgentAuthorProfile['avatar']
  if (p.avatar !== undefined) {
    const a = rpcRecord(p.avatar, ['revision', 'mimeType', 'byteLength', 'width', 'height'], 'INVALID_AUTHOR_PROFILE')
    if (typeof a.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(a.revision) || !['image/png', 'image/jpeg'].includes(String(a.mimeType)) ||
        !Number.isSafeInteger(a.byteLength) || Number(a.byteLength) < 1 || Number(a.byteLength) > MAX_AVATAR_BYTES ||
        !Number.isSafeInteger(a.width) || Number(a.width) < 1 || Number(a.width) > 512 ||
        !Number.isSafeInteger(a.height) || Number(a.height) < 1 || Number(a.height) > 512) invalid()
    avatar = a as NonNullable<AgentAuthorProfile['avatar']>
  }
  return { ...(p.name === undefined ? {} : { name: p.name as string }), ...(avatar ? { avatar } : {}) }
}
export function parsePreparedAuthorProfile(value: unknown): AgentPreparedAuthorProfile {
  const p = rpcRecord(value, ['name', 'avatar'], 'INVALID_AUTHOR_PROFILE')
  if (p.avatar === undefined) { const profile = parseAuthorProfile(p); return profile.name ? { name: profile.name } : {} }
  const a = rpcRecord(p.avatar, ['revision', 'mimeType', 'byteLength', 'width', 'height', 'dataBase64'], 'INVALID_AUTHOR_PROFILE')
  const { dataBase64, ...metadata } = a
  const profile = parseAuthorProfile({ ...p, avatar: metadata })
  if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) invalid()
  const bytes = decodeBase64(dataBase64)
  const actual = imageBytes(bytes, MAX_AVATAR_BYTES, profile.avatar!.mimeType)
  if (actual.status !== 'read' || actual.byteLength !== profile.avatar!.byteLength ||
      actual.width !== profile.avatar!.width || actual.height !== profile.avatar!.height ||
      'sha256:' + bytesToHex(sha256(bytes)) !== profile.avatar!.revision) invalid()
  return { ...profile, avatar: { ...profile.avatar!, dataBase64 } }
}
export function publicAuthorProfile(profile: AgentPreparedAuthorProfile): AgentAuthorProfile {
  const { avatar, ...name } = preparedAuthorProfileFields(profile).authorProfile ?? {}
  if (!avatar) return name
  const { dataBase64: _bytes, ...metadata } = avatar
  return { ...name, avatar: metadata }
}
/** Optional local display data cannot invalidate an otherwise readable original record. */
export function authorProfileFields(value: unknown): { authorProfile?: AgentAuthorProfile } {
  try { return value === undefined ? {} : { authorProfile: parseAuthorProfile(value) } }
  catch { return {} }
}
export function preparedAuthorProfileFields(value: unknown): { authorProfile?: AgentPreparedAuthorProfile } {
  try { return value === undefined ? {} : { authorProfile: parsePreparedAuthorProfile(value) } }
  catch { return {} }
}
