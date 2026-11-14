import '../mote-conversation-start/entry'
import { useAppStore } from '../../../src/renderer/src/store'
import { useLauncherState, checkpointLauncherState } from '../../../src/renderer/src/lib/launcher-state'

const original = (window as any).moteStartCapture
Object.assign(window, { moteComposerCapture: {
  ready: true, release: original.bindReading, theme: original.theme,
  checkpoint: checkpointLauncherState,
  facts: () => ({ ...original.facts(), moteDrafts: useLauncherState.getState().drafts,
    sessionDrafts: useAppStore.getState().agentComposerDrafts,
    tabs: useAppStore.getState().tabs, runs: useAppStore.getState().sessions.map(session => ({ id: session.id, runId: session.control?.run.runId })) })
} })
