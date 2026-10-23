import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Root as DismissableLayer, Branch as DismissableLayerBranch } from '@radix-ui/react-dismissable-layer'
import { Children, cloneElement, createContext, forwardRef, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentPropsWithoutRef, type HTMLAttributes, type ReactElement, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useClientUiOwnerDocument } from '../platform.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'

export * from '@radix-ui/react-dialog'

export const MODAL_PRESENTATION_FAILURE_EVENT = 'agentmux:modal-presentation-failed'
export const MODAL_OVERLAY_SLOT_REMOVED = 'agentmux:modal-overlay-slot-removed'

type ModalContextValue = {
  id: string
  modal: boolean
  requestedOpen: boolean
  failure: string | null
  recoveryCloseDisabled: boolean
  fail(message: string): void
  retry(): void
  changeOpen(open: boolean): void
}
const ModalContext = createContext<ModalContextValue | null>(null)
const ModalAttachmentContext = createContext<{ container: HTMLElement | null; ready: boolean } | null>(null)
const ModalPortalMountContext = createContext(false)
const ModalBoundaryContext = createContext<{ document: Document; ready: boolean; boundary: HTMLDivElement | null; scrimHost: HTMLDivElement | null; publish(props: HTMLAttributes<HTMLDivElement>): void } | null>(null)

/** A global reader follows only the scope that physically contains its original anchor. */
export function getModalOverlayContainer(anchor: Element): HTMLElement | null {
  const scope = anchor.closest('[data-overlay-modal-scope]')
  if (!scope || scope.hasAttribute('hidden')) return null
  const slot = scope.querySelector<HTMLElement>('[data-overlay-modal-slot]')
  return slot?.isConnected ? slot : null
}

/** Ordinary tooltips and menus follow their original modal without entering its scrolling content. */
export function useModalOverlayContainer<T extends Element | DocumentFragment | null | undefined>(fallback: T): HTMLElement | T | null {
  const attachment = useContext(ModalAttachmentContext)
  return attachment ? attachment.ready ? attachment.container : null : fallback
}

/** A retained attachment owns Escape and observes its exact scope's retirement without replacing DOM.
 * This does not add a focus scope or pointer/focus capture behavior; those remain with the consumer.
 */
export function ModalAttachmentDismissal({ active, targetRef, onEscapeKeyDown, onOwnerRemoved }: {
  active: boolean
  targetRef: RefObject<HTMLElement | null>
  onEscapeKeyDown: NonNullable<ComponentProps<typeof DismissableLayer>['onEscapeKeyDown']>
  onOwnerRemoved?(): void
}) {
  const attachment = useContext(ModalAttachmentContext)
  useLayoutEffect(() => {
    const slot = active && targetRef.current ? getModalOverlayContainer(targetRef.current) : null
    if (!slot || !onOwnerRemoved) return
    const departed = (event: Event) => { if (event.target === slot) onOwnerRemoved() }
    slot.addEventListener(MODAL_OVERLAY_SLOT_REMOVED, departed)
    return () => slot.removeEventListener(MODAL_OVERLAY_SLOT_REMOVED, departed)
  }, [active, targetRef, onOwnerRemoved, attachment?.container, attachment?.ready])
  return active ? <DismissableLayer asChild onEscapeKeyDown={event => handleModalEscape(event, onEscapeKeyDown)}><AttachmentTarget targetRef={targetRef} /></DismissableLayer> : null
}
const AttachmentTarget = forwardRef<HTMLDivElement, { targetRef: RefObject<HTMLElement | null> }>(function AttachmentTarget({ targetRef }, ref) {
  useImperativeHandle(ref, () => targetRef.current as HTMLDivElement, [targetRef])
  return null
})

