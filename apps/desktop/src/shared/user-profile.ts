/** A local, user-authored profile. Authorship and authentication remain separate facts. */
export type UserProfile = { displayName: string; about: string; avatar: string; shareWithAgents: boolean }
export const DEFAULT_USER_PROFILE: Readonly<UserProfile> = { displayName: '', about: '', avatar: '', shareWithAgents: false }
export const USER_PROFILE_NAME_LIMIT = 80
export const USER_PROFILE_ABOUT_LIMIT = 2000
export const USER_PROFILE_AVATAR_LIMIT = 196608

export function resolveUserProfile(profile?: Partial<UserProfile>): UserProfile {
  return { ...DEFAULT_USER_PROFILE, ...profile }
}

/** Only bounded static raster data; never URLs, SVG, remote requests or animation. */
export function validProfileAvatar(value: string): boolean {
  if (value === '') return true
  if (value.length > USER_PROFILE_AVATAR_LIMIT) return false
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[2]!.length % 4 !== 0) return false
  let bytes: string
  try { bytes = atob(match[2]!) } catch { return false }
  if (match[1] === 'jpeg') {
    if (!bytes.startsWith('\xff\xd8') || !bytes.endsWith('\xff\xd9')) return false
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes.charCodeAt(offset) !== 255) return false
      const marker = bytes.charCodeAt(offset + 1)
      const length = (bytes.charCodeAt(offset + 2) << 8) + bytes.charCodeAt(offset + 3)
      if (length < 2 || offset + 2 + length > bytes.length) return false
      if ([192, 193, 194].includes(marker)) {
        const height = (bytes.charCodeAt(offset + 5) << 8) + bytes.charCodeAt(offset + 6)
        const width = (bytes.charCodeAt(offset + 7) << 8) + bytes.charCodeAt(offset + 8)
        return length >= 8 && width > 0 && height > 0 && width <= 512 && height <= 512
      }
      offset += 2 + length
    }
    return false
  }
  if (!bytes.startsWith('\x89PNG\r\n\x1a\n')) return false
  // Walk PNG chunks so an animated PNG cannot masquerade as a static avatar.
  let dimensions = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = ((bytes.charCodeAt(offset) * 0x1000000) + (bytes.charCodeAt(offset + 1) << 16) +
      (bytes.charCodeAt(offset + 2) << 8) + bytes.charCodeAt(offset + 3))
    const type = bytes.slice(offset + 4, offset + 8)
    if (offset + 12 + size > bytes.length || type === 'acTL') return false
    if (type === 'IHDR') {
      const numberAt = (index: number) => bytes.charCodeAt(index) * 0x1000000 +
        (bytes.charCodeAt(index + 1) << 16) + (bytes.charCodeAt(index + 2) << 8) + bytes.charCodeAt(index + 3)
      const width = numberAt(offset + 8), height = numberAt(offset + 12)
      dimensions = offset === 8 && size === 13 && width > 0 && height > 0 && width <= 512 && height <= 512
      if (!dimensions) return false
    }
    if (type === 'IEND') return dimensions && size === 0 && offset + 12 === bytes.length
    offset += 12 + size
  }
  return false
}

/** New launches consume text only. Existing Sessions and the exact user request are untouched. */
export function profileAgentContext(profile?: Partial<UserProfile>): string | undefined {
  const value = resolveUserProfile(profile)
  if (!value.shareWithAgents || (!value.displayName.trim() && !value.about.trim())) return undefined
  return ['User-provided profile for this machine:',
    value.displayName.trim() ? 'Preferred name: ' + value.displayName.trim() : '',
    value.about.trim() ? 'Background and working preferences:\n' + value.about : ''].filter(Boolean).join('\n')
}
