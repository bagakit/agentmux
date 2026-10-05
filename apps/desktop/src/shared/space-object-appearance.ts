import { isMoteAvatarSeriesChoice, type MoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { isSpaceIconId, type SpaceIconId } from '@agentmux/client-ui/space-icon-ids'
import { isMoteAvatarRef, isMoteFace, type MoteAvatarRef, type MoteFace } from './mote-avatars'
import { directoryIdentity } from './space-addresses'

export { isSpaceIconId, type SpaceIconId } from '@agentmux/client-ui/space-icon-ids'
export type SpaceIconChoice = SpaceIconId | MoteAvatarRef | MoteFace | MoteAvatarSeriesChoice
export type SpaceIconOverrides = Record<string, SpaceIconChoice>

export function isSpaceObjectIdentityKey(key: string): boolean {
  try {
    const parts: unknown = JSON.parse(key)
    return Array.isArray(parts) && parts.length === 2
      && typeof parts[0] === 'string' && parts[0] !== ''
      && typeof parts[1] === 'string' && (parts[1].startsWith('/') || /^[A-Za-z]:[\\/]/.test(parts[1]) || parts[1].startsWith('\\\\'))
      && directoryIdentity(parts[0], parts[1]) === key
  } catch { return false }
}

export function isSpaceIconChoice(value: unknown): value is SpaceIconChoice {
  return isMoteAvatarSeriesChoice(value) || isSpaceIconId(value) || isMoteAvatarRef(value) || isMoteFace(value)
}

/** Raw records remain with the durable owner; one unreadable record cannot erase another. */
export function inspectSpaceIconOverrides(candidate: unknown): { icons: SpaceIconOverrides; invalidKeys: string[] } {
  if (candidate === undefined) return { icons: {}, invalidKeys: [] }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { icons: {}, invalidKeys: ['(collection)'] }
  const icons: SpaceIconOverrides = {}, invalidKeys: string[] = []
  for (const [key, value] of Object.entries(candidate)) {
    if (isSpaceObjectIdentityKey(key) && isSpaceIconChoice(value)) Object.defineProperty(icons, key, { value, enumerable: true, writable: true, configurable: true })
    else invalidKeys.push(key)
  }
  return { icons, invalidKeys }
}

export function restoreSpaceIconOverrides(candidate: unknown): SpaceIconOverrides { return inspectSpaceIconOverrides(candidate).icons }
export function requireSpaceIconSelection(key: string, icon: unknown): asserts icon is SpaceIconChoice | null {
  if (!isSpaceObjectIdentityKey(key) || (icon !== null && !isSpaceIconChoice(icon))) throw new Error('Choose a valid Space object and icon.')
}