/** Radix retains focus, dismissal and keyboard ownership; presentation failure does not cancel the request. */
export function ModalRoot({ open, defaultOpen = false, onOpenChange, modal = true, recoveryCloseDisabled = false, children, ...props }: ComponentProps<typeof DialogPrimitive.Root> & { recoveryCloseDisabled?: boolean }) {
  const identity = useId()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const [failure, setFailure] = useState<string | null>(null)
  const requestedOpen = open ?? localOpen
  const [attempt, setAttempt] = useState({ open: requestedOpen, generation: 0 })
  if (attempt.open !== requestedOpen) setAttempt({ open: requestedOpen, generation: attempt.generation + (requestedOpen ? 1 : 0) })
  const id = `amux-modal-${identity}-${attempt.generation}`
  useLayoutEffect(() => { if (!requestedOpen) setFailure(null) }, [requestedOpen])
  const changeOpen = useCallback((next: boolean) => {
    if (next) {
      if (failure !== null) setAttempt(previous => ({ ...previous, generation: previous.generation + 1 }))
      setFailure(null)
    }
    if (open === undefined) setLocalOpen(next)
    if (next !== requestedOpen) onOpenChange?.(next)
  }, [open, onOpenChange, requestedOpen, failure])
  const fail = useCallback((message: string) => { if (modal && requestedOpen) setFailure(message) }, [modal, requestedOpen])
  const retry = useCallback(() => { setAttempt(previous => ({ ...previous, generation: previous.generation + 1 })); setFailure(null) }, [])
  const value = useMemo(() => ({ id, modal, requestedOpen, failure, recoveryCloseDisabled, fail, retry, changeOpen }), [id, modal, requestedOpen, failure, recoveryCloseDisabled, fail, retry, changeOpen])
  return <ModalContext.Provider value={value}>
    <DialogPrimitive.Root {...props} modal={modal} open={requestedOpen && failure === null} onOpenChange={changeOpen}>{children}</DialogPrimitive.Root>
  </ModalContext.Provider>
}

/** Each actual modal enters its explicit window root as a sibling of earlier modals. */
export function ModalPortal({ container, children, ...props }: ComponentProps<typeof DialogPrimitive.Portal>) {
  const context = useContext(ModalContext)
  const parentAttachment = useContext(ModalAttachmentContext)
  const [admitted, setAdmitted] = useState(parentAttachment === null)
  const inheritedContainer = useModalOverlayContainer(container)
  const presentationDocument = useClientUiOwnerDocument()
  const ownerDocument = container?.ownerDocument ?? presentationDocument ?? globalThis.document
  const windowContainer = container ?? ownerDocument?.body
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [placement, setPlacement] = useState<{ host: HTMLElement; container: Element | DocumentFragment; document: Document } | null>(null)
  const placed = host !== null && placement?.host === host && placement.container === windowContainer && placement.document === ownerDocument && host.ownerDocument === ownerDocument && host.parentNode === windowContainer
  const mounted = context?.modal && (context.requestedOpen || props.forceMount === true)
  if (mounted && !host && ownerDocument) {
    const node = ownerDocument.createElement('div')
    node.style.display = 'contents'; node.dataset.overlayModalHost = ''
    setHost(node)
  }
  useLayoutEffect(() => {
    if (!host) return
    // A detached retained host has no placement receipt, even if it reopens into
    // the same container. The next attachment must reactivate its behavior lease.
    if (!mounted || !windowContainer) { host.remove(); setPlacement(null); return }
    if (host.parentNode !== windowContainer) moveModalHost(host, windowContainer)
    setPlacement(previous => previous?.host === host && previous.container === windowContainer && previous.document === ownerDocument ? previous : { host, container: windowContainer, document: ownerDocument })
  }, [host, mounted, windowContainer, ownerDocument])
  useLayoutEffect(() => () => host?.remove(), [host])
  useLayoutEffect(() => { if (!parentAttachment || parentAttachment.ready) setAdmitted(true) }, [parentAttachment])
  if (!admitted && parentAttachment && !parentAttachment.ready) return null
  if (!context?.modal) return parentAttachment && !inheritedContainer ? null : <DialogPrimitive.Portal {...props} container={inheritedContainer ?? windowContainer}>{children}</DialogPrimitive.Portal>
  const failed = context.requestedOpen && context.failure !== null
  if (!host) return null
  return <>
    <ModalPortalMountContext.Provider value={props.forceMount === true || failed}>
      <DialogPrimitive.Portal {...props} {...(failed ? { forceMount: true } : {})} container={host}>
        <ModalScope context={context} document={ownerDocument} placed={placed}>{children}</ModalScope>
      </DialogPrimitive.Portal>
    </ModalPortalMountContext.Provider>
    {failed && windowContainer ? createPortal(<aside className="modal-presentation-note" role="status" data-state="open">
      <strong>Dialog could not be displayed</strong><p>{context.failure}</p>
      <p>Your original request is kept. The workface remains available.</p>
      {context.recoveryCloseDisabled ? <p>Closing is unavailable while the current action is running.</p> : null}
      <div><button type="button" onClick={context.retry}>Retry</button><button type="button" disabled={context.recoveryCloseDisabled} onClick={() => context.changeOpen(false)}>Cancel</button></div>
    </aside>, parentAttachment?.ready && parentAttachment.container ? parentAttachment.container : windowContainer) : null}
  </>
}

