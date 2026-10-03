import { Users } from 'lucide-react'
import { requestPmoTeamsTopicFloatingOpen } from '../../../lib/pmo-teams-topic-floating'
import { SettingsManagementPane } from '../SettingsManagementPane'
import type { SettingsModule } from '../settings-catalog'

export const moteSettingsModule = {
  id: 'mote', group: 'mote', title: 'Mote Club', icon: Users,
  description: 'Profiles, roles and SOUL for your collaborators.',
  keywords: 'mote club collaborator collaborators profile roles soul avatar',
  savedSummary: () => 'Profiles and SOUL',
  Pane({ onClose }) {
    return <SettingsManagementPane title="Your collaborators"
      description="Choose a Mote in the Club to manage its profile, role, avatar and SOUL."
      actionLabel="Open Mote Club" onOpen={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }} />
  }
} as const satisfies SettingsModule
