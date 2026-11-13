import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserTaskAssetEditor } from '../../../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun } from '../../../src/shared/browser-task-assets'
import '../../../src/renderer/src/styles/index.css'
mountThemeRuntime(window, { appAppearance: 'dark' })
;(window as any).dragProofAppearance = (mode: 'dark' | 'light', width: number) => { updateThemeSelection({ appAppearance: mode }); document.body.style.width = width + 'px' }
const proof = (window as any).dragProof
function Editor({ initial }: { initial: BrowserTaskAsset }) {
  const [asset, setAsset] = useState(initial), [run, setRun] = useState<BrowserTaskAssetRun | null>(null)
  return <BrowserTaskAssetEditor asset={asset} recording={null} run={run} onImport={() => {}} onLocateStep={() => {}} onStop={() => {}}
    onSaveDraft={async () => { throw new Error('This bounded proof saves a version through the original callback') }}
    onSaveVersion={async draft => setAsset(await proof.save(draft))}
    onRun={async input => setRun(await proof.run(input.version))} />
}
proof.initial().then((asset: BrowserTaskAsset) => createRoot(document.getElementById('root')!).render(<Editor initial={asset} />))
