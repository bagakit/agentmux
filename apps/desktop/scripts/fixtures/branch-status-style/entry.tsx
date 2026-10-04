import { createRoot } from 'react-dom/client'
import { BranchesPanel } from '../../../src/renderer/src/components/BranchesPanel'
import { LiquidSelectionSurface } from '../../../src/renderer/src/components/settings/LiquidSelectionSurface'
import { workspace, calls } from './state'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'
Object.assign(window, {
  agentmux: { git: { aheadBehind: async () => ({ kind: 'tracked', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }) } },
  branchStyle: { calls }
})
createRoot(document.getElementById('root')!).render(<main className="branch-style-scene">
  <div className="source-control-switch" role="tablist" aria-label="Source control view">
    <LiquidSelectionSurface selected="branches" active={true} targetAttribute="data-source-view" />
    <button data-source-view="branches" className="selected" role="tab" aria-selected="true">Branches</button><button role="tab" aria-selected="false">Changes</button><button role="tab" aria-selected="false">History</button>
  </div>
  <BranchesPanel workspace={workspace as any} />
</main>)
