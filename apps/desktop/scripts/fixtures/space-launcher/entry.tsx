import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'

mountThemeRuntime(window, { appAppearance: 'dark' })
await import('../launcher-launchpad/entry')
Object.assign(window, {
  spaceLauncher: {
    theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
    clearPrompt: () => useAppStore.getState().setAgentComposerDraft('launchpad-input', ''),
    async failAvailability() {
      api.executors.detect = async () => { throw new Error('Controlled Host observation failed; the original command remains configured.') }
      const workspace = useAppStore.getState().config!.workspaces[0]!
      await useAppStore.getState().detectExecutors(workspace.hostId)
    }
  }
})
