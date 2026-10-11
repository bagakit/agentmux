import { fixturePath as _tailFixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useNativeOverlayChrome } from '../../../src/renderer/src/hooks/useNativeOverlayChrome'
import { api } from '../../../src/renderer/src/lib/api'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WindowOverlayPortal } from '../../../src/renderer/src/components/WindowOverlayHost'
import * as Menu from '../../../src/renderer/src/components/HoverDropdownMenu'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { createCrossDocumentGallery } from './cross-document'

// Actual Workbench, Store, confirmation, collector and Hook. Only IO facts cross
// this fixture bridge; no component, selector or presentation owner is replaced.
// The generic preview contains a relative demo path. This native fixture supplies
// explicit absolute external facts before the original Workbench initializes.
const configGet = api.config.get, snapshot = api.sessions.snapshot, attach = api.sessions.attach
api.config.get = async () => { const config = await configGet(); return { ...config, workspaces: config.workspaces.map(workspace => ({ ...workspace, path: workspace.path.startsWith('/') ? workspace.path : _tailFixturePath("ui-layering/") + workspace.path })) } }
api.sessions.snapshot = async () => { const result = await snapshot(); return { ...result, sessions: result.sessions.map(session => ({ ...session, workspacePath: session.workspacePath.startsWith('/') ? session.workspacePath : _tailFixturePath("ui-layering/") + session.workspacePath })) } }
api.sessions.attach = async (...args) => { const result = await attach(...args); return { ...result, session: { ...result.session, workspacePath: result.session.workspacePath.startsWith('/') ? result.session.workspacePath : _tailFixturePath("ui-layering/") + result.session.workspacePath } } }
mountThemeRuntime(window)
await import('../dialog-surface-craft/entry')
const bridge = (window as any).layeringBridge
api.ui.getZoomFactor = () => bridge.initialZoom
api.ui.publishNativeOverlays = regions => bridge.publish(regions)
api.ui.nativeBrowserVisibility = () => bridge.visibility()
api.ui.onNativeBrowserVisibility = listener => bridge.onVisibility(listener)
api.ui.onNativeOverlayWarning = listener => bridge.onWarning(listener)
api.ui.onNativeBrowserInput = listener => bridge.onInput(listener)
const shell = document.createElement('div'); document.body.append(shell)
const gallery = document.createElement('div'); document.body.append(gallery)
const galleryRoot = createRoot(gallery), events: unknown[] = []
const crossDocument = createCrossDocumentGallery(node => flushSync(() => galleryRoot.render(node)))
const geometryStyle = document.createElement('style'); document.head.append(geometryStyle)
function NativeChrome() { useNativeOverlayChrome(); return null }
createRoot(shell).render(<NativeChrome />)
for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, event => {
  const target = event.target as Element | null
  if (target?.closest('.confirmation-dialog, [role="menu"], .modal-presentation-note')) events.push({ type, trusted: event.isTrusted, label: target.closest('button, [role="menuitem"]')?.textContent })
}, true)
let actions: string[] = []
function closeGallery() { actions.push('cancel'); flushSync(() => galleryRoot.render(null)) }
function CompletionConfirmation() {
  const [draft, setDraft] = useState('')
  return <ConfirmationDialog open title="Original modal draft" description="Completion remains in this modal's input and keyboard scope." confirmLabel="Confirm"
    onCancel={closeGallery} onConfirm={() => actions.push('confirm')} feedback={<AgentComposer value={draft} disabled={false} placeholder="Retain this unsent draft"
      commands={[{ text: '/inspect', description: 'Inspect retained draft' }, { text: '/review', description: 'Review original work' }]}
      onChange={setDraft} onSelectSuggestion={text => { actions.push('completion:' + text) }} onSubmit={() => actions.push('send')} />} />
}
Object.assign(window, { layeringProbe: {
  crossDocument,
  events: () => events,
  seed() { flushSync(() => galleryRoot.render(null)); (window as any).dialogCraft.seed() },
  nested() {
    actions = []
    flushSync(() => galleryRoot.render(<DesktopClientUiProvider><ConfirmationDialog open title="Parent modal"
      description="Nested controls retain their parent modal and keyboard ownership." confirmLabel="Confirm"
      onCancel={closeGallery} onConfirm={() => actions.push('confirm')} feedback={<>
        <Menu.Root><Menu.Trigger id="nested-menu-trigger" className="small-button">Nested menu</Menu.Trigger>
          <Menu.Portal><Menu.Content className="tab-context-menu" side="right" align="start"><Menu.Item className="tab-context-menu__item" onSelect={() => actions.push('nested-action')}>Nested action</Menu.Item></Menu.Content></Menu.Portal>
        </Menu.Root>
        <WindowOverlayPortal layer="tooltip"><span id="nested-tooltip" role="tooltip" className="layering-fixture-tooltip"
          style={{ position: 'fixed', top: 'calc(50% - 108px)', left: '50%', padding: 8, background: 'var(--surface-2)', pointerEvents: 'auto' }}>Attached tooltip</span></WindowOverlayPortal>
      </>} /></DesktopClientUiProvider>))
  },
  completion() { actions = []; flushSync(() => galleryRoot.render(<DesktopClientUiProvider><CompletionConfirmation /></DesktopClientUiProvider>)) },
  actions: () => actions,
  shiftModal(x: number) { const sheet = geometryStyle.sheet!; while (sheet.cssRules.length) sheet.deleteRule(0); sheet.insertRule(`.confirmation-dialog { margin-left: ${x}px !important; }`) },
  foreignPopover(open: boolean) {
    document.getElementById('fixture-foreign-popover')?.remove()
    if (!open) return
    const node = document.createElement('aside'); node.id = 'fixture-foreign-popover'; node.setAttribute('popover', 'manual')
    node.textContent = 'Original native HTML popover'; node.style.cssText = 'position:fixed;inset:35% 25%;background:#7f4629;color:white;padding:28px'
    document.body.append(node); node.showPopover()
  },
  read() {
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    const nodes = [...document.querySelectorAll<HTMLElement>('[data-overlay-modal-id], [role="menu"], [role="tooltip"], .composer-completion-popover')]
      .filter(node => { const s = getComputedStyle(node), r = node.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 })
    return { nodes: nodes.map(node => ({ id: node.id, role: node.getAttribute('role'), modal: node.dataset.overlayModalId, part: node.dataset.overlayModalPart,
      ...(node.matches('.composer-completion-popover') ? { kind: 'composer-completion' } : {}),
      inSlot: !!node.closest('[data-overlay-modal-slot]'), bounds: rect(node), background: getComputedStyle(node).backgroundColor,
      hit: document.elementFromPoint(node.getBoundingClientRect().x + node.getBoundingClientRect().width / 2, node.getBoundingClientRect().y + node.getBoundingClientRect().height / 2)?.closest('[role="dialog"], [role="menu"], [role="tooltip"], .composer-completion-popover') === node })),
      active: document.activeElement?.textContent, failures: document.querySelectorAll('.modal-presentation-note').length,
      workbench: (window as any).dialogCraft.facts(), events }
  }
} })
