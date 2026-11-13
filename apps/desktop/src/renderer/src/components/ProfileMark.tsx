import { projectMonogram } from '@agentmux/client-ui/project-monogram'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { CSSProperties } from 'react'
import type { BrowserProfileSummary } from '../../../shared/contracts'
import { speakerColorHue } from '../lib/conversation-avatar-color'

const ThemeObjectProfileIcon = semanticIconComponent('object.browser')

/** The hue a Profile shows everywhere: the person's choice, or one derived from its id. */
export function profileHue(profile: Pick<BrowserProfileSummary, 'id' | 'hue'>): number {
  return profile.hue ?? speakerColorHue(profile.id)
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
