import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as Modal from '@agentmux/client-ui/components/Modal'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { ImageAnnotationEditor } from '../../../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import '../../../src/renderer/src/styles/index.css'

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
  const image = sampleCapture(owner.document)
  const workface = <WorkbenchDocumentContext.Provider value={{ document: owner.document, window: null }}>
    <Modal.Root>
      <Modal.Trigger>Review the original file</Modal.Trigger>
      <Modal.Portal container={owner.document.body}>
        <Modal.Overlay className="dialog-scrim" />
        <Modal.Content aria-describedby={undefined} className="dialog-surface" style={{ position: 'absolute', inset: 12, overflow: 'hidden' }}>
          <Modal.Title style={{ position: 'absolute', inlineSize: 1, blockSize: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>Screenshot annotation</Modal.Title>
          <ImageAnnotationEditor image={image} initialTool="select" busy={false} ownerDocument={owner.document}
            onCancel={() => requests.push('cancel-editor')} onComplete={() => { requests.push('copy-processed') }}
            onOpenOriginal={() => requests.push('open-original')} onSaveOriginal={() => { requests.push('save-original') }} />
        </Modal.Content>
      </Modal.Portal>
    </Modal.Root>
  </WorkbenchDocumentContext.Provider>
  root.render(createPortal(workface, owner.document.body))
}

function sampleCapture(document: Document) {
  const surface = document.createElement('canvas')
  surface.width = 640
  surface.height = 360
  const paint = surface.getContext('2d')!
  paint.fillStyle = '#e5eaf1'
  paint.fillRect(0, 0, surface.width, surface.height)
  paint.fillStyle = '#f7f9fb'
  paint.fillRect(64, 56, 512, 248)
  paint.fillStyle = '#172b43'
  paint.font = '600 28px system-ui'
  paint.fillText('Workspace overview', 102, 126)
  paint.fillStyle = '#57677a'
  paint.font = '16px system-ui'
  paint.fillText('A capture stays editable before export.', 102, 155)
  paint.fillStyle = '#dbe3ed'
  for (const y of [183, 207, 231, 255]) paint.fillRect(102, y, 328, 8)
  return { dataUrl: surface.toDataURL(), width: surface.width, height: surface.height }
}

Object.assign(window, { dropdownProof: { open, requests } })
