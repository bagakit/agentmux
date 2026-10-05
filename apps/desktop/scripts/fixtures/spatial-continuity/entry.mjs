// Reuse the original App, private file facts and seed-only initialization. This
// observer adds no navigation or persistence implementation of its own.
import '../topics-navigation-quality/restart-entry.mjs'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'

const trace = []
let mark = 'initial'
useAppStore.subscribe((state, previous) => {
  const active = state.tabs['topic-tab-0']?.layout.activeRegionId
  const prior = previous.tabs['topic-tab-0']?.layout.activeRegionId
  if (active !== prior) trace.push({ sequence: trace.length, mark, active, selected: state.workbenchSpaceSelection?.regionId })
})
window.continuityMark = value => { mark = value; return trace.length }
window.continuityTrace = () => trace
window.continuityFacts = () => ({ ...window.topicsRestartFacts(), workbenchSaveWarning: useAppStore.getState().workbenchSaveWarning })
window.continuityFlush = () => prepareRendererUpdate('quit')
