import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { flushSync } from 'react-dom'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'

mountThemeRuntime(window, { appAppearance: 'dark' })
await import('../launcher-launchpad/entry')
Object.assign(window, {
  spaceLauncher: {
    sourceArrangement(long = false) {
      const state = useAppStore.getState(), project = state.config!.workspaces[0]!
      const path = long ? '/workspace/' + 'original-project-directory/'.repeat(8) + 'agentmux' : project.path
      const original = { ...project, path }
      const sourceRuntime = 'project-runtime-' + 'original-source-identity'.repeat(long ? 3 : 1)
      const agentRuntime = 'agent-runtime-' + 'original-agent-identity'.repeat(long ? 3 : 1)
      const agentHost = long ? 'remote-agent-' + 'original-host-name-'.repeat(5) : 'remote-agent'
      api.spaceMounts.call = (async (method: string, input: any) => {
        if (method === 'describe') return { source: { runtimeId: sourceRuntime, ownerInstanceId: 'fixture-source-owner' }, contracts: { ordinaryLaunch: { revision: 1, destination: 'source-zone-background' }, externalAssociation: null } }
        if (method === 'executors') {
          const entries = [
            { executorId: 'codex', label: 'Codex', providerId: 'codex', command: 'codex', source: 'provider-default' },
            { executorId: 'hermes', label: 'Hermes', providerId: 'hermes', command: 'hermes', source: 'provider-default' },
            { executorId: 'configured-agent', label: 'Remote configuration', providerId: 'claude', command: '/remote/user/bin/configured-agent', source: 'registered' },
          ].map(item => ({ ...item, configRevision: 'original-revision', availability: 'unknown', creationContract: { ordinaryLaunch: 1 }, launchOptions: [] }))
          return { runtimeId: agentRuntime, executors: input.executorId ? entries.filter(item => item.executorId === input.executorId) : entries }
        }
        throw Error('The visual probe must not launch or register an Agent: ' + method)
      }) as typeof api.spaceMounts.call
      flushSync(() => {
        useAppStore.setState({ config: { ...state.config!, workspaces: state.config!.workspaces.map(item => item.id === project.id ? original : item) },
          agentComposerDrafts: { ...state.agentComposerDrafts, 'launchpad-input': 'Review the original project; keep this unsent task.' } })
        useLauncherState.setState(current => ({ sections: { ...current.sections, [project.id]: { agents: 'expanded', terminal: 'collapsed', browser: 'collapsed', note: 'collapsed' } },
          drafts: { ...current.drafts, 'region:launchpad-input': { browser: '', note: '', sourceExecution: {
            project: original, target: { hostId: project.hostId, reference: { runtimeId: sourceRuntime, spaceId: 'original-space' }, workspaceId: project.id, zoneId: 'original-zone' },
            agentTarget: { hostId: agentHost, runtimeId: agentRuntime },
          } } } }))
      })
    },
    theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
    clearPrompt: () => useAppStore.getState().setAgentComposerDraft('launchpad-input', ''),
    async failAvailability() {
      api.executors.detect = async () => { throw new Error('Controlled Host observation failed; the original command remains configured.') }
      const workspace = useAppStore.getState().config!.workspaces[0]!
      await useAppStore.getState().detectExecutors(workspace.hostId)
    }
  }
})
