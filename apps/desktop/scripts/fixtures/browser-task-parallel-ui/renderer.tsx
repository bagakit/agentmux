import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { BrowserTaskParallelSummary } from '@agentmux/core/control'
import { BrowserTaskParallel } from '../../../src/renderer/src/components/BrowserTaskParallel'
import { BrowserTaskAssetEditor } from '../../../src/renderer/src/components/BrowserTaskAssetEditor'
import { BrowserPane } from '../../../src/renderer/src/components/BrowserPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { BrowserTaskAsset, BrowserTaskVersion } from '../../../src/shared/browser-task-assets'
import '../../../src/renderer/src/styles/index.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const fixtureStyle = document.createElement('style')
fixtureStyle.textContent = 'html,body,#root{height:auto;min-height:100%;overflow:visible}html[data-parallel-scene=pane],html[data-parallel-scene=pane] body,html[data-parallel-scene=pane] #root{height:100%;overflow:hidden}'
document.head.append(fixtureStyle)
const source = 'private-library-browser', url = 'https://generic.invalid/form', workspaceId = 'private-parallel-workspace'
const version: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit reviewed collection', url, parameters: [{ key: 'value', label: 'Account reference', secret: false }, { key: 'token', label: 'Access token', secret: true }], steps: [
  { id: 'fill-account', kind: 'fill', reviewed: true, url, parameterKey: 'value', target: { role: 'text input', name: 'Account', ordinal: 1, count: 1 } },
  { id: 'entries', kind: 'subflow', reviewed: true, url, label: 'Collection', subflow: { iteration: 'each', target: { kind: 'local', assetId: 'private-child-task', version: 1 } } }
] }
const asset: BrowserTaskAsset = { id: 'private-parallel-task', browserId: source, revision: 1, createdAt: 1, updatedAt: 1, draft: { ...version, name: 'Editable collection draft' }, versions: [version] }
const child: BrowserTaskAsset = { ...asset, id: 'private-child-task', draft: { name: 'Submit entry', url, parameters: [], steps: [] }, versions: [{ version: 1, savedAt: 1, name: 'Submit entry', url, parameters: [{ key: 'entry', label: 'Entry label', secret: false }], steps: [{ id: 'review-entry', kind: 'checkpoint', reviewed: true, url, label: 'Review entry' }] }] }
const targets = [{ id: 'private-browser-a', source: 'embedded' as const, title: 'Northwind account', profile: { id: 'private-profile-a', label: 'Client work' }, status: 'ready' as const, url, workspaceId, capabilities: [] },
  { id: 'private-browser-b', source: 'embedded' as const, title: 'Independent account', profile: { id: 'private-profile-b', label: 'Review work' }, status: 'ready' as const, url, workspaceId, capabilities: [] }]
const retained: BrowserTaskParallelSummary = { operationId: 'retained-parallel-operation', browserId: source, assetId: asset.id, version: 1, status: 'waiting-human', targetCount: 3, concurrency: 2, requestedConcurrency: 2,
  counts: { queued: 1, preparing: 0, running: 0, waitingHuman: 1, ready: 0, completed: 1, interrupted: 0, failed: 0, stopped: 0 }, startedAt: 1, updatedAt: 2, admission: 'confirmed' }
