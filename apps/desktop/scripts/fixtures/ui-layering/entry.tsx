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
import { PmoTeamsTopicEntry } from '../../../src/renderer/src/components/PmoTeamsTopicEntry'
import { useAppStore } from '../../../src/renderer/src/store'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import type { AvatarLayeringSeed } from './avatar-seed'

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
let avatarCleanup: (() => void) | undefined
let avatarSeed: AvatarLayeringSeed | undefined
let avatarCalls: Array<{ method: string; target?: unknown }> = []
let avatarOriginal: { canvas: HTMLCanvasElement; modal: HTMLElement } | undefined
function avatarRead() {
  const modal = document.querySelector<HTMLElement>('.space-icon-picker'), canvas = modal?.querySelector<HTMLCanvasElement>('.mote-series__preview canvas')
  const png = modal?.querySelector<HTMLImageElement>('.mote-series__sizes img')?.src
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  let material: { point: { x: number; y: number }; hit: boolean; rgba: number[] } | undefined
  if (modal) {
    const bounds = modal.getBoundingClientRect(), style = getComputedStyle(modal)
    const point = { x: bounds.x + Math.max(3, parseFloat(style.paddingLeft) / 2), y: bounds.y + bounds.height / 2 }
    const reference = document.createElement('canvas'); reference.width = reference.height = 1
    const context = reference.getContext('2d')!; context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1)
    material = { point, hit: document.elementFromPoint(point.x, point.y) === modal, rgba: [...context.getImageData(0, 0, 1, 1).data] }
  }
  return { target: avatarCalls.find(call => call.method === 'read')?.target,
    invokerTargetKey: document.querySelector<HTMLElement>('[data-pmo-teams-topic-launcher] button')?.dataset.spaceIconTarget,
    seriesTargetKey: modal?.querySelector<HTMLElement>('[data-series-target]')?.dataset.seriesTarget,
    controls: { material: modal?.querySelector<HTMLElement>('[data-series-material][aria-pressed="true"]')?.dataset.seriesMaterial,
      yaw: modal?.querySelector<HTMLInputElement>('[aria-label="Series model rotation"]')?.value,
      morphs: [...modal?.querySelectorAll<HTMLInputElement>('[data-series-morph]') ?? []].map(node => ({ id: node.dataset.seriesMorph, value: node.value })) },
    originalChoice: useAppStore.getState().spaceObjectIcons[avatarSeed?.baseline.target.objectKey ?? ''],
    modalId: modal?.dataset.overlayModalId, sameModal: !!avatarOriginal && avatarOriginal.modal === modal,
    sameCanvas: !!avatarOriginal && avatarOriginal.canvas === canvas, canvas: canvas ? box(canvas) : null, png,
    frameSource: canvas?.dataset.seriesFrameSource, renderFacts: canvas?.dataset.seriesRenderFacts,
    draftReady: modal?.dataset.seriesDraftReady, calls: avatarCalls, material,
    sourceInputs: avatarSeed?.sourceInputs, menuOpen: !!document.querySelector('[role="menu"]'),
    activeInvoker: document.activeElement === document.querySelector('[data-pmo-teams-topic-launcher] button') }
}
function startAvatar(seed: AvatarLayeringSeed) {
  if (avatarCleanup) throw new Error('The original private Avatar scene must finish before another begins')
  avatarSeed = seed; avatarCalls = []; avatarOriginal = undefined
  const original = { config: useAppStore.getState().config, icons: useAppStore.getState().spaceObjectIcons,
    snapshots: useAppStore.getState().scratchTopicSnapshots, avatars: { ...api.moteAvatars }, listTopics: api.scratch.listTopics, saveConfig: api.config.save }
  api.scratch.listTopics = async workspaceId => workspaceId === seed.workspace.id ? [structuredClone(seed.topic)] : original.listTopics(workspaceId)
  api.moteAvatars.list = async () => { avatarCalls.push({ method: 'list' }); return structuredClone(seed.catalog) }
  api.moteAvatars.read = async input => {
    avatarCalls.push({ method: 'read', target: input.target })
    if (JSON.stringify(input.target) !== JSON.stringify(seed.baseline.target)) throw new Error('Only the original isolated Mote identity may be read')
    return structuredClone(seed.baseline)
  }
  api.moteAvatars.preview = async input => {
    avatarCalls.push({ method: 'preview', target: input.source })
    const found = seed.prepared.find(value => value.source.origin === input.source.origin && value.source.seriesId === input.source.seriesId && value.source.entryId === input.source.entryId)
    if (!found || input.expectedRevision && input.expectedRevision !== found.source.revision) throw new Error('Only the exact original prepared source bytes may be consumed')
    return structuredClone(found)
  }
  api.moteAvatars.save = async input => { avatarCalls.push({ method: 'save', target: input.target }); throw new Error('This layering scene cancels the original avatar; it never saves') }
  api.config.save = async () => { avatarCalls.push({ method: 'config.save' }); throw new Error('This layering scene never saves original configuration') }
  avatarCleanup = () => {
    flushSync(() => galleryRoot.render(null)); Object.assign(api.moteAvatars, original.avatars)
    api.scratch.listTopics = original.listTopics; api.config.save = original.saveConfig
    useAppStore.setState({ config: original.config, spaceObjectIcons: original.icons, scratchTopicSnapshots: original.snapshots })
    avatarCleanup = undefined
  }
  useAppStore.setState({ config: { ...original.config!, workspaces: [...original.config!.workspaces.filter(value => value.id !== seed.workspace.id), seed.workspace] },
    spaceObjectIcons: { ...original.icons, [seed.baseline.target.objectKey]: seed.baseline.choice as 'rocket' },
    scratchTopicSnapshots: { ...original.snapshots, [seed.workspace.id]: { scope: scratchTopicsScope(seed.workspace), revision: 0, topics: [seed.topic], error: null, reading: false } } })
  flushSync(() => galleryRoot.render(<DesktopClientUiProvider><PmoTeamsTopicEntry style={{ position: 'fixed', left: 28, top: 84 }} /></DesktopClientUiProvider>))
  return avatarRead()
}
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
  avatar: { start: startAvatar, read: avatarRead, remember() {
    avatarOriginal = { modal: document.querySelector('.space-icon-picker')!, canvas: document.querySelector('.mote-series__preview canvas')! }
    if (!avatarOriginal.modal || !avatarOriginal.canvas) throw new Error('The original Avatar modal and real GLB canvas must exist')
    return avatarRead()
  }, dispose() { avatarCleanup?.() } },
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
      hit: (() => { const hit = document.elementFromPoint(node.getBoundingClientRect().x + node.getBoundingClientRect().width / 2, node.getBoundingClientRect().y + node.getBoundingClientRect().height / 2)
        return node.matches('[data-overlay-modal-part="content"]') ? !!hit && node.contains(hit) : hit?.closest('[role="dialog"], [role="menu"], [role="tooltip"], .composer-completion-popover') === node })() })),
      active: document.activeElement?.textContent, failures: document.querySelectorAll('.modal-presentation-note').length,
      workbench: (window as any).dialogCraft.facts(), events }
  }
} })