/** A real, non-scrolling dialog boundary owns focus/ARIA and includes attached controls.
 * The original Content remains the painted, independently scrolling surface.
 */
const ModalScope = forwardRef<HTMLDivElement, { context: ModalContextValue; document: Document; placed: boolean; children?: ComponentProps<typeof DialogPrimitive.Portal>['children'] }>(function ModalScope({ context, document, placed, children }, forwardedRef) {
  const [scope, setScope] = useState<HTMLDivElement | null>(null)
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null)
  const [scrimHost, setScrimHost] = useState<HTMLDivElement | null>(null)
  const [behavior, setBehavior] = useState<HTMLAttributes<HTMLDivElement>>({})
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [readyScope, setReadyScope] = useState<{ scope: HTMLDivElement; attempt: string; document: Document } | null>(null)
  const visible = context.requestedOpen && context.failure === null
  const ready = visible && placed && scope !== null && scope.ownerDocument === document && readyScope?.scope === scope && readyScope.attempt === context.id && readyScope.document === document
  const attachment = useMemo(() => ({ container: slot, ready: ready && slot !== null }), [slot, ready])
  const attachScope = useCallback((node: HTMLDivElement | null) => {
    setScope(node)
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])
  const attachSlot = useCallback((node: HTMLDivElement | null) => {
    setSlot(node)
    if (!node) return
    return () => {
      const Event = node.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
      node.dispatchEvent(new Event(MODAL_OVERLAY_SLOT_REMOVED))
      setSlot(null)
    }
  }, [])
  useLayoutEffect(() => {
    // Reopening a retained scope is a new presentation. DOM order and Radix's newest
    // focus owner must agree without remounting the original content or adding ranks.
    if (scope && visible && placed) moveModalScopeToFront(scope)
  }, [scope, context.id, visible, placed])
  // Radix first hides the rest of the document from accessibility. Attach this modal's
  // own non-scrolling slot afterwards; later nested modals then mount above this scope.
  useEffect(() => {
    if (!scope || !visible || !placed) return
    setReadyScope({ scope, attempt: context.id, document })
  }, [scope, context.id, visible, placed, document])
  useLayoutEffect(() => {
    const node = scope
    if (!node || !visible) return
    const failed = (event: Event) => {
      if (event.target !== node) return
      const detail = (event as CustomEvent<{ message?: unknown }>).detail
      context.fail(typeof detail?.message === 'string' && detail.message ? detail.message : 'The dialog could not be displayed.')
    }
    node.addEventListener(MODAL_PRESENTATION_FAILURE_EVENT, failed)
    return () => node.removeEventListener(MODAL_PRESENTATION_FAILURE_EVENT, failed)
  }, [context, scope, visible])
  const owner = useMemo(() => ({ document, ready: placed, boundary, scrimHost, publish: setBehavior }), [document, placed, boundary, scrimHost])
  const events = Object.fromEntries(Object.entries(behavior).filter(([name, value]) => /^on[A-Z]/.test(name) && typeof value === 'function').map(([name, handler]) => [name, (event: { target: EventTarget | null }) => {
    if (event.target && boundary?.contains(event.target as Node)) (handler as (event: unknown) => void)(event)
  }]))
  const semantics = Object.fromEntries(Object.entries(behavior).filter(([name]) => isModalBoundaryAttribute(name)))
  return <div ref={attachScope} id={context.id} data-overlay-modal-scope={context.id} hidden={!visible}>
    <div ref={setScrimHost} style={{ display: 'contents' }} />
    <div ref={setBoundary} data-overlay-modal-boundary="" {...semantics} data-state={visible ? 'open' : 'closed'} {...events}>
      <ModalBoundaryContext.Provider value={owner}><ModalAttachmentContext.Provider value={attachment}>{children}</ModalAttachmentContext.Provider></ModalBoundaryContext.Provider>
      {ready ? <DismissableLayerBranch ref={attachSlot} data-overlay-modal-slot="" /> : null}
    </div>
  </div>
})

