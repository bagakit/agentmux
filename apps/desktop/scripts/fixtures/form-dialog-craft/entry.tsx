import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { ProjectGroupDialog } from '../../../src/renderer/src/components/ProjectGroupDialog'
import { HostFolderDialog } from '../../../src/renderer/src/components/HostFolderDialog'
import { TopicCategoryDialog } from '../../../src/renderer/src/components/TopicCategoryDialog'
import { MoteRenameDialog } from '../../../src/renderer/src/components/MoteRenameDialog'
import { BrowserViewportSizeDialog } from '../../../src/renderer/src/components/BrowserViewportControls'
import { resolveOverlayContainer } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { projectWorkspaces } from '../../../src/renderer/src/lib/workspace-projects'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'
import './scene.css'

const workspace = { id: 'original-workspace', hostId: 'local', name: 'Product research', path: fixturePath('research'), kind: 'folder' as const }
const remote = { id: 'remote-workspace', hostId: 'original-host', name: 'Interface review', path: fixturePath('review'), kind: 'folder' as const }
const topic = { id: 'original-mote', title: 'Research partner', summary: '', directoryPath: 'original-mote', topicPath: 'original-mote/topic.md', identityDirectoryPath: workspace.path, physicalDirectoryPath: workspace.path, collaborators: [] }
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This device' }, { id: 'original-host', kind: 'ssh', label: 'Research host' }], executors: {}, workspaces: [workspace, remote], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } }
const projects = projectWorkspaces([workspace, remote]), saveRequests: unknown[] = [], folderRequests: unknown[] = [], errors: string[] = []
let saveMode = 'confirmed'
useAppStore.setState({ config: config as any, projectGroups: [], selectWorkspace: async () => {},
  saveProjectGroup: async request => { saveRequests.push(request); if (saveMode === 'failure') throw new Error('The selected host is temporarily unavailable. Your group is kept here.'); return { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: saveMode === 'unconfirmed' ? 'unconfirmed' : 'confirmed', reason: null } },
  renameScratchTopic: async () => {} })
api.workspaces.add = async request => { folderRequests.push(request); throw new Error('The original host could not confirm this folder. Your path is kept here.') }
window.addEventListener('error', event => errors.push(event.message))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
let choose: (kind: string | null) => void
function App() {
  const [kind, setKind] = useState<string | null>(null); choose = setKind
  const invoker = useRef<HTMLButtonElement>(null)
  const close = () => setKind(null)
  return <ClientUiProvider platform={{ copyText: async () => {}, ownerDocument: document, overlayContainer: resolveOverlayContainer }}>
    <main className="form-proof-workface"><header><strong>Space</strong><span>Research</span></header><section><h1>Product research</h1><p>Original workspace · drafts and sessions stay together</p><button ref={invoker} className="small-button" onClick={() => setKind('group')}>Organize projects</button><div className="form-proof-context"><strong>Research partner</strong><p>Reviewing interface details</p></div></section></main>
    {kind === 'group' ? <ProjectGroupDialog projects={projects} seed={projects[0]!.id} related={new Map()} observations={new Map()} onClose={close} /> : null}
    {kind === 'folder' ? <HostFolderDialog hostId="original-host" label="Research host" onClose={close} /> : null}
    {kind === 'category' ? <TopicCategoryDialog target="create" onClose={close} returnFocus={() => invoker.current} /> : null}
    {kind === 'mote' ? <MoteRenameDialog target={{ topic, workspace }} onClose={close} returnFocus={() => invoker.current} /> : null}
    {kind === 'viewport' ? <BrowserViewportSizeDialog value="desktop" visible onClose={close} onApply={async () => {}} /> : null}
  </ClientUiProvider>
}
mountThemeRuntime(window, { themeId: 'graphite', appAppearance: 'dark' })
createRoot(document.getElementById('root')!).render(<App />)
const delay = () => new Promise(resolve => setTimeout(resolve, 100))
const bounds = (node: Element) => { const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
Object.assign(window, { formProof: {
  ready: true,
  async open(kind: string, appearance: 'dark' | 'light') { flushSync(() => choose(null)); await delay(); updateThemeSelection({ themeId: 'graphite', appAppearance: appearance }); document.querySelector<HTMLElement>('.form-proof-workface button')!.focus(); flushSync(() => choose(kind)); await delay(); return this.facts() },
  mode(value: string) { saveMode = value },
  facts() { const dialog = document.querySelector<HTMLElement>('.confirmation-dialog'), close = dialog?.querySelector<HTMLElement>('.confirmation-dialog__heading > .icon-button'), input = dialog?.querySelector<HTMLInputElement>('input'), primary = dialog?.querySelector<HTMLButtonElement>('.primary-button')
    return { dialog: dialog ? { ...bounds(dialog), title: dialog.querySelector('h2')?.textContent, overflow: dialog.scrollWidth > dialog.clientWidth, close: close ? bounds(close) : null, padding: Number.parseFloat(getComputedStyle(dialog).paddingRight), field: input ? { ...bounds(input), border: getComputedStyle(input).borderRadius, fontSize: getComputedStyle(input).fontSize } : null, primary: primary?.textContent, primaryCount: dialog.querySelectorAll('.primary-button').length } : null,
      headingIconColor: dialog?.querySelector('.confirmation-dialog__heading > svg') ? getComputedStyle(dialog.querySelector('.confirmation-dialog__heading > svg')!).color : null,
      neutralColor: getComputedStyle(document.querySelector('.form-proof-workface p')!).color,
      focusInside: Boolean(dialog?.contains(document.activeElement)), focused: document.activeElement?.textContent, value: input?.value, errors, saveRequests, folderRequests,
      scrimAnimation: document.querySelector('.dialog-scrim') ? getComputedStyle(document.querySelector('.dialog-scrim')!).animationName : null }
  },
  point(selector: string) { const rect = document.querySelector(selector)!.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } },
  setInput(value: string) { const input = document.querySelector<HTMLInputElement>('.confirmation-dialog input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); return this.facts() }
} })
