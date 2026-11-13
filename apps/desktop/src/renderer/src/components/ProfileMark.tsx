import { projectMonogram } from '@agentmux/client-ui/project-monogram'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMemo, type CSSProperties } from 'react'
import type { BrowserProfileSummary } from '../../../shared/contracts'
import { clearsSemanticHues, speakerColorHue } from '../lib/conversation-avatar-color'
import { useBrowserProfiles } from '../lib/browser-profiles'

/** The list-wide hue assignment for the Profiles Main reports now; empty until they are read. */
function useProfileHueAssignment(assignment?: ReadonlyMap<string, number>): ReadonlyMap<string, number> | undefined {
  const { profiles } = useBrowserProfiles(assignment === undefined)
  return useMemo(() => assignment ?? (profiles ? assignProfileHues(profiles) : undefined), [profiles, assignment])
}

const ThemeObjectProfileIcon = semanticIconComponent('object.browser')

/**
 * Identity hues a Profile can show: teal through rose. The speaker rule keeps only ±22° around each
 * status color, which still lets yellow-green and lime through; on a mark beside green status text
 * those read as success. Automatic and chosen Profiles draw from this one palette, so both stay clear.
 *
 * Hue alone cannot separate this many marks inside teal-to-rose: at one lightness, neighbours 18°
 * apart looked the same. So the palette is spread as far as the arc allows and alternates two
 * lightness steps; every pair differs clearly in one or the other.
 */
export const PROFILE_HUES = [178, 246, 270, 294, 318, 338].filter(clearsSemanticHues)

/** The lightness step a hue is drawn at: every other palette entry is the deeper one; any other hue is light. */
export function profileTone(hue: number): 'light' | 'deep' {
  return PROFILE_HUES.indexOf(hue) % 2 === 1 ? 'deep' : 'light'
}

/** The hue an id would get alone: the palette entry its hash picks. Used to break ties, and when no list is known. */
function hashedHue(id: string): number {
  return PROFILE_HUES[speakerColorHue(id) % PROFILE_HUES.length]!
}

/**
 * The hue each Profile shows, decided for the whole list at once, so two Profiles never share a color
 * while the palette has room. A person's choice is kept. Every other Profile, oldest first, takes the
 * hue fewest Profiles use so far and, among those, the one farthest from the hues already shown, the
 * tie going to the one its id would pick alone. The same list always gives the same colors, and a new
 * Profile does not repaint the ones before it.
 */
export function assignProfileHues(profiles: readonly Pick<BrowserProfileSummary, 'id' | 'hue' | 'createdAt'>[]): ReadonlyMap<string, number> {
  const assigned = new Map<string, number>()
  const used = new Map<number, number>(PROFILE_HUES.map(hue => [hue, 0]))
  const take = (id: string, hue: number) => { assigned.set(id, hue); used.set(hue, (used.get(hue) ?? 0) + 1) }
  for (const profile of profiles) if (profile.hue !== undefined) take(profile.id, profile.hue)
  const automatic = profiles.filter(profile => profile.hue === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const profile of automatic) {
    const fewest = Math.min(...PROFILE_HUES.map(hue => used.get(hue)!))
    const open = PROFILE_HUES.filter(hue => used.get(hue) === fewest)
    // Among the least-used, the hue farthest round the wheel from every hue already shown, so a few
    // Profiles spread across teal to rose instead of crowding neighbours; ties go to the id's own hue,
    // then to the palette order from it.
    const shown = [...assigned.values()]
    const distance = (hue: number) => shown.length ? Math.min(...shown.map(other => { const d = Math.abs(hue - other) % 360; return Math.min(d, 360 - d) })) : 0
    const farthest = Math.max(...open.map(distance))
    const start = PROFILE_HUES.indexOf(hashedHue(profile.id))
    const hue = PROFILE_HUES.map((_, step) => PROFILE_HUES[(start + step) % PROFILE_HUES.length]!)
      .find(candidate => open.includes(candidate) && distance(candidate) === farthest)!
    take(profile.id, hue)
  }
  return assigned
}

/** The hue one Profile shows: from the list-wide assignment when one is given, else its choice or its hashed hue. */
export function profileHue(profile: Pick<BrowserProfileSummary, 'id' | 'hue'>, assigned?: ReadonlyMap<string, number>): number {
  return profile.hue ?? assigned?.get(profile.id) ?? hashedHue(profile.id)
}

/**
 * One identity mark for a Browser Profile: its first letter on its identity hue. The list row,
 * the editor header, the Browser toolbar chip and the switcher all draw this same element, so
 * a Profile looks the same wherever a person meets it. State never tints the mark.
 */
export function ProfileMark({ profile, size = 'small', assignment }: {
  profile: Pick<BrowserProfileSummary, 'id' | 'label' | 'hue'>
  size?: 'small' | 'large'
  /** An owning library may supply the same full-list assignment without one subscription per mark. */
  assignment?: ReadonlyMap<string, number>
}) {
  const letter = projectMonogram(profile.label)
  // Every mark reads the same list-wide assignment, so a Profile has one color wherever it is drawn.
  const hue = profileHue(profile, useProfileHueAssignment(assignment))
  return (
    <span className="profile-mark" data-size={size} data-tone={profileTone(hue)} aria-hidden="true"
      style={{ '--profile-hue': hue } as CSSProperties}>
      {letter || <ThemeObjectProfileIcon size={size === 'large' ? 16 : 12} />}
    </span>
  )
}
