import { Users } from 'lucide-react'
import { requestPmoTeamsTopicFloatingOpen } from '../../../lib/pmo-teams-topic-floating'
import type { MoteDirectoryView } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { MoteDirectorySettingsPane, moteDirectoryViewLabel } from '../MoteDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'

export const moteSettingsModule = {
  id: 'mote', group: 'mote', title: 'Mote Club', icon: Users,
  description: 'Directory view and your collaborators’ profiles.',
  keywords: 'mote club collaborator collaborators profile roles soul avatar directory list view',
  savedSummary: config => `${moteDirectoryViewLabel(config.moteDirectoryView)} · Profiles and SOUL`,
  Pane({ config, onClose }) {
    async function saveView(moteDirectoryView: MoteDirectoryView, expected: MoteDirectoryView): Promise<void> {
      const current = useAppStore.getState().config
      if (!current) throw new Error('Configuration is unavailable. Your display choice is kept; reload configuration and retry saving.')
      await api.config.save({ ...current, moteDirectoryView }, { ...current, moteDirectoryView: expected })
    }
    return <MoteDirectorySettingsPane view={config.moteDirectoryView} onSave={saveView}
      onOpen={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }} />
  }
} as const satisfies SettingsModule
