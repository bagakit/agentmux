// @vitest-environment happy-dom
import { act, createRef, useState } from 'react'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { renderToString } from 'react-dom/server'
import * as RawDialog from '@radix-ui/react-dialog'
import { Branch, Root as Layer } from '@radix-ui/react-dismissable-layer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Modal from '../src/components/Modal.js'

let root: ReactRoot, mount: HTMLDivElement, overlays: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount = document.createElement('div'); overlays = document.createElement('div')
  document.body.append(mount, overlays); root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  mount.remove(); overlays.remove(); vi.unstubAllGlobals()
})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function update(action: () => void) { await act(async () => { action(); await tick() }) }
function Attachment({ name = 'attached menu', fallback = overlays }: { name?: string; fallback?: HTMLElement }) {
  const target = Modal.useModalOverlayContainer(fallback)
  return target ? createPortal(<div role="menu" data-attached={name}>{name}</div>, target) : null
}
function Content({ name }: { name: string }) { return <><Modal.Title>{name}</Modal.Title><Modal.Description>Original {name}</Modal.Description></> }

describe('shared modal presentation ownership', () => {
  it('keeps dialog semantics on the real non-scrolling boundary and refs on the original painted form', async () => {
    const ref = createRef<HTMLDivElement>()
    await update(() => root.render(<Modal.Root open><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content asChild ref={ref} id="original-dialog" aria-label="Original request" tabIndex={-1}>
        <form aria-busy="true"><Content name="Original form" /><input defaultValue="Original draft" /></form>
      </Modal.Content>
    </Modal.Portal></Modal.Root>))
    const boundary = overlays.querySelector<HTMLElement>('[data-overlay-modal-boundary]')!, form = ref.current!
    expect(overlays.querySelector('[role="dialog"]')).toBe(boundary)
    expect(boundary.tabIndex).toBe(-1)
    expect(boundary.id).toBe('original-dialog')
    expect(boundary.getAttribute('aria-label')).toBe('Original request')
    expect(boundary.getAttribute('aria-busy')).toBe('true')
    expect(boundary.querySelector(`#${boundary.getAttribute('aria-labelledby')}`)?.textContent).toBe('Original form')
    expect(form.tagName).toBe('FORM')
    expect(form.hasAttribute('role')).toBe(false); expect(form.hasAttribute('id')).toBe(false)
    expect(form.hasAttribute('aria-busy')).toBe(false); expect(form.hasAttribute('tabindex')).toBe(false)
    expect(form.getAttribute('data-overlay-modal-part')).toBe('content')
    expect(form.getAttribute('data-state')).toBe('open')
    expect(boundary.querySelector('[data-overlay-modal-slot]')?.parentElement).toBe(boundary)
    expect(form.querySelector('[data-overlay-modal-slot]')).toBeNull()
  })

  it.each([true, false])('keeps IME Escape out of original dismissal effects while preserving modal=%s caller guards', async modal => {
    let busy = true
    const changed = vi.fn(), escaped = vi.fn((event: KeyboardEvent) => { if (busy) event.preventDefault() })
    const scene = () => <Modal.Root open modal={modal} onOpenChange={changed}><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content onEscapeKeyDown={escaped}><Content name="Original editor" /><input /></Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene()))
    const input = overlays.querySelector('input')!
    for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...marker })
      await update(() => input.dispatchEvent(event))
      expect(event.defaultPrevented).toBe(true)
    }
    expect(escaped).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
    await update(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(escaped).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled()
    busy = false; await update(() => root.render(scene()))
    await update(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(escaped).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('reacquires the retained Portal placement before a reopened child traps focus and closes only itself', async () => {
    const parentChanged = vi.fn(), childOpened = vi.fn()
    await update(() => root.render(<Modal.Root defaultOpen onOpenChange={parentChanged}>
      <Modal.Portal container={overlays}><Modal.Overlay /><Modal.Content><Content name="Original parent" />
        <Modal.Root><Modal.Trigger>Open original child</Modal.Trigger><Modal.Portal container={overlays}>
          <Modal.Overlay /><Modal.Content onOpenAutoFocus={childOpened}><Content name="Original child" /><Modal.Close>Close original child</Modal.Close></Modal.Content>
        </Modal.Portal></Modal.Root>
      </Modal.Content></Modal.Portal>
    </Modal.Root>))
    const parent = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    const trigger = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open original child')!
    await update(() => trigger.click())
    await update(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(overlays.querySelectorAll('[data-overlay-modal-scope]')).toHaveLength(1)
    await update(() => trigger.click())
    const child = [...overlays.querySelectorAll<HTMLElement>('[data-overlay-modal-scope]')].find(scope => scope !== parent)!
    expect(childOpened).toHaveBeenCalledTimes(2)
    expect(child.contains(document.activeElement)).toBe(true)
    const close = [...child.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Close original child')!
    await update(() => { close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); close.click() })
    expect(overlays.querySelectorAll('[data-overlay-modal-scope]')).toHaveLength(1)
    expect(overlays.querySelector('[data-overlay-modal-scope]')).toBe(parent)
    expect(parentChanged).not.toHaveBeenCalled()
    await update(() => {}) // Radix returns focus in its deferred unmount callback.
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps nested modals at the window root and their ordinary overlays in distinct non-scrolling slots', async () => {
    await update(() => root.render(<Modal.Root defaultOpen>
      <Modal.Portal container={overlays}><Modal.Overlay /><Modal.Content><Content name="Parent" />
        <Attachment name="parent" />
        <Modal.Root defaultOpen><Modal.Trigger>Child trigger</Modal.Trigger><Modal.Portal container={overlays}>
          <Modal.Overlay /><Modal.Content><Content name="Child" /><Attachment name="child" /></Modal.Content>
        </Modal.Portal></Modal.Root>
      </Modal.Content></Modal.Portal>
    </Modal.Root>))
    const scopes = [...overlays.querySelectorAll<HTMLElement>('[data-overlay-modal-scope]')]
    expect(scopes).toHaveLength(2)
    expect(scopes[0]!.parentElement?.parentElement).toBe(overlays); expect(scopes[1]!.parentElement?.parentElement).toBe(overlays)
    expect(new Set(scopes.map(scope => scope.id)).size).toBe(2)
    for (const [index, name] of ['parent', 'child'].entries()) {
      const scope = scopes[index]!, slot = scope.querySelector('[data-overlay-modal-slot]')!
      expect(scope.getAttribute('data-overlay-modal-scope')).toBe(scope.id)
      expect(scope.querySelector('[data-overlay-modal-part="scrim"]')?.getAttribute('data-overlay-modal-id')).toBe(scope.id)
      expect(scope.querySelector('[data-overlay-modal-part="content"]')?.getAttribute('data-overlay-modal-id')).toBe(scope.id)
      expect(scope.querySelector(`[data-attached="${name}"]`)?.parentElement).toBe(slot)
      expect(slot.closest('[data-overlay-modal-scope]')).toBe(scope)
      expect(slot.closest('[data-overlay-modal-part="content"]')).toBeNull()
      expect(slot.hasAttribute('data-overlay-modal-id')).toBe(false)
      expect(scope.querySelector('[data-overlay-modal-part="content"]')?.contains(slot)).toBe(false)
    }
  })

  it('preserves non-modal Radix behavior, forwarded refs and asChild while inheriting an existing modal slot', async () => {
    const ref = createRef<HTMLDivElement>(), pointer = vi.fn(), changed = vi.fn()
    await update(() => root.render(<Modal.Root defaultOpen><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Parent" />
        <Modal.Root defaultOpen modal={false} onOpenChange={changed}><Modal.Portal container={overlays}>
          <Modal.Overlay data-nonmodal-scrim="" /><Modal.Content asChild ref={ref} onPointerDown={pointer}>
            <section data-nonmodal-content=""><Content name="Nonmodal" /></section>
          </Modal.Content>
        </Modal.Portal></Modal.Root>
      </Modal.Content>
    </Modal.Portal></Modal.Root>))
    expect(overlays.querySelectorAll('[data-overlay-modal-scope]')).toHaveLength(1)
    expect(overlays.querySelector('[data-nonmodal-scrim]')).toBeNull()
    const content = overlays.querySelector<HTMLElement>('[data-nonmodal-content]')!
    expect(ref.current).toBe(content)
    expect(content.tagName).toBe('SECTION')
    expect(content.parentElement?.hasAttribute('data-overlay-modal-slot')).toBe(true)
    expect(content.closest('[aria-hidden="true"]')).toBeNull()
    expect(content.hasAttribute('data-overlay-modal-id')).toBe(false)
    expect(content.hasAttribute('data-overlay-modal-part')).toBe(false)
    await update(() => {}) // Radix installs outside-interaction listeners after the opening event.
    await update(() => content.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(pointer).toHaveBeenCalledOnce()
    // This is outside the nonmodal child, but still inside its healthy parent modal.
    const parentTitle = overlays.querySelector('h2')!
    await update(() => { parentTitle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); parentTitle.click() })
    expect(changed).toHaveBeenCalledWith(false)
    expect(overlays.querySelector('[data-nonmodal-content]')).toBeNull()
    expect(overlays.querySelector('[data-overlay-modal-scope]')?.hasAttribute('hidden')).toBe(false)
  })

  it('pauses failed presentation without canceling the original request and gives retry a new presentation attempt', async () => {
    const changed = vi.fn(), confirmed = vi.fn()
    function OriginalRequest() {
      const [draft, setDraft] = useState('Original request')
      return <><input aria-label="Preserved request" value={draft} onChange={event => setDraft(event.target.value)} />
        <Modal.Root open onOpenChange={changed}><Modal.Trigger>Original dialog trigger</Modal.Trigger><Modal.Portal container={overlays}>
          <Modal.Overlay /><Modal.Content forceMount><Content name="Original confirmation" /><LocalForm />
            <button type="button" onClick={confirmed}>Confirm original operation</button>
          </Modal.Content>
        </Modal.Portal></Modal.Root></>
    }
    function LocalForm() { const [draft, setDraft] = useState('Original local draft'); return <><input aria-label="Local controlled draft" value={draft} onChange={event => setDraft(event.target.value)} /><input aria-label="Local uncontrolled draft" defaultValue="Original uncontrolled draft" /></> }
    await update(() => root.render(<OriginalRequest />))
    const input = mount.querySelector('input')!, originalScope = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!, id = originalScope.id
    const local = overlays.querySelector<HTMLInputElement>('[aria-label="Local uncontrolled draft"]')!
    local.value = 'Edited original unsent draft'; local.setSelectionRange(3, 12)
    expect(document.body.style.pointerEvents).toBe('none')
    await update(() => originalScope.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Native chrome capture failed.' } })))
    expect(overlays.querySelector('[data-overlay-modal-scope]')?.hasAttribute('hidden')).toBe(true)
    expect(overlays.querySelector('[role="dialog"]')?.getAttribute('data-state')).toBe('closed')
    expect(overlays.querySelector('[aria-label="Local uncontrolled draft"]')).toBe(local)
    expect(local.value).toBe('Edited original unsent draft')
    expect([local.selectionStart, local.selectionEnd]).toEqual([3, 12])
    expect(mount.querySelector('[aria-haspopup="dialog"]')?.getAttribute('aria-expanded')).toBe('false')
    const note = overlays.querySelector<HTMLElement>('[role="status"]')!
    expect(note.textContent).toContain('Native chrome capture failed.')
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(mount.querySelector('input')).toBe(input)
    expect(input.value).toBe('Original request')
    expect(changed).not.toHaveBeenCalled(); expect(confirmed).not.toHaveBeenCalled()
    await update(() => [...note.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click())
    expect(overlays.querySelector('[data-overlay-modal-scope]')?.id).not.toBe(id)
    expect(overlays.querySelector('[role="dialog"]')).not.toBeNull()
    expect(overlays.querySelector('[aria-label="Local uncontrolled draft"]')).toBe(local)
    expect(local.value).toBe('Edited original unsent draft')
    expect([local.selectionStart, local.selectionEnd]).toEqual([3, 12])
    expect(mount.querySelector('[aria-haspopup="dialog"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(changed).not.toHaveBeenCalled(); expect(confirmed).not.toHaveBeenCalled()
    const reopened = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    const reopenedId = reopened.id
    expect(overlays.ownerDocument.getElementById(id)).toBeNull()
    await update(() => overlays.ownerDocument.getElementById(id)?.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Late receipt for an old presentation.' } })))
    expect(overlays.querySelector('[data-overlay-modal-scope]')).toBe(reopened)
    expect(overlays.querySelector('[role="status"]')).toBeNull()
    await update(() => reopened.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Still unavailable.' } })))
    await update(() => mount.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click())
    const triggered = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    expect(triggered.id).not.toBe(reopenedId)
    expect(changed).not.toHaveBeenCalled()
    await update(() => triggered.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Still unavailable after trigger retry.' } })))
    await update(() => [...overlays.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Cancel')!.click())
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    expect(confirmed).not.toHaveBeenCalled()
  })

  it('does not allocate portal DOM for unopened requests and preserves the original server-safe API', async () => {
    const scene = (open: boolean) => <Modal.Root open={open}><Modal.Portal container={overlays}><Modal.Overlay /><Modal.Content><Content name="Lazy original" /></Modal.Content></Modal.Portal></Modal.Root>
    await update(() => root.render(scene(false))); expect(overlays.childElementCount).toBe(0)
    await update(() => root.render(scene(true))); expect(overlays.querySelectorAll('[data-overlay-modal-host]')).toHaveLength(1)
    await update(() => root.render(scene(false))); expect(overlays.childElementCount).toBe(0)
    const originalDocument = document, originalWindow = window
    try {
      vi.stubGlobal('document', undefined); vi.stubGlobal('window', undefined)
      expect(() => renderToString(<Modal.Root open><Modal.Portal><Modal.Overlay /><Modal.Content>Server request</Modal.Content></Modal.Portal></Modal.Root>)).not.toThrow()
      expect(() => renderToString(<RawDialog.Root open><RawDialog.Content forceMount>Original raw server content</RawDialog.Content></RawDialog.Root>)).not.toThrow()
    } finally { vi.stubGlobal('document', originalDocument); vi.stubGlobal('window', originalWindow) }
  })

  it('moves the same draft and input A to B to A while rebinding the only behavior lease to its actual document', async () => {
    const frame = document.createElement('iframe'); document.body.append(frame)
    const child = frame.contentDocument!, childRoot = child.createElement('div'), outside = child.createElement('input'); child.body.append(childRoot, outside)
    const changed = vi.fn(), opened = vi.fn(), closed = vi.fn((event: Event) => event.preventDefault())
    function LocalForm() { const [draft, setDraft] = useState('Original form'); return <><button onClick={() => setDraft('Edited form')}>Edit local form</button><output>{draft}</output><input aria-label="Unsent transfer draft" defaultValue="Original unsent draft" /></> }
    const scene = (container: HTMLElement) => <Modal.Root open onOpenChange={changed}><Modal.Portal container={container}><Modal.Overlay /><Modal.Content onOpenAutoFocus={opened} onCloseAutoFocus={closed}><Content name="Moved request" /><LocalForm /></Modal.Content></Modal.Portal></Modal.Root>
    try {
      await update(() => root.render(scene(overlays)))
      const input = overlays.querySelector<HTMLInputElement>('input')!, originalScope = input.closest('[data-overlay-modal-scope]')!
      input.value = 'Edited unsent draft'; input.setSelectionRange(2, 7)
      await update(() => overlays.querySelector<HTMLButtonElement>('button')!.click())
      await update(() => input.focus())
      for (const container of [childRoot, overlays]) {
        input.setSelectionRange(2, 7)
        await update(() => root.render(scene(container))); await update(() => {})
        expect(container.querySelector('input')).toBe(input); expect(input.ownerDocument).toBe(container.ownerDocument)
        expect(input.value).toBe('Edited unsent draft'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]); expect(container.querySelector('output')?.textContent).toBe('Edited form')
        expect(input.closest('[data-overlay-modal-scope]')).toBe(originalScope)
        expect(container.ownerDocument.body.style.pointerEvents).toBe('none')
        const previousDocument = container === childRoot ? document : child
        expect(previousDocument.body.style.pointerEvents).toBe('')
        const target = container === childRoot ? outside : mount.appendChild(document.createElement('input'))
        await update(() => input.focus()); await update(() => target.focus())
        expect(container.ownerDocument.activeElement).toBe(input)
        await update(() => previousDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
        expect(changed).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(opened).toHaveBeenCalledOnce()
      }
    } finally { await update(() => root.render(null)); frame.remove() }
  })

  it('keeps focus, body locks, Escape and backdrop input independent between two actual documents', async () => {
    const frame = document.createElement('iframe'), outside = document.createElement('input'); document.body.append(frame, outside)
    const child = frame.contentDocument!, childRoot = child.createElement('div'); child.body.append(childRoot)
    const changedA = vi.fn(), changedB = vi.fn()
    try {
      await update(() => root.render(<><Modal.Root open onOpenChange={changedA}><Modal.Portal container={overlays}><Modal.Overlay data-scrim-a="" /><Modal.Content><Content name="Document A" /><input aria-label="Inside A" /></Modal.Content></Modal.Portal></Modal.Root><Modal.Root open onOpenChange={changedB}><Modal.Portal container={childRoot}><Modal.Overlay /><Modal.Content><Content name="Document B" /><input aria-label="Inside B" /></Modal.Content></Modal.Portal></Modal.Root></>))
      await update(() => {})
      const input = overlays.querySelector<HTMLInputElement>('[aria-label="Inside A"]')!
      await update(() => input.focus()); await update(() => outside.focus())
      expect(document.activeElement).toBe(input); expect(child.body.style.pointerEvents).toBe('none')
      await update(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
      expect(changedA).toHaveBeenCalledOnce(); expect(changedB).not.toHaveBeenCalled(); changedA.mockClear()
      const scrim = overlays.querySelector<HTMLElement>('[data-scrim-a]')!
      await update(() => { scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); scrim.click() })
      expect(changedA).toHaveBeenCalledOnce(); expect(changedB).not.toHaveBeenCalled()
    } finally { await update(() => root.render(null)); frame.remove(); outside.remove() }
  })

  it('rebinds the original Radix branch when its same portal DOM is adopted into another document', async () => {
    const frame = document.createElement('iframe'), branchHost = document.createElement('div'); document.body.append(frame, branchHost)
    const child = frame.contentDocument!, childRoot = child.createElement('div'); child.body.append(childRoot)
    const changed = vi.fn()
    const scene = (revision: number) => <>{createPortal(<Layer onDismiss={changed}>Original independent layer</Layer>, childRoot)}{createPortal(<Branch data-branch-revision={revision}><button>Independent reading attachment</button></Branch>, branchHost)}</>
    try {
      await update(() => root.render(scene(0))); await update(() => {})
      const original = branchHost.querySelector('button')!
      await update(() => { child.body.appendChild(branchHost); root.render(scene(1)) })
      expect(branchHost.querySelector('button')).toBe(original); expect(original.ownerDocument).toBe(child)
      await update(() => { original.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); original.click() })
      expect(changed).not.toHaveBeenCalled()
    } finally { await update(() => root.render(null)); frame.remove(); branchHost.remove() }
  })

  it('keeps scope, attachments and recovery in the actual supplied document', async () => {
    const child = document.implementation.createHTMLDocument('Original child window')
    const childRoot = child.createElement('div'); child.body.append(childRoot)
    await update(() => root.render(<Modal.Root defaultOpen><Modal.Portal container={childRoot}>
      <Modal.Overlay /><Modal.Content><Content name="Child window" /><Attachment name="child-document" fallback={overlays} /></Modal.Content>
    </Modal.Portal></Modal.Root>))
    const scope = childRoot.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    expect(scope.ownerDocument).toBe(child)
    expect(scope.querySelector('[data-attached]')?.ownerDocument).toBe(child)
    expect(overlays.querySelector('[data-attached]')).toBeNull()
    await update(() => scope.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Original window capture failed.' } })))
    expect(childRoot.querySelector('[role="status"]')?.textContent).toContain('Original window capture failed.')
    expect(overlays.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps an open attempt stable through rerenders and rejects receipts from a closed attempt', async () => {
    const changed = vi.fn()
    const scene = (open: boolean, label: string) => <Modal.Root open={open} onOpenChange={changed}><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name={label} /></Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(true, 'Original request')))
    const original = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!, id = original.id
    await update(() => root.render(scene(true, 'Same request updated')))
    expect(overlays.querySelector('[data-overlay-modal-scope]')?.id).toBe(id)
    await update(() => root.render(scene(false, 'Closed request')))
    expect(overlays.querySelector('[data-overlay-modal-scope]')).toBeNull()
    await update(() => root.render(scene(true, 'Next opening')))
    const next = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    expect(next.id).not.toBe(id)
    expect(overlays.ownerDocument.getElementById(id)).toBeNull()
    await update(() => original.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Late closed receipt' } })))
    expect(overlays.querySelector('[data-overlay-modal-scope]')).toBe(next)
    expect(overlays.querySelector('[role="status"]')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps force-mounted closed scopes hidden and without attached floating consumers', async () => {
    const scene = (open: boolean) => <Modal.Root open={open}><Modal.Portal forceMount container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Mounted editor" /><Attachment /></Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(true)))
    expect(overlays.querySelector('[data-attached]')).not.toBeNull()
    await update(() => root.render(scene(false)))
    const scope = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    expect(scope).not.toBeNull()
    expect(scope.hidden).toBe(true)
    expect(scope.querySelector('[data-overlay-modal-slot]')).toBeNull()
    expect(scope.querySelector('[data-attached]')).toBeNull()
    expect(document.body.style.pointerEvents).not.toBe('none')
    await update(() => root.render(scene(true)))
    const reopened = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    expect(reopened.hidden).toBe(false)
    expect(reopened.querySelector('[data-attached]')?.parentElement?.hasAttribute('data-overlay-modal-slot')).toBe(true)
  })

  it('does not let a newly mounted closed forceMount scope pause an already active modal', async () => {
    const scene = (showClosed: boolean) => <><input data-outside="" /><Modal.Root open><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Active modal" /><input data-active-modal="" /></Modal.Content>
    </Modal.Portal></Modal.Root>{showClosed ? <Modal.Root open={false}><Modal.Portal forceMount container={overlays}>
      <Modal.Overlay /><Modal.Content onOpenAutoFocus={event => event.preventDefault()}><Content name="Closed forceMount" /></Modal.Content>
    </Modal.Portal></Modal.Root> : null}</>
    await update(() => root.render(scene(false)))
    const active = overlays.querySelector<HTMLInputElement>('[data-active-modal]')!
    await update(() => active.focus())
    await update(() => root.render(scene(true)))
    await update(() => active.focus())
    await update(() => mount.querySelector<HTMLInputElement>('[data-outside]')!.focus())
    expect(document.activeElement).toBe(active)
  })

  it('keeps a child recovery note in the healthy parent scope and preserves an admitted child when the parent fails', async () => {
    await update(() => root.render(<Modal.Root open><Modal.Portal container={overlays}><Modal.Overlay /><Modal.Content>
      <Content name="Parent request" /><input data-parent-draft="" defaultValue="Parent original draft" />
      <Modal.Root defaultOpen><Modal.Portal container={overlays}><Modal.Overlay /><Modal.Content>
        <Content name="Child request" /><input data-child-draft="" defaultValue="Child original draft" /><Modal.Close>Close child</Modal.Close>
      </Modal.Content></Modal.Portal></Modal.Root>
    </Modal.Content></Modal.Portal></Modal.Root>))
    const [parent, child] = [...overlays.querySelectorAll<HTMLElement>('[data-overlay-modal-scope]')]
    const childDraft = child!.querySelector<HTMLInputElement>('[data-child-draft]')!
    childDraft.value = 'Edited child draft'
    await update(() => child!.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Child capture failed' } })))
    expect(parent!.querySelector('[role="status"]')?.parentElement?.hasAttribute('data-overlay-modal-slot')).toBe(true)
    await update(() => {
      const retry = [...parent!.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Retry')!
      retry.focus(); retry.click()
    })
    expect(child!.querySelector('[data-child-draft]')).toBe(childDraft)
    expect(childDraft.value).toBe('Edited child draft')
    expect(child!.hidden).toBe(false)
    await update(() => parent!.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Parent capture failed' } })))
    expect(child!.isConnected).toBe(true)
    expect(child!.hidden).toBe(false)
    expect(child!.querySelector('[data-child-draft]')).toBe(childDraft)
    expect(childDraft.value).toBe('Edited child draft')
    const outside = document.createElement('input'); document.body.append(outside)
    try {
      await update(() => childDraft.focus())
      await update(() => outside.focus())
      expect(document.activeElement).toBe(childDraft)
    } finally { outside.remove() }
    await update(() => [...child!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Close child')!.click())
    expect(overlays.querySelector('[data-child-draft]')).toBeNull()
    await update(() => [...overlays.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Retry')!.click())
    expect(parent!.hidden).toBe(false)
    expect(overlays.querySelector('[data-child-draft]')).toBeNull()
  })

  it('reports only exact owning slot retirement while the retained target is still connected', async () => {
    const target = createRef<HTMLDivElement>(), retired = vi.fn(() => expect(target.current?.isConnected).toBe(true))
    await update(() => root.render(<Modal.Root open><Modal.Portal forceMount container={overlays}><Modal.Overlay /><Modal.Content>
      <Content name="Retained source" /><div ref={target}>Original native popover target</div>
      <Modal.ModalAttachmentDismissal active targetRef={target} onEscapeKeyDown={event => event.preventDefault()} onOwnerRemoved={retired} />
    </Modal.Content></Modal.Portal></Modal.Root>))
    await update(() => target.current!.dispatchEvent(new CustomEvent(Modal.MODAL_OVERLAY_SLOT_REMOVED, { bubbles: true })))
    expect(retired).not.toHaveBeenCalled()
    await update(() => overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Original native paint failed' } })))
    expect(retired).toHaveBeenCalledOnce(); expect(target.current?.isConnected).toBe(true)
  })

  it('lets an exact attached retained target own Escape and releases that ownership on detach', async () => {
    const changed = vi.fn(), escaped = vi.fn((event: KeyboardEvent) => event.preventDefault()), target = createRef<HTMLDivElement>()
    const scene = (attached: boolean) => <Modal.Root open onOpenChange={changed}><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Original modal" /><div ref={target}><input data-retained-attachment="" defaultValue="Original draft" /></div>
        <Modal.ModalAttachmentDismissal active={attached} targetRef={target} onEscapeKeyDown={escaped} />
      </Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(false)))
    const original = target.current!, input = original.querySelector('input')!
    await update(() => root.render(scene(true)))
    expect(target.current).toBe(original)
    for (const marker of [{ isComposing: true }, { keyCode: 229 }]) {
      await update(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...marker })))
    }
    expect(escaped).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
    await update(() => { input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(escaped).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled()
    await update(() => root.render(scene(false)))
    expect(target.current).toBe(original); expect(original.querySelector('input')).toBe(input)
    await update(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(changed).toHaveBeenCalledExactlyOnceWith(false); expect(escaped).toHaveBeenCalledOnce()
  })

  it('puts a reopened retained modal after newer siblings while keeping its original draft DOM', async () => {
    const scene = (a: boolean, b: boolean) => <><input data-background="" /><Modal.Root open={a}><Modal.Portal forceMount container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Retained A" /><input data-retained-a="" defaultValue="Original draft" /></Modal.Content>
    </Modal.Portal></Modal.Root><Modal.Root open={b}><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Later B" /><input data-later-b="" /></Modal.Content>
    </Modal.Portal></Modal.Root></>
    await update(() => root.render(scene(true, false)))
    const original = overlays.querySelector<HTMLInputElement>('[data-retained-a]')!, scope = original.closest<HTMLElement>('[data-overlay-modal-scope]')!
    original.value = 'Retained edited draft'; original.setSelectionRange(2, 7)
    await update(() => root.render(scene(false, false)))
    await update(() => root.render(scene(false, true)))
    expect(overlays.lastElementChild).not.toBe(scope.parentElement)
    await update(() => root.render(scene(true, true)))
    expect(overlays.lastElementChild).toBe(scope.parentElement)
    expect(scope.querySelector('[data-retained-a]')).toBe(original); expect(original.value).toBe('Retained edited draft')
    expect(document.activeElement).toBe(original)
    await update(() => mount.querySelector<HTMLInputElement>('[data-background]')!.focus())
    expect(document.activeElement).toBe(original)
  })

  it('runs the original close autofocus when an open-literal dialog is conditionally removed', async () => {
    const closed = vi.fn((event: Event) => event.preventDefault())
    function Scene() { const [show, setShow] = useState(true); return show ? <Modal.Root open><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content onCloseAutoFocus={closed}><Content name="Conditional original" /><button onClick={() => setShow(false)}>Close original</button></Modal.Content>
    </Modal.Portal></Modal.Root> : null }
    await update(() => root.render(<Scene />))
    await update(() => overlays.querySelector<HTMLButtonElement>('button')!.click())
    await update(() => {})
    expect(overlays.querySelector('[role="dialog"]')).toBeNull()
    expect(closed).toHaveBeenCalledOnce()
  })

  it('returns inline nonmodal focus through its original close callback after the visual ref retires', async () => {
    const closed = vi.fn((event: Event) => { event.preventDefault(); opener.focus() })
    function Scene() {
      const [open, setOpen] = useState(false)
      return <Modal.Root modal={false} open={open} onOpenChange={setOpen}>
        <button data-inline-opener="" onClick={() => setOpen(true)}>Open inline drawer</button>
        <Modal.Content onCloseAutoFocus={closed}><Content name="Inline original" /><button>Drawer action</button></Modal.Content>
      </Modal.Root>
    }
    await update(() => root.render(<Scene />))
    const opener = mount.querySelector<HTMLButtonElement>('[data-inline-opener]')!
    await update(() => { opener.focus(); opener.click() })
    const drawer = mount.querySelector<HTMLElement>('[role="dialog"]')!
    expect(drawer).not.toBeNull(); expect(drawer.contains(document.activeElement)).toBe(true)
    await update(() => drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await update(() => {})
    expect(mount.querySelector('[role="dialog"]')).toBeNull()
    expect(closed).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(opener)
  })

  it('uses the original caller busy fact only to present unavailable recovery cancellation', async () => {
    const changed = vi.fn(), operation = vi.fn()
    const scene = (busy: boolean) => <Modal.Root open onOpenChange={changed} recoveryCloseDisabled={busy}><Modal.Portal container={overlays}>
      <Modal.Overlay /><Modal.Content><Content name="Running request" /><button onClick={operation}>Submit operation</button></Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(true)))
    const fail = () => overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Capture failed' } }))
    await update(fail)
    const cancel = [...overlays.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Cancel')!
    expect(cancel.disabled).toBe(true)
    await update(() => cancel.click())
    expect(changed).not.toHaveBeenCalled()
    await update(() => overlays.querySelector<HTMLButtonElement>('[role="status"] button')!.click())
    expect(operation).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled()
    await update(fail)
    await update(() => root.render(scene(false)))
    const availableCancel = [...overlays.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Cancel')!
    expect(availableCancel.disabled).toBe(false)
    await update(() => availableCancel.click())
    expect(changed).toHaveBeenCalledExactlyOnceWith(false); expect(operation).not.toHaveBeenCalled()
  })

  it('keeps autofocus callbacks on the actual content and suppresses failure-only close effects', async () => {
    const opened = vi.fn((event: Event) => event.preventDefault()), closed = vi.fn((event: Event) => event.preventDefault())
    const scene = (open: boolean) => <Modal.Root open={open}><Modal.Portal container={overlays}><Modal.Overlay />
      <Modal.Content onOpenAutoFocus={opened} onCloseAutoFocus={closed}><Content name="Focus callbacks" /><input /></Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(true)))
    const actual = overlays.querySelector('[data-overlay-modal-part="content"]')!
    expect(opened).toHaveBeenCalledOnce(); expect(opened.mock.calls[0]![0].target).toBe(actual)
    await update(() => overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Capture failed' } })))
    await update(() => {})
    expect(closed).not.toHaveBeenCalled()
    await update(() => {
      const retry = overlays.querySelector<HTMLButtonElement>('[role="status"] button')!
      retry.focus(); retry.click()
    })
    expect(opened).toHaveBeenCalledTimes(2); expect(opened.mock.calls[1]![0].target).toBe(actual)
    await update(() => root.render(scene(false)))
    await update(() => {})
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0].target).toBe(actual)
  })

  it('preserves asChild DOM, refs, local state and current handlers through failure and dynamic props', async () => {
    const ref = createRef<HTMLDivElement>(), first = vi.fn(), second = vi.fn(), childPointer = vi.fn()
    function LocalForm() { const [draft, setDraft] = useState('Original form draft'); return <input data-form-draft="" value={draft} onChange={event => setDraft(event.target.value)} /> }
    const scene = (next: boolean) => <Modal.Root open><Modal.Portal container={overlays}><Modal.Overlay />
      <Modal.Content asChild ref={ref} className={next ? 'current-form' : 'original-form'} onPointerDown={next ? second : first}>
        <form className="child-form" onPointerDown={childPointer} onSubmit={event => event.preventDefault()}><Content name="Form request" /><LocalForm /></form>
      </Modal.Content>
    </Modal.Portal></Modal.Root>
    await update(() => root.render(scene(false)))
    const form = ref.current!, input = form.querySelector<HTMLInputElement>('[data-form-draft]')!
    expect(form.tagName).toBe('FORM')
    await update(() => root.render(scene(true)))
    expect(ref.current).toBe(form); expect(form.className).toBe('current-form child-form')
    await update(() => form.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(second).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); expect(childPointer).toHaveBeenCalledOnce()
    const scope = overlays.querySelector<HTMLElement>('[data-overlay-modal-scope]')!
    await update(() => scope.dispatchEvent(new CustomEvent(Modal.MODAL_PRESENTATION_FAILURE_EVENT, { detail: { message: 'Form capture failed' } })))
    expect(ref.current).toBe(form); expect(form.querySelector('[data-form-draft]')).toBe(input)
    await update(() => [...overlays.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Retry')!.click())
    expect(ref.current).toBe(form); expect(form.querySelector('[data-form-draft]')).toBe(input)
    expect(input.value).toBe('Original form draft')
  })
})
