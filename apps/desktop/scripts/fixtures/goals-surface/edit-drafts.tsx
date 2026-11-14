import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'

const original = (window as unknown as { goalEditNative: typeof api.ui }).goalEditNative
Object.assign(api.ui, original)
await import('./entry')
Object.assign(window, { goalEditProof: {
  facts: () => { const state = useAppStore.getState(); return { drafts: state.goalEditDrafts, selected: state.selectedDemandId,
    surface: state.mainSurface, tabs: state.tabs, layouts: state.layouts, composer: state.agentComposerDrafts } },
  checkpoint: () => prepareRendererUpdate(),
  surface: (mainSurface: 'board' | 'workbench') => useAppStore.getState().setMainSurface(mainSurface)
} })