let invoked: any, starts = 0, trusted = false, lookup = false, unknown = true, setMode: (value: 'editor' | 'pane') => void = () => {}
const calls: any[] = [], errors: string[] = []
api.browser.listTargets = async () => { calls.push({ method: 'targets' }); return { targets, coverage: 'complete' } }
api.browser.onTargetsChanged = () => () => {}
api.browser.listTaskParallel = async (browserId, options) => { calls.push({ method: 'list', browserId, options }); return { runs: [retained], page: { before: options?.before ?? null, limit: options?.limit ?? 16, nextBefore: null } } }
api.browser.inspectTaskParallel = async (browserId, options) => {
  calls.push({ method: 'inspect', browserId, options })
  const op = options?.operationId ?? retained.operationId
  if (invoked?.input.operationId === op && !lookup) return null
  return { run: op === retained.operationId ? retained : { ...retained, operationId: op, targetCount: invoked.input.targets.length, counts: { ...retained.counts, queued: 0 } }, targets: [
    { id: 'retained-target-a', browserId: targets[0]!.id, profileId: targets[0]!.profile.id, phase: 'bound', run: { id: 'original-target-run-a', status: 'completed', nextStep: 2, operationCount: 3 } },
    { id: 'retained-target-b', browserId: targets[1]!.id, profileId: targets[1]!.profile.id, phase: 'bound', run: { id: 'original-target-run-b', status: 'waiting-human', nextStep: 1, operationCount: 2 } }
  ], page: { after: options?.after ?? null, limit: options?.limit ?? 16, nextAfter: 'retained-target-b' } }
}
api.browser.runTaskParallel = async (browserId, assetId, savedVersion, input) => {
  starts++; invoked = { browserId, assetId, version: savedVersion, input: structuredClone(input) }; lookup = false
  if (unknown) throw new Error('The original start acknowledgement was lost. Inspect the same operation before another start.')
  lookup = true
  return { ...retained, operationId: input.operationId, assetId, version: savedVersion, targetCount: input.targets.length, concurrency: Math.min(input.concurrency ?? 1, input.targets.length), counts: { ...retained.counts, queued: 0 } }
}
function Surface() {
  const [mode, updateMode] = useState<'editor' | 'pane'>('editor'); setMode = updateMode
  const browser = useAppStore(state => state.tabs['private-source-tab']?.regions['private-source-region'])
  return <DesktopClientUiProvider>{mode === 'pane' && browser?.kind === 'browser' ? <main style={{ height: '100vh' }} data-workbench-region-id="private-source-region"><BrowserPane tab={browser} visible /></main> : <main className="parallel-ui-fixture" style={{ width: 'calc(100% - 32px)', maxWidth: 620, margin: '20px auto', minWidth: 0 }}>
    <h2 style={{ color: 'var(--text)', fontSize: 'var(--fs-base)' }}>Browser task · explicit target set</h2>
    <BrowserTaskAssetEditor asset={asset} assets={[asset, child]} recording={null} busy={true} onImport={() => {}} onLocateStep={() => {}} onStop={() => {}} onSaveDraft={async () => {}} onSaveVersion={async () => {}} onRun={async () => {}}
      renderParallel={number => <BrowserTaskParallel asset={asset} version={asset.versions.find(version => version.version === number)!} assets={[asset, child]} current={retained}
        onStart={(request, event) => { trusted = event.nativeEvent.isTrusted; if (!trusted) throw new Error('Private proof requires actual native input'); return api.browser.runTaskParallel(request.browserId, request.assetId, request.version, request.input) }} />} />
  </main>}</DesktopClientUiProvider>
}
;(window as any).parallelUI = {
  appearance: (mode: 'dark' | 'light') => updateThemeSelection({ appAppearance: mode }),
  confirmOriginal: () => { lookup = true },
  async pane() {
    const config = await api.config.get(); config.workspaces = [{ id: workspaceId, name: 'Private UI proof', kind: 'folder', hostId: 'local', path: '/private-fixture' }]
    const original = await api.browser.create(source, url, workspaceId)
    const surface = { ...original, kind: 'browser' as const, browserId: source, workspaceId, regionId: 'private-source-region', driving: true, taskAssets: { assets: [child, asset], runs: [], parallel: retained } }
    const tab = createWorkbenchTab('private-source-tab', surface)
    useAppStore.setState({ config, loading: false, toolsOpen: false, tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('private-group', [tab.id]) }, activeWorkspaceId: workspaceId, reportError: error => errors.push(String(error)) })
    unknown = false; document.documentElement.dataset.parallelScene = 'pane'; setMode('pane')
  },
  facts: () => ({ invoked, starts, trusted, calls, errors, sourceDriving: useAppStore.getState().tabs['private-source-tab']?.regions['private-source-region']?.kind === 'browser' && (useAppStore.getState().tabs['private-source-tab']!.regions['private-source-region'] as any).driving })
}
createRoot(document.getElementById('root')!, { onUncaughtError: error => { errors.push(String(error)); console.error(error) } }).render(<Surface />)
