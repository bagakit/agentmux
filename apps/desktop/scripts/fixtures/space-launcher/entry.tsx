import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'

mountThemeRuntime(window, { appAppearance: 'dark' })
await import('../launcher-launchpad/entry')
Object.assign(window, {
  spaceLauncher: {
    theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
    clearPrompt: () => useAppStore.getState().setAgentComposerDraft('launchpad-input', '')
  }
})
