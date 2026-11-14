import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { requestPmoTeamsTopicFloatingOpen } from '../../../lib/pmo-teams-topic-floating'
import { MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT } from '../../../../../shared/contracts'
import { MoteDirectorySettingsPane, moteDirectoryViewLabel, type MoteDirectoryDisplay } from '../MoteDirectorySettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ClubIcon = semanticIconComponent('object.club')


export const moteSettingsModule = {
  id: 'mote', archetype: 'preference', group: 'mote', title: 'Clubs', icon: ClubIcon,
  description: 'Directory view and your collaborators’ profiles.',
  keywords: 'mote club collaborator collaborators profile roles soul avatar directory list view size',
  savedSummary: config => `${moteDirectoryViewLabel(config.moteDirectoryView)} · ${config.moteDirectoryAvatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT}px · Profiles and SOUL`,
  Pane({ config, onClose }) {
    async function saveView(value: MoteDirectoryDisplay, expected: MoteDirectoryDisplay): Promise<void> {
      await saveConfigSlice((current, display: MoteDirectoryDisplay) => ({ ...current, moteDirectoryView: display.view, moteDirectoryAvatarSize: display.avatarSize }), value, expected)
    }
    return <MoteDirectorySettingsPane view={config.moteDirectoryView} avatarSize={config.moteDirectoryAvatarSize} onSave={saveView}
      onOpen={() => { onClose(); requestPmoTeamsTopicFloatingOpen() }} />
  }
} as const satisfies SettingsModule
