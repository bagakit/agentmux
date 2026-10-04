import { Users } from 'lucide-react'
import { requestPmoTeamsTopicFloatingOpen } from '../../../lib/pmo-teams-topic-floating'
import { MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { MoteDirectorySettingsPane, moteDirectoryViewLabel, type MoteDirectoryDisplay } from '../MoteDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const moteSettingsModule = {
  id: 'mote', group: 'mote', title: 'Mote Club', icon: Users,
  description: 'Directory view and your collaborators’ profiles.',
  keywords: 'mote club collaborator collaborators profile roles soul avatar directory list view size',
  savedSummary: config => `${moteDirectoryViewLabel(config.moteDirectoryView)} · ${config.moteDirectoryAvatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT}px · Profiles and SOUL`,
  Pane({ config, onClose }) {
    async function saveView(value: MoteDirectoryDisplay, expected: MoteDirectoryDisplay): Promise<void> {
      const current = useAppStore.getState().config
      if (!current) throw new Error('Configuration is unavailable. Your display choice is kept; reload configuration and retry saving.')
      await api.config.save({ ...current, moteDirectoryView: value.view, moteDirectoryAvatarSize: value.avatarSize },
        { ...current, moteDirectoryView: expected.view, moteDirectoryAvatarSize: expected.avatarSize })
    }
    return <MoteDirectorySettingsPane view={config.moteDirectoryView} avatarSize={config.moteDirectoryAvatarSize} onSave={saveView}
      onOpen={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }} />
  }
} as const satisfies SettingsModule
