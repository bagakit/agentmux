import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { AnnotationOriginalMenu } from '../../../src/renderer/src/components/image-annotation/AnnotationOriginalMenu'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import '../../../src/renderer/src/styles/index.css'
import '../../../src/renderer/src/components/image-annotation/image-annotation.css'

const root = createRoot(document.getElementById('root')!)
const requests: string[] = []

function open() {
  const owner = window.open('about:blank', 'original-actions', 'width=392,height=300')
  if (!owner) throw new Error('An independent window is required')
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const copy = link.cloneNode(true) as HTMLLinkElement
    copy.href = link.href
    owner.document.head.append(copy)
  }
  mountThemeRuntime(owner, { appAppearance: 'dark' })
  const workface = <WorkbenchDocumentContext.Provider value={{ document: owner.document, window: null }}>
    <Modal.Root>
      <Modal.Trigger>Review the original file</Modal.Trigger>
      <Modal.Portal container={owner.document.body}>
        <Modal.Overlay className="dialog-scrim" />
        <Modal.Content className="dialog-surface confirmation-dialog">
          <Modal.Title>Screenshot annotation</Modal.Title>
          <Modal.Description>File actions follow the original screenshot.</Modal.Description>
          <AnnotationOriginalMenu active busy={false} loaded
            onOpen={() => requests.push('open-original')} onSave={() => requests.push('save-original')} />
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root>
  </WorkbenchDocumentContext.Provider>
  root.render(createPortal(workface, owner.document.body))
}

Object.assign(window, { dropdownProof: { open, requests } })
