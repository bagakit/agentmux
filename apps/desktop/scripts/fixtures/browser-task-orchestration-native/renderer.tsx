import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import type { BrowserTaskParallelSummary } from '@agentmux/core/control'
import type { BrowserTaskAsset } from '../../../src/shared/browser-task-assets'
import { BrowserTaskParallel } from '../../../src/renderer/src/components/BrowserTaskParallel'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'
// Root supplies actual original owner snapshots. All API methods use production preload/IPC.
type Original = { asset: BrowserTaskAsset; assets: BrowserTaskAsset[]; version: number; current: BrowserTaskParallelSummary | null }
const root = createRoot(document.getElementById('root')!, { onUncaughtError: cause => console.error('orchestration-native-renderer-error', cause instanceof Error ? cause.message : String(cause)) })
mountThemeRuntime(window, { appAppearance: 'dark' })
function setOriginal(input: Original) {
  const version = input.asset.versions.find(version => version.version === input.version)
  if (!version) throw new Error('The native fixture needs the exact original selected immutable version.')
  flushSync(() => root.render(<main className="task-orchestration-native"><h2>Original parallel group</h2><BrowserTaskParallel key={`${input.asset.browserId}:${input.asset.id}`} asset={input.asset} assets={input.assets} version={version} current={input.current}
    onStart={(request, event) => { if (event.nativeEvent.isTrusted !== true) throw new Error('The native fixture requires actual human input.'); return api.browser.runTaskParallel(request.browserId, request.assetId, request.version, request.input) }}
    onContinue={(request, event) => { if (event.nativeEvent.isTrusted !== true) throw new Error('The native fixture requires actual human input.'); return api.browser.continueTaskParallelTarget(request.browserId, request.operationId, request.targetId, request.input) }} /></main>))
}
Object.assign(window, { taskOrchestrationNative: { api, setOriginal, read: () => ({ text: document.body.innerText, mounted: Boolean(document.querySelector('.browser-task-parallel')) }), appearance: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }) } })
