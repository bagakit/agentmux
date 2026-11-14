// Optional bounded Phone presentation; business/Runtime evidence lives in the real producer tests.
import { createRoot } from 'react-dom/client'
import { MobileConnectionResult } from '../../../src/renderer/src/components/toolkit/MobileConnectionResult'
import { api } from '../../../src/renderer/src/lib/api'
import type { ToolkitScriptSnapshot, ToolkitConfirmedResult, ToolkitToolDefinition, ToolkitRunInput } from '@agentmux/core/control'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'
const phoneWindow = window as any
mountThemeRuntime(window, { appAppearance: 'light' })
let phoneRoot: ReturnType<typeof createRoot> | undefined, phoneSnapshot: ToolkitScriptSnapshot, phoneRead: (value: ToolkitScriptSnapshot) => void
const phoneDefinition: ToolkitToolDefinition = { id: 'builtin:mobile-connection', name: 'Phone connection', revision: 'controlled-presentation', enabled: true,
  icon: 'smartphone', statusBar: 'icon', workspacePath: '/controlled/phone', script: 'controlledRead()', args: [], display: { script: 'controlledRead()', args: [] }, actions: [] }
const phoneResult: ToolkitConfirmedResult = { executionId: 'phone-visual-original', invocationId: 'phone-visual-original', definition: phoneDefinition,
  expectedLatestExecutionId: null, target: { workspacePath: phoneDefinition.workspacePath }, run: { hostId: 'local', runId: 'phone-visual-only' },
  startedAt: 1794379999000, endedAt: 1794380000000, state: 'succeeded', reason: null, exitCode: 0, text: '',
  document: { schema: 'agentmux.toolkit.result.v1', summary: '1 connected', items: [{ label: 'My phone', value: 'Connected · 192.0.2.24' }],
    links: [{ label: 'Phone connection link', url: 'http://192.0.2.44:8443/#controlled-presentation-offer' }], notice: 'Controlled presentation only; no device connection was made.' } }
phoneWindow.phoneLinkScene = {
  copies: [] as string[],
  show(theme: 'light' | 'dark', failed = false) {
    updateThemeSelection({ appAppearance: theme })
    if (!phoneRoot) {
      const target = document.createElement('div'); target.className = 'settings-page'; target.style.cssText = 'display:block;min-height:100vh;overflow:auto;background:var(--surface-0);color:var(--text)'
      document.body.append(target); phoneRoot = createRoot(target)
    }
    phoneSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: phoneDefinition.id, definition: phoneDefinition, state: 'idle', reason: null,
      admission: null, latestConfirmed: null, consumerCount: 1, sequence: 1, display: { state: failed ? 'failed' : 'succeeded', reason: failed ? 'Current connection lookup is unavailable. The shown link is kept.' : null,
        admission: null, latestConfirmed: failed ? { ...phoneResult, executionId: 'phone-visual-failed', state: 'failed', document: null, exitCode: 1 } : phoneResult, lastSucceeded: phoneResult, sequence: 1 } }
    api.toolkit.observe = (_id, read) => { phoneRead = read; read(phoneSnapshot); return { dispose() {} } }
    api.toolkit.get = async () => phoneSnapshot
    api.toolkit.evaluate = async (_id, input?: ToolkitRunInput) => {
      if (!input) throw Error('Phone presentation only accepts the explicit fresh request')
      const { endedAt: _ended, exitCode: _exit, ...admitted } = { ...phoneResult, executionId: 'phone-visual-pending', invocationId: input.invocationId, expectedLatestExecutionId: input.expectedLatestExecutionId }
      phoneSnapshot = { ...phoneSnapshot, sequence: 2, display: { ...phoneSnapshot.display!, state: 'running', admission: { ...admitted, state: 'running' }, sequence: 2 } }
      phoneRead(phoneSnapshot); return phoneSnapshot
    }
    api.ui.writeClipboardText = async value => { phoneWindow.phoneLinkScene.copies.push(value) }
    phoneRoot.render(<section className="performance-popover" style={{ position: 'relative', width: 'min(480px, calc(100% - 24px))', margin: '24px auto' }}>
      <MobileConnectionResult key={theme + String(failed)} active close={() => {}} />
    </section>)
  }
}
