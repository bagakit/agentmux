import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Branch as DismissableLayerBranch } from '@radix-ui/react-dismissable-layer'
import { Children, cloneElement, createContext, forwardRef, useCallback, useContext, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentPropsWithoutRef, type HTMLAttributes, type ReactElement, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useClientUiOwnerDocument } from '../platform.js'

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
const ModalBoundaryContext = createContext<{ boundary: HTMLDivElement | null; scrimHost: HTMLDivElement | null; publish(props: HTMLAttributes<HTMLDivElement>): void } | null>(null)

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
  useLayoutEffect(() => { if (!parentAttachment || parentAttachment.ready) setAdmitted(true) }, [parentAttachment])
  if (!admitted && parentAttachment && !parentAttachment.ready) return null
  if (!context?.modal) return parentAttachment && !inheritedContainer ? null : <DialogPrimitive.Portal {...props} container={inheritedContainer ?? windowContainer}>{children}</DialogPrimitive.Portal>
  const failed = context.requestedOpen && context.failure !== null
  return <>
    <ModalPortalMountContext.Provider value={props.forceMount === true || failed}>
      <DialogPrimitive.Portal {...props} {...(failed ? { forceMount: true } : {})} container={windowContainer}>
        <ModalScope context={context} document={ownerDocument}>{children}</ModalScope>
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

/** One non-scrolling boundary gives Radix ownership of both the content and its attached controls. */
const ModalScope = forwardRef<HTMLDivElement, { context: ModalContextValue; document: Document; children?: ComponentProps<typeof DialogPrimitive.Portal>['children'] }>(function ModalScope({ context, document, children }, forwardedRef) {
  const [scope, setScope] = useState<HTMLDivElement | null>(null)
  const [boundary, setBoundary] = useState<HTMLDivElement | null>(null)
  const [scrimHost, setScrimHost] = useState<HTMLDivElement | null>(null)
  const [behavior, setBehavior] = useState<HTMLAttributes<HTMLDivElement>>({})
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [readyScope, setReadyScope] = useState<{ scope: HTMLDivElement; attempt: string } | null>(null)
  const visible = context.requestedOpen && context.failure === null
  const ready = visible && scope !== null && readyScope?.scope === scope && readyScope.attempt === context.id
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
  // Radix first hides the rest of the document from accessibility. Attach this modal's
  // own non-scrolling slot afterwards; later nested modals then mount above this scope.
  useEffect(() => {
    if (!scope || !visible) return
    setReadyScope({ scope, attempt: context.id })
  }, [scope, context.id, visible])
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
  const owner = useMemo(() => ({ boundary, scrimHost, publish: setBehavior }), [boundary, scrimHost])
  const events = Object.fromEntries(Object.entries(behavior).filter(([name, value]) => /^on[A-Z]/.test(name) && typeof value === 'function').map(([name, handler]) => [name, (event: { target: EventTarget | null }) => {
    if (event.target && boundary?.contains(event.target as Node)) (handler as (event: unknown) => void)(event)
  }]))
  return <div ref={attachScope} id={context.id} data-overlay-modal-scope={context.id} hidden={!visible}>
    <div ref={setScrimHost} style={{ display: 'contents' }} />
    <div ref={setBoundary} style={{ display: 'contents' }} {...events}>
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
  if (context && (!context.requestedOpen || context.failure !== null)) {
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
  const active = !context || context.requestedOpen && context.failure === null
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [behavior, setBehavior] = useState<HTMLAttributes<HTMLDivElement>>({})
  const child = props.asChild ? Children.only(props.children) as ReactElement<Record<string, unknown>> : null
  const childRef = child?.props.ref as Ref<HTMLDivElement> | undefined
  const latest = useRef({ requestedOpen: context?.requestedOpen, id: context?.id }); latest.current = { requestedOpen: context?.requestedOpen, id: context?.id }
  const rawLeaseProps = { ...props, children: undefined }
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
  // Radix's final DOM contract is attached to the retained visual node. Only its behavior
  // shell retires on failure/closed forceMount, releasing FocusScope, hideOthers and input locks.
  const lease = useMemo(() => {
    const current = leaseProps.current
    const autofocus = (event: Event, close: boolean) => {
      if (close && latest.current.requestedOpen) { event.preventDefault(); return }
      if (!element) return
      if (event.target === element) { (close ? current.onCloseAutoFocus : current.onOpenAutoFocus)?.(event); return }
      const Event = element.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
      const actual = new Event(event.type, { cancelable: true })
      element.dispatchEvent(actual)
      ;(close ? current.onCloseAutoFocus : current.onOpenAutoFocus)?.(actual)
      if (actual.defaultPrevented) event.preventDefault()
    }
    return active ? <DialogPrimitive.Content {...current} asChild onOpenAutoFocus={event => autofocus(event, false)} onCloseAutoFocus={event => autofocus(event, true)}>
      <ContentBehavior target={boundary?.boundary ?? element} publish={setBehavior} boundaryPublish={boundary?.publish} />
    </DialogPrimitive.Content> : null
  }, [active, leaseProps.current, element, boundary])
  if (context && !context.requestedOpen && !forceMount) return null
  const { asChild: _asChild, forceMount: _forceMount, children, onOpenAutoFocus: _open, onCloseAutoFocus: _close,
    onEscapeKeyDown: _escape, onPointerDownOutside: _pointerOutside, onFocusOutside: _focusOutside, onInteractOutside: _interactOutside, ...dom } = props
  const attributes = Object.fromEntries(Object.entries(behavior).filter(([name]) => !boundary || !/^on[A-Z]/.test(name)))
  const visual: Record<string, unknown> = { ...dom, ...(active ? attributes : {}), ...(context?.modal ? { 'data-overlay-modal-id': context.id, 'data-overlay-modal-part': 'content' } : {}),
    'data-state': active ? 'open' : 'closed', role: dom.role ?? 'dialog', ref: attach }
  if (child) {
    for (const [name, value] of Object.entries(child.props)) {
      const inherited = visual[name]
      if (/^on[A-Z]/.test(name) && typeof value === 'function' && typeof inherited === 'function') visual[name] = (...args: unknown[]) => { value(...args); inherited(...args) }
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

function sameShallow(left: object, right: object): boolean {
  const a = Object.entries(left), b = Object.entries(right)
  return a.length === b.length && a.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]))
}

export { ModalRoot as Root, ModalRoot as Dialog, ModalPortal as Portal, ModalPortal as DialogPortal, ModalOverlay as Overlay, ModalOverlay as DialogOverlay, ModalContent as Content, ModalContent as DialogContent }
