import { useState, type ReactNode } from 'react'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'
import { StableWorkbenchView } from '../../../src/renderer/src/components/StableWorkbenchView'
import { useWorkbenchDocument, useWorkbenchWindowDocument } from '../../../src/renderer/src/lib/workbench-document'
import { originalWorkbenchHost, placeWorkbenchWindow, registerWorkbenchDocument, workbenchDocumentIdentity } from '../../../src/renderer/src/lib/workbench-window-registry'

// This is a same-origin iframe document test, not a second native Window or an
// iframe native-overlay implementation. The actual retained-workface owner and
// actual product form/dialog remain the subjects under test.
export function createCrossDocumentGallery(render: (node: ReactNode) => void) {
  const reference = { displayWorkspaceId: 'layering-cross-document', groupId: 'original-group', tabId: 'moving-tab', regionId: 'original-region' }
  const otherReference = { ...reference, tabId: 'independent-tab', regionId: 'independent-region' }
  const target = (ref: typeof reference) => ({ kind: 'tab' as const, displayWorkspaceId: ref.displayWorkspaceId, groupId: ref.groupId, tabId: ref.tabId })
  const childScope = { windowId: 'layering-iframe-document', documentGeneration: 'original-iframe-generation' }
  type Member = { open: boolean; draft: string; cancels: number; confirms: number; document: Document; scope: unknown; identity: object; setOpen(value: boolean): void }
  const members = new Map<string, Member>()
  let frame: HTMLIFrameElement | null = null, child: Document | null = null, destination: HTMLElement | null = null
  let releases: Array<() => void> = []
  let retained: { editor: HTMLElement; form: HTMLElement; host: HTMLElement; content: HTMLElement; modal: string; identity: object } | null = null
  const parkedFrameStyle = 'position:fixed;left:24px;top:64px;width:620px;height:580px;border:1px solid #778;background:#171719;z-index:0'
  const doc = (which: string) => which === 'A' ? document : child!
  const form = (name: string) => members.get(name)?.document.querySelector<HTMLElement>(`[data-cross-document-form="${name}"]`)
  const content = (name: string) => form(name)?.closest<HTMLElement>('.confirmation-dialog')
  const isVisible = (node: HTMLElement) => !node.closest('[hidden]') && node.ownerDocument.defaultView!.getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0
  function OriginalForm({ name, initiallyOpen }: { name: string; initiallyOpen: boolean }) {
    const owner = useWorkbenchDocument(), scope = useWorkbenchWindowDocument()
    const [open, setOpen] = useState(initiallyOpen), [draft, setDraft] = useState('')
    const [member] = useState<Member>(() => ({ open, draft, cancels: 0, confirms: 0, document: owner, scope, identity: {}, setOpen }))
    Object.assign(member, { open, draft, document: owner, scope, setOpen }); members.set(name, member)
    return <ConfirmationDialog open={open} title={'Original ' + name + ' document form'} description="The same retained workface and unsent editor move through the product placement API."
      intent="neutral" confirmLabel="Confirm" onCancel={() => { member.cancels++; setOpen(false) }} onConfirm={() => { member.confirms++ }}
      feedback={<div data-cross-document-form={name}><AgentComposer value={draft} disabled={false} placeholder={'Original ' + name + ' unsent draft'} onChange={setDraft} onSubmit={() => { member.confirms++ }} /></div>} />
  }
  function snapshot() {
    const moving = members.get('moving'), current = content('moving'), editor = form('moving')?.querySelector<HTMLElement>('[role="textbox"]')
    return { boundary: 'Actual StableWorkbenchView and placeWorkbenchWindow; same-origin iframe ownerDocument; document-scoped synthetic focus/Escape/Cancel. Separate BrowserWindow/native proof remains required.',
      sameHost: !!retained && originalWorkbenchHost(target(reference))?.host === retained.host,
      sameEditor: !!retained && editor === retained.editor, sameForm: !!retained && form('moving') === retained.form,
      sameContent: !!retained && current === retained.content, sameIdentity: !!retained && moving?.identity === retained.identity,
      hostDocument: originalWorkbenchHost(target(reference))?.host.ownerDocument === document ? 'A' : originalWorkbenchHost(target(reference))?.host.ownerDocument === child ? 'B' : 'unknown',
      modal: current?.dataset.overlayModalId, retainedModal: retained?.modal,
      editorText: editor?.textContent, frameConnected: frame?.isConnected, frameSameDocument: frame?.contentDocument === child,
      members: Object.fromEntries([...members].map(([name, member]) => [name, { open: member.open, draft: member.draft, cancels: member.cancels, confirms: member.confirms,
        document: member.document === document ? 'A' : member.document === child ? 'B' : 'unknown', scope: member.scope,
        activeInContent: !!content(name)?.contains(member.document.activeElement), formConnected: form(name)?.isConnected,
        modal: content(name)?.dataset.overlayModalId }])),
      documents: Object.fromEntries(['A', 'B'].map(which => { const owner = doc(which), background = owner.querySelector('[data-cross-document-background]')
        return [which, { liveModals: [...owner.querySelectorAll<HTMLElement>('[data-overlay-modal-part="content"]')].filter(isVisible).map(node => node.dataset.overlayModalId),
          focusGuards: owner.querySelectorAll('[data-radix-focus-guard]').length, pointerEvents: owner.body.style.pointerEvents, scrollLockCount: owner.body.getAttribute('data-scroll-locked'),
          backgroundActive: owner.activeElement === background, activeRole: owner.activeElement?.getAttribute('role'),
          activeText: owner.activeElement?.textContent?.slice(0, 120) }] })) }
  }
  async function start() {
    if (frame) throw new Error('A cross-document fixture must finish before another starts')
    members.clear(); retained = null
    frame = document.createElement('iframe'); frame.id = 'layering-document-frame'; frame.title = 'Isolated original workface document'
    frame.style.cssText = parkedFrameStyle
    document.body.append(frame); child = frame.contentDocument!
    child.documentElement.lang = 'en'; child.body.style.margin = '0'
    const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')].map(node => {
      const clone = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement
      const loaded = clone.tagName === 'LINK' ? new Promise<void>((resolve, reject) => { clone.addEventListener('load', () => resolve(), { once: true }); clone.addEventListener('error', () => reject(new Error('Original stylesheet failed in the iframe document')), { once: true }) }) : Promise.resolve()
      child!.head.append(clone); return loaded
    })
    await Promise.all(styles)
    releases.push(mountThemeRuntime(child.defaultView!))
    if (!workbenchDocumentIdentity(document)) releases.push(registerWorkbenchDocument(document, { windowId: 'layering-root-document', documentGeneration: 'original-root-generation' }))
    releases.push(registerWorkbenchDocument(child, childScope))
    for (const owner of [document, child]) { const background = owner.createElement('button'); background.dataset.crossDocumentBackground = ''; background.textContent = 'Original document background'; owner.body.append(background) }
    destination = child.createElement('div'); destination.id = 'layering-iframe-destination'; child.body.append(destination)
    render(<><div id="layering-moving-home" /><div id="layering-independent-home" />
      <StableWorkbenchView homeId="layering-moving-home" targetId={null} primaryTabId={reference.tabId} reference={reference} active visible retainedRegionId={reference.regionId}><OriginalForm name="moving" initiallyOpen /></StableWorkbenchView>
      <StableWorkbenchView homeId="layering-independent-home" targetId={null} primaryTabId={otherReference.tabId} reference={otherReference} active visible retainedRegionId={otherReference.regionId}><OriginalForm name="independent" initiallyOpen={false} /></StableWorkbenchView>
    </>)
    await placeWorkbenchWindow(target(otherReference), { destination, window: childScope })
    return snapshot()
  }
  return { start, read: snapshot,
    remember() {
      const element = form('moving')!, dialog = content('moving')!
      retained = { editor: element.querySelector<HTMLElement>('[role="textbox"]')!, form: element, content: dialog,
        host: originalWorkbenchHost(target(reference))!.host, modal: dialog.dataset.overlayModalId!, identity: members.get('moving')!.identity }
      if (!retained.editor || !retained.modal) throw new Error('The real retained form and modal must exist before migration')
      return snapshot()
    },
    async move(which: string) { await placeWorkbenchWindow(target(reference), which === 'B' ? { destination: destination!, window: childScope } : null); return snapshot() },
    focusBackground(which: string) { doc(which).querySelector<HTMLElement>('[data-cross-document-background]')!.focus(); return snapshot() },
    wheelBackground(which: string) { const owner = doc(which), event = new owner.defaultView!.WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }); owner.querySelector('[data-cross-document-background]')!.dispatchEvent(event); return { defaultPrevented: event.defaultPrevented, trusted: event.isTrusted } },
    focusEditor(name: string) { form(name)!.querySelector<HTMLElement>('[role="textbox"]')!.focus(); return snapshot() },
    escape(which: string) { const owner = doc(which); owner.activeElement!.dispatchEvent(new owner.defaultView!.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); return snapshot() },
    cancel(name: string) { content(name)!.querySelector<HTMLButtonElement>('.confirmation-dialog__cancel')!.click(); return snapshot() },
    open(name: string) { members.get(name)!.setOpen(true) },
    nestFrame() {
      // The iframe is a real focus descendant of A. Otherwise A legitimately
      // treats focus on an outside iframe as leaving its own modal boundary.
      const node = form('moving')!; frame!.style.cssText = 'display:block;width:100%;height:230px;border:1px solid #778;margin-top:12px'
      node.moveBefore(frame!, null)
      if (!frame!.isConnected || frame!.contentDocument !== child) throw new Error('A connected iframe move must retain its original document')
      return snapshot()
    },
    parkFrame() {
      // The independent document must not be destroyed with A's modal DOM.
      // moveBefore retains the connected iframe and its original live document.
      document.body.moveBefore(frame!, null); frame!.style.cssText = parkedFrameStyle
      if (!frame!.isConnected || frame!.contentDocument !== child) throw new Error('Parking the connected iframe must retain its original document')
      return snapshot()
    },
    async dispose() {
      if (!frame) return
      document.body.moveBefore(frame, null)
      await placeWorkbenchWindow(target(reference), null); await placeWorkbenchWindow(target(otherReference), null)
      render(null)
      for (const release of releases.reverse()) release(); releases = []
      document.querySelector('[data-cross-document-background]')?.remove(); frame.remove(); frame = null; child = null; destination = null; retained = null; members.clear()
    }
  }
}
