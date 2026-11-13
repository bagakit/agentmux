import { useEffect, useRef, useState } from 'react'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { createRoot } from 'react-dom/client'
import { BrowserTaskAssetEditor } from '../../../src/renderer/src/components/BrowserTaskAssetEditor'
import { BrowserTaskCreationNotice } from '../../../src/renderer/src/components/BrowserTaskCreationNotice'
import { browserTaskCreateInput, type BrowserTaskCreateInput } from '../../../src/shared/browser-task-creation'
import { submitBrowserTaskCreation, inspectBrowserTaskCreation, type BrowserTaskCreationPorts } from '../../../src/renderer/src/lib/browser-task-creation'
import type { BrowserTaskAsset } from '../../../src/shared/browser-task-assets'
import '../../../src/renderer/src/styles/index.css'

mountThemeRuntime(window, { appAppearance: 'dark' })
const bridge = (window as any).taskProof
function Surface() {
  const [source, setSource] = useState<any>(null), [asset, setAsset] = useState<BrowserTaskAsset | null>(null)
  const [inputs, setInputs] = useState<BrowserTaskCreateInput[]>(() => JSON.parse(localStorage.getItem('original-inputs') ?? '[]'))
  const current = useRef(inputs), generation = useRef(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function refresh() {
    const state = await bridge.state(); setSource(await bridge.source())
    const id = current.current[0]?.assetId ?? (window as any).selectedTaskId
    setAsset(state.assets.find((item: BrowserTaskAsset) => item.id === id) ?? null)
  }
  useEffect(() => { void refresh() }, [])
  function ports(): BrowserTaskCreationPorts {
    const action = generation.current
    return { keep: async (input, expected) => {
      const original = current.current
      if (!input && !original.some(value => value.createOperationId === expected)) return false
      const next = input ? original.some(value => value.createOperationId === input.createOperationId) ? original : [...original, input]
        : original.filter(value => value.createOperationId !== expected)
      localStorage.setItem('original-inputs', JSON.stringify(next)); current.current = next; setInputs(next); return true
    }, create: bridge.create, inspect: bridge.inspect,
      isCurrent: input => input.browserId === source?.browserId && generation.current === action,
      select: id => { (window as any).selectedTaskId = id } }
  }
  async function perform(event: any, input?: BrowserTaskCreateInput, check = false) {
    if (event.nativeEvent.isTrusted !== true) throw new Error('Private proof needs a genuine native input event')
    generation.current++; setBusy(true); setError('')
    try { if (check) await inspectBrowserTaskCreation(ports(), input!); else await submitBrowserTaskCreation(ports(), input ?? browserTaskCreateInput(source)) }
    catch (value) { setError(value instanceof Error ? value.message : String(value)) }
    finally { await refresh(); setBusy(false) }
  }
  return <main style={{ maxWidth: 850, margin: '24px auto', padding: 20 }}>
    <h2>Browser tasks</h2>
    {inputs.map(input => <BrowserTaskCreationNotice key={input.createOperationId} input={input} busy={busy}
      onInspect={event => void perform(event, input, true)} onContinue={event => void perform(event, input)} />)}
    {error ? <p role="status" style={{ color: 'var(--amber-text)', fontSize: 'var(--fs-micro)' }}>{error}</p> : null}
    <BrowserTaskAssetEditor asset={asset} recording={source} run={null} busy={busy || !asset && Boolean(inputs.length)} onImport={event => void perform(event)}
      onSaveDraft={async () => {}} onSaveVersion={async () => {}} onLocateStep={() => {}} onRun={async () => {}} onStop={() => {}} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Surface />)
