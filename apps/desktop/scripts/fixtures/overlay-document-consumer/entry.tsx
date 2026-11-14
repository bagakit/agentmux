import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { fixturePath } from '../../../../../test/fixture-values.mjs'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SpaceTopicsTree } from '../../../src/renderer/src/components/SpaceTopicsTree'
import { api } from '../../../src/renderer/src/lib/api'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'

const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: fixturePath('overlay-topics'), kind: 'folder' as const }
const config = await api.config.get()
api.scratch.listTopics = async () => []
const requests: unknown[] = []
api.topics.call = (async (method: string, params: unknown) => {
  requests.push({ method, params })
  throw Error('Cancelled categories must not modify private fixtures')
}) as typeof api.topics.call
useAppStore.setState({ config: { ...config, workspaces: [workspace] }, activeWorkspaceId: workspace.id, topicCategories: [],
  scratchTopicOrder: [], collapsedProjectGroups: {} })

const root = createRoot(document.getElementById('root')!)
let popup: Window | null = null
function open() {
  popup = window.open('about:blank', 'overlay-consumer', 'width=740,height=620')
  if (!popup || popup.document === document) throw Error('The interacting popup must have a separate document')
  popup.document.title = 'Topics'
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const copy = link.cloneNode(true) as HTMLLinkElement
    copy.href = link.href
    popup.document.head.append(copy)
  }
  mountThemeRuntime(popup, { appAppearance: 'dark' })
  render('plain')
  return true
}
function render(mode: 'plain' | 'nested' | 'unmounted', primary = false) {
  if (!popup) throw Error('The private Topics window has not opened')
  const doc = primary ? document : popup.document
  const tree = <SpaceTopicsTree workspace={workspace} icons={{}} onChangeIcon={() => {}} />
  const content = <WorkbenchDocumentContext.Provider value={{ document: doc, window: null }}>
    <DesktopClientUiProvider document={doc}>
      <main className="project-rail" aria-label="Private Topics workface">
        <label>Original draft<textarea id="original-draft" defaultValue="Keep my original draft" /></label>
        {mode === 'plain' ? tree : mode === 'nested' ? <Modal.Root>
          <Modal.Trigger id="nested-trigger">Open Topics</Modal.Trigger>
          <Modal.Portal><Modal.Overlay className="dialog-scrim" />
            <Modal.Content className="dialog-surface confirmation-dialog"><Modal.Title>Topics</Modal.Title>
            <Modal.Description>Choose the topic organization.</Modal.Description>{tree}</Modal.Content>
          </Modal.Portal>
        </Modal.Root> : null}
      </main>
    </DesktopClientUiProvider>
  </WorkbenchDocumentContext.Provider>
  root.render(primary ? content : createPortal(content, doc.body))
}
Object.assign(window, { overlayProof: { open, render, original: () => ({ requests, dialogs: document.querySelectorAll('[data-overlay-modal-scope]').length }) } })
