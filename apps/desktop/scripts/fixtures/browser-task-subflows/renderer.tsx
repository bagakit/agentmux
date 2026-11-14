import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { BrowserTaskAssetEditor } from '../../../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskVersion } from '../../../src/shared/browser-task-assets'
import '../../../src/renderer/src/styles/index.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const url = 'https://generic.invalid/form', browserId = 'private-subflow-browser'
const childVersion: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit entry', url,
  parameters: [{ key: 'label', label: 'Entry label', secret: false }, { key: 'token', label: 'Access token', secret: true }],
  steps: [{ id: 'fill', kind: 'fill', url, reviewed: true, parameterKey: 'label', target: { role: 'text input', name: 'Entry label', ordinal: 1, count: 1 } },
    { id: 'review', kind: 'checkpoint', url, reviewed: true, label: 'Review submission' }] }
const rootVersion: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit collection', url, parameters: [],
  steps: [{ id: 'collection', kind: 'subflow', url, reviewed: true, label: 'Collection', subflow: { target: { kind: 'local', assetId: 'private-child', version: 1 }, iteration: 'each' } }] }
const asset = (id: string, version: BrowserTaskVersion): BrowserTaskAsset => ({ id, browserId, revision: 1, createdAt: 1, updatedAt: 1, draft: version, versions: [version] })
const child = asset('private-child', childVersion)
child.versions.push({ ...childVersion, version: 2, name: 'Later submission draft' })
const initialRoot = asset('private-root', rootVersion)
const rootRun: BrowserTaskAssetRun = { id: 'original-root-run', browserId, assetId: initialRoot.id, version: 1, status: 'waiting-human', nextStep: 0, operationIds: [], startedAt: 1, updatedAt: 2,
  calls: [{ stepId: 'collection', assetId: child.id, version: 1, nextItem: 1, items: [{ id: 'first-entry', runId: 'completed-child-run' }, { id: 'second-entry', runId: 'waiting-child-run' }] }] }
const runs: BrowserTaskAssetRun[] = [rootRun,
  { id: 'completed-child-run', browserId, assetId: child.id, version: 1, status: 'completed', nextStep: 2, operationIds: ['original-operation-one'], startedAt: 1, updatedAt: 2, parent: { runId: rootRun.id, stepId: 'collection', itemId: 'first-entry' } },
  { id: 'waiting-child-run', browserId, assetId: child.id, version: 1, status: 'waiting-human', nextStep: 2, pendingCheckpointId: 'review', operationIds: ['original-operation-two'], startedAt: 1, updatedAt: 2, parent: { runId: rootRun.id, stepId: 'collection', itemId: 'second-entry' }, warning: 'Review the second submission, then return control to continue.' }]

function Surface() {
  const [selected, setSelected] = useState(initialRoot)
  return <main style={{ width: 'calc(100% - 32px)', maxWidth: 620, margin: '20px auto', minWidth: 0 }}>
    <h2 style={{ color: 'var(--text-1)', fontSize: 'var(--fs-base)', margin: '0 0 12px' }}>Browser task</h2>
    <BrowserTaskAssetEditor asset={selected} assets={[selected, child]} recording={null} run={rootRun} batchRuns={runs}
      onImport={() => {}} onSaveDraft={async draft => setSelected(current => ({ ...current, revision: current.revision + 1, draft }))}
      onSaveVersion={async () => {}} onLocateStep={() => {}} onStop={id => { (window as any).subflowProof.stopped = id }}
      onRun={async (input, event) => { if (!event.nativeEvent.isTrusted) throw new Error('Private proof requires native input'); (window as any).subflowProof.invoked = input }} />
  </main>
}
;(window as any).subflowProof = { fixtureOnly: true, appearance: (value: 'light' | 'dark') => updateThemeSelection({ appAppearance: value }) }
createRoot(document.getElementById('root')!).render(<Surface />)
