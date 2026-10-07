import { fixturePath as _historyFixturePath } from "../../../../../test/fixture-values.mjs"
import '../settings-reference/entry'
import { createRoot } from 'react-dom/client'
import { AgentExecutorPicker } from '../../../src/renderer/src/components/AgentExecutorPicker'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import type { ExecutorChoice } from '../../../src/renderer/src/lib/executors'

const unavailable: ExecutorChoice[] = ['EXECUTABLE_NOT_FILE', 'EXECUTABLE_NOT_FOUND'].map((code, index) => {
  const input = { executorId: 'unavailable-' + index, providerId: 'codex', command: _historyFixturePath("controlled/wrapper-") + index,
    host: { id: 'local', kind: 'local' as const, label: 'This Mac' } }
  return { id: input.executorId, label: index ? 'Review wrapper' : 'Directory path', providerId: input.providerId, command: input.command,
    detection: { state: 'missing', input, detail: index ? 'Exact executable not found.' : 'Configured path is a directory.',
      result: { input, executable: input.command, availability: 'missing', cause: { code, message: index ? 'Exact executable not found.' : 'Configured path is a directory.' } } } }
})
Object.assign(window, { showUnavailableExecutors() {
  document.getElementById('root')!.hidden = true
  const host = document.createElement('div')
  host.style.cssText = 'max-width:680px;margin:48px auto;padding:24px'
  document.body.append(host)
  createRoot(host).render(<DesktopClientUiProvider><h2>Start an Agent</h2><AgentExecutorPicker executors={unavailable} selected={null} onSelect={() => { throw Error('Unavailable executable must not launch') }} /></DesktopClientUiProvider>)
} })
