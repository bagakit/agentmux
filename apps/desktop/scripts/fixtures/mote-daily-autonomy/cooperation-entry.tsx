// Keep the original Profile, Launcher, Editor, Store, files and shared styles real.
import '../mote-companion-workflows/persona-entry'

import { useAppStore } from '../../../src/renderer/src/store'
Object.assign(window, { moteCooperationNotes: () => { const state = useAppStore.getState(); return state.agentComposerNotes[state.workbenchSpaceSelection?.regionId ?? ''] } })