export const ModalOverlay = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(function ModalOverlay(props, ref) {
  const context = useContext(ModalContext)
  const boundary = useContext(ModalBoundaryContext)
  const forceMount = useContext(ModalPortalMountContext) || props.forceMount
  if (context && !context.modal) return null
  const group = context?.modal ? { 'data-overlay-modal-id': context.id, 'data-overlay-modal-part': 'scrim' } : {}
  if (context && (!context.requestedOpen || context.failure !== null || boundary && !boundary.ready)) {
    if (!forceMount && !context.requestedOpen) return null
    const { forceMount: _forceMount, asChild, children, ...dom } = props
    const visual = asChild ? cloneElement(Children.only(children) as ReactElement<Record<string, unknown>>, { ...dom, ...group, 'data-state': 'closed', ref })
      : <div {...dom} {...group} data-state="closed" ref={ref}>{children}</div>
    return boundary?.scrimHost ? createPortal(visual, boundary.scrimHost) : null
  }
  const visual = <DialogPrimitive.Overlay {...props} ref={ref} {...group} />
  return boundary ? boundary.scrimHost ? createPortal(visual, boundary.scrimHost) : null : visual
})

export const ModalContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>(function ModalContent(props, ref) {
  const context = useContext(ModalContext)
  const inheritedBoundary = useContext(ModalBoundaryContext)
  const boundary = context?.modal === false ? null : inheritedBoundary
  const forceMount = useContext(ModalPortalMountContext) || props.forceMount
  const active = (!context || context.requestedOpen && context.failure === null) && (!boundary || boundary.ready)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [behavior, setBehavior] = useState<HTMLAttributes<HTMLDivElement>>({})
  const child = props.asChild ? Children.only(props.children) as ReactElement<Record<string, unknown>> : null
  const childRef = child?.props.ref as Ref<HTMLDivElement> | undefined
  const documentLease = useRef({ document: inheritedBoundary?.document ?? element?.ownerDocument, generation: 0,
    focus: null as { element: HTMLElement; attempt: string | undefined } | null })
  // Ref retirement is not a document transfer. Radix returns focus asynchronously
  // after inline content has left the DOM, so retain its last actual lease document.
  const behaviorDocument = inheritedBoundary?.document ?? element?.ownerDocument ?? documentLease.current.document
  if (documentLease.current.document !== behaviorDocument) {
    const previousFocus = documentLease.current.document?.activeElement
    const container = boundary?.boundary ?? element
    documentLease.current = { document: behaviorDocument, generation: documentLease.current.generation + 1,
      focus: previousFocus && container?.contains(previousFocus) ? { element: previousFocus as HTMLElement, attempt: context?.id } : null }
  }
  const latest = useRef({ failure: context?.failure, id: context?.id, document: behaviorDocument }); latest.current = { failure: context?.failure, id: context?.id, document: behaviorDocument }
  const rawLeaseProps = { ...props, children: undefined }
  if (boundary && child) for (const [name, value] of Object.entries(child.props)) if (isModalBoundaryAttribute(name)) (rawLeaseProps as Record<string, unknown>)[name] = value
  if (boundary) for (const name of Object.keys(rawLeaseProps)) if (/^on[A-Z]/.test(name) && !['onOpenAutoFocus', 'onCloseAutoFocus', 'onEscapeKeyDown', 'onPointerDownOutside', 'onFocusOutside', 'onInteractOutside'].includes(name)) delete (rawLeaseProps as Record<string, unknown>)[name]
  const leaseProps = useRef(rawLeaseProps)
  if (!sameShallow(leaseProps.current, rawLeaseProps)) leaseProps.current = rawLeaseProps
  const attach = useCallback((node: HTMLDivElement | null) => {
    setElement(node)
    const refs = [ref, childRef]
    const cleanups = refs.map(target => typeof target === 'function' ? target(node) : target ? (target.current = node, undefined) : undefined)
    return () => {
      setElement(null)
      refs.forEach((target, index) => {
        const cleanup = cleanups[index]
        if (typeof cleanup === 'function') cleanup()
        else if (typeof target === 'function') target(null)
        else if (target) target.current = null
      })
    }
  }, [ref, childRef])
  // Radix owns the real boundary; public refs and autofocus callbacks retain the original
  // painted Content. Only behavior retires on failure/closed forceMount, never the draft DOM.
  const lease = useMemo(() => {
    const current = leaseProps.current, attemptId = context?.id
    const autofocus = (event: Event, close: boolean) => {
      if (close && (latest.current.failure != null || latest.current.id !== attemptId || latest.current.document !== behaviorDocument)) { event.preventDefault(); return }
      if (!element) return
      const transferred = documentLease.current.focus
      if (!close && transferred && transferred.attempt === attemptId && transferred.element.ownerDocument === behaviorDocument && (boundary?.boundary ?? element).contains(transferred.element)) {
        // A document lease transfer is the same opening, not a new autofocus intent.
        // Radix's default focusFirst(select:true) would otherwise select the saved draft.
        documentLease.current.focus = null
        event.preventDefault(); transferred.element.focus({ preventScroll: true }); return
      }
      if (event.target === element) { (close ? current.onCloseAutoFocus : current.onOpenAutoFocus)?.(event); return }
      const Event = element.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
      const actual = new Event(event.type, { cancelable: true })
      element.dispatchEvent(actual)
      ;(close ? current.onCloseAutoFocus : current.onOpenAutoFocus)?.(actual)
      if (actual.defaultPrevented) event.preventDefault()
    }
    return active ? <DialogPrimitive.Content key={documentLease.current.generation} {...current} asChild onOpenAutoFocus={event => autofocus(event, false)} onCloseAutoFocus={event => autofocus(event, true)} onEscapeKeyDown={event => handleModalEscape(event, current.onEscapeKeyDown)}>
      <ContentBehavior target={boundary?.boundary ?? element} publish={setBehavior} boundaryPublish={boundary?.publish} />
    </DialogPrimitive.Content> : null
  }, [active, leaseProps.current, element, boundary, context?.id, behaviorDocument])
  if (context && !context.requestedOpen && !forceMount) return null
  const { asChild: _asChild, forceMount: _forceMount, children, onOpenAutoFocus: _open, onCloseAutoFocus: _close,
    onEscapeKeyDown: _escape, onPointerDownOutside: _pointerOutside, onFocusOutside: _focusOutside, onInteractOutside: _interactOutside, ...dom } = props
  if (boundary) for (const name of Object.keys(dom)) if (isModalBoundaryAttribute(name)) delete (dom as Record<string, unknown>)[name]
  const attributes = Object.fromEntries(Object.entries(behavior).filter(([name]) => !boundary || !/^on[A-Z]/.test(name) && !isModalBoundaryAttribute(name)))
  const visual: Record<string, unknown> = { ...dom, ...(active ? attributes : {}), ...(context?.modal ? { 'data-overlay-modal-id': context.id, 'data-overlay-modal-part': 'content' } : {}),
    'data-state': active ? 'open' : 'closed', ...(!boundary ? { role: dom.role ?? 'dialog' } : {}), ref: attach }
  if (child) {
    for (const [name, value] of Object.entries(child.props)) {
      const inherited = visual[name]
      if (boundary && isModalBoundaryAttribute(name)) visual[name] = undefined
      else if (/^on[A-Z]/.test(name) && typeof value === 'function' && typeof inherited === 'function') visual[name] = (...args: unknown[]) => { value(...args); inherited(...args) }
      else if (name === 'style') visual[name] = { ...(inherited as object), ...(value as object) }
      else if (name === 'className') visual[name] = [inherited, value].filter(Boolean).join(' ')
    }
  }
  return <>{child ? cloneElement(child, visual) : <div {...visual}>{children}</div>}{lease}</>
})

