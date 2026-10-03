import { UserRound } from 'lucide-react'
import { resolveUserProfile, type UserProfile } from '../../../../../shared/user-profile'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { ProfileSettingsPane } from '../ProfileSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveProfile(profile: UserProfile, expected: UserProfile): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Your configuration is not available. Your profile draft is kept.')
  await api.config.save({ ...current, profile }, { ...current, profile: expected })
}

export const profileSettingsModule = {
  id: 'profile', group: 'preferences', title: 'My Profile',
  description: 'Your photo, background, and how you work with agents.', icon: UserRound,
  keywords: 'user human person avatar photo name about background collaboration identity profile context mote soul',
  savedSummary(config) {
    const profile = resolveUserProfile(config.profile)
    return profile.displayName || 'Make it yours'
  },
  Pane({ config }) { return <ProfileSettingsPane profile={config.profile} onSave={saveProfile} /> }
} as const satisfies SettingsModule
