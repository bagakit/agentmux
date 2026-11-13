import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { FilePreviewPane } from '../../../src/renderer/src/components/FilePreviewPane'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'

const boot = (window as any).fileSourceFixtureBoot
if (!boot || !window.agentmux) throw new Error('Private native file source facts are required')
mountThemeRuntime(window, { appAppearance: 'dark' })
api.files = window.agentmux.files
useAppStore.setState({ config: boot.config, activeWorkspaceId: 'source-private', documentIssues: {}, documents: {} })
const root = createRoot(document.getElementById('root')!)
const surface = { kind: 'file' as const, regionId: 'original-pdf-region', workspaceId: 'source-private', path: 'large.pdf' }
function render(visible = true) { flushSync(() => root.render(<FilePreviewPane surface={surface} visible={visible} />)) }
// The app shell is initialized before a person opens a File; the PDF leaf stays cold until render().
flushSync(() => root.render(<div role="status">Private file source workface ready.</div>))
;(window as any).fileSourceProbe = {
  render,
  page(number: number) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="PDF page"]')!
    input.focus(); input.value = String(number); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  },
  state() { return { phase: document.querySelector('.pdf-content')?.getAttribute('data-decode-state'),
    page: document.querySelector<HTMLInputElement>('input[aria-label="PDF page"]')?.value,
    text: document.body.innerText, canvasPages: [...document.querySelectorAll('.pdfViewer .page')].filter(page => page.querySelector('canvas')).map(page => page.getAttribute('data-page-number')) } }
}