const ContentBehavior = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { target: HTMLDivElement | null; publish(props: HTMLAttributes<HTMLDivElement>): void; boundaryPublish?: ((props: HTMLAttributes<HTMLDivElement>) => void) | undefined }>(function ContentBehavior({ target, publish, boundaryPublish, ...props }, ref) {
  useImperativeHandle(ref, () => target as HTMLDivElement, [target])
  useLayoutEffect(() => { publish(props); boundaryPublish?.(props) }, [publish, boundaryPublish, props])
  return null
})

function moveModalScopeToFront(scope: HTMLElement): void {
  const target = scope.parentElement?.hasAttribute('data-overlay-modal-host') ? scope.parentElement : scope
  const parent = target.parentElement
  if (parent && parent.lastElementChild !== target) moveModalHost(target, parent)
}

function moveModalHost(host: HTMLElement, destination: Element | DocumentFragment): void {
  const movable = destination as Element & { moveBefore?(node: Node, before: Node | null): void }
  if (host.isConnected && destination.isConnected && host.ownerDocument === destination.ownerDocument && typeof movable.moveBefore === 'function') { movable.moveBefore(host, null); return }
  const document = host.ownerDocument, active = document.activeElement
  const focus = active && host.contains(active) ? active as HTMLElement : null
  const textControl = focus && (focus.tagName === 'INPUT' || focus.tagName === 'TEXTAREA') ? focus as HTMLInputElement | HTMLTextAreaElement : null
  const textSelection = textControl && textControl.selectionStart !== null && textControl.selectionEnd !== null
    ? { start: textControl.selectionStart, end: textControl.selectionEnd, direction: textControl.selectionDirection } : null
  const selection = document.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const saved = range && host.contains(range.startContainer) && host.contains(range.endContainer)
    ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset } : null
  destination.appendChild(host)
  const nextDocument = host.ownerDocument
  if (focus && (nextDocument.activeElement === nextDocument.body || host.contains(nextDocument.activeElement))) focus.focus({ preventScroll: true })
  if (saved) {
    const rebound = nextDocument.createRange()
    rebound.setStart(saved.start, saved.startOffset); rebound.setEnd(saved.end, saved.endOffset)
    const nextSelection = nextDocument.getSelection(); nextSelection?.removeAllRanges(); nextSelection?.addRange(rebound)
  }
  // Document Range does not contain an input/textarea's native text selection.
  // DOM adoption can reset that selection even though the original node survives.
  if (textSelection) textControl!.setSelectionRange(textSelection.start, textSelection.end, textSelection.direction ?? 'none')
}

function sameShallow(left: object, right: object): boolean {
  const a = Object.entries(left), b = Object.entries(right)
  return a.length === b.length && a.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]))
}

function isModalBoundaryAttribute(name: string): boolean {
  return name === 'id' || name === 'role' || name === 'tabIndex' || name.startsWith('aria-')
}

/** An IME-owned Escape does not enter either Radix dismissal or caller close effects. */
function handleModalEscape(event: KeyboardEvent, onEscapeKeyDown?: (event: KeyboardEvent) => void): void {
  if (isImeOwnedKeyboardEvent(event)) { event.preventDefault(); return }
  onEscapeKeyDown?.(event)
}

export { ModalRoot as Root, ModalRoot as Dialog, ModalPortal as Portal, ModalPortal as DialogPortal, ModalOverlay as Overlay, ModalOverlay as DialogOverlay, ModalContent as Content, ModalContent as DialogContent }
