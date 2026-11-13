import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveUserProfile, type UserProfile } from '../../../../../shared/user-profile'
import { ProfileSettingsPane } from '../ProfileSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectUserIcon = semanticIconComponent('object.user')


async function saveProfile(profile: UserProfile, expected: UserProfile): Promise<void> {
  await saveConfigSlice((current, value: UserProfile) => ({ ...current, profile: value }), profile, expected)
}

export const profileSettingsModule = {
  id: 'profile', group: 'preferences', title: 'My Profile',
  description: 'Your photo, background, and how you work with agents.', icon: ThemeObjectUserIcon,
  keywords: 'user human person avatar photo name about background collaboration identity profile context mote soul',
  searchTargets: [
    { id: 'display-name', title: 'Display name', keywords: 'name identity nickname' },
    { id: 'profile-photo', title: 'Profile photo', keywords: 'avatar change photo image' },
    { id: 'profile-about', title: 'About you and how you work', keywords: 'background collaboration context' },
    { id: 'profile-sharing', title: 'Share with new agents', keywords: 'profile sharing context' },
  ],
  savedSummary(config) {
    const profile = resolveUserProfile(config.profile)
    return profile.displayName || 'Make it yours'
  },
  Pane({ config }) { return <ProfileSettingsPane profile={config.profile} onSave={saveProfile} /> }
} as const satisfies SettingsModule
