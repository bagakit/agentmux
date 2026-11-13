import { projectMonogram } from '@agentmux/client-ui/project-monogram'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { CSSProperties } from 'react'
import type { BrowserProfileSummary } from '../../../shared/contracts'
import { clearsSemanticHues, speakerColorHue } from '../lib/conversation-avatar-color'

const ThemeObjectProfileIcon = semanticIconComponent('object.browser')

/**
 * Identity hues a Profile can show: teal through rose. The speaker rule keeps only ±22° around each
 * status color, which still lets yellow-green and lime through; on a mark beside green status text
 * those read as success. Automatic and chosen Profiles draw from this one palette, so both stay clear.
 */
export const PROFILE_HUES = [180, 248, 266, 284, 302, 320, 338].filter(clearsSemanticHues)

/** The hue a Profile shows everywhere: the person's choice, or one picked from its id within the palette. */
export function profileHue(profile: Pick<BrowserProfileSummary, 'id' | 'hue'>): number {
  return profile.hue ?? PROFILE_HUES[speakerColorHue(profile.id) % PROFILE_HUES.length]!
}

/**
 * One identity mark for a Browser Profile: its first letter on its identity hue. The list row,
 * the editor header, the Browser toolbar chip and the switcher all draw this same element, so
 * a Profile looks the same wherever a person meets it. State never tints the mark.
 */
export function ProfileMark({ profile, size = 'small' }: {
  profile: Pick<BrowserProfileSummary, 'id' | 'label' | 'hue'>
  size?: 'small' | 'large'
}) {
  const letter = projectMonogram(profile.label)
  return (
    <span className="profile-mark" data-size={size} aria-hidden="true"
      style={{ '--profile-hue': profileHue(profile) } as CSSProperties}>
      {letter || <ThemeObjectProfileIcon size={size === 'large' ? 16 : 12} />}
    </span>
  )
}
