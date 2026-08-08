import * as Menu from '@radix-ui/react-dropdown-menu'
import {
  createContext, forwardRef, useContext, useEffect, useRef, useState,
  type ComponentPropsWithoutRef, type PointerEvent
} from 'react'

// Radix owns selection, dismissal, keyboard navigation and portals. This adapter only adds mouse
// disclosure, keeping its open callback as the owner for native-view yielding and subscriptions.
export { Portal, Item, Separator, Label, RadioGroup, RadioItem, ItemIndicator } from '@radix-ui/react-dropdown-menu'
const OPEN_EVENT = 'agentmux:hover-menu-open'
const Context = createContext<{
  open: boolean
  hover: { current: boolean }
  trigger: { current: HTMLButtonElement | null }
  content: { current: HTMLDivElement | null }
  change(open: boolean): void
  enter(event: PointerEvent): void
  leave(event: PointerEvent): void
} | null>(null)

function useMenu() {
  const context = useContext(Context)
  if (!context) throw new Error('Hover menu parts require Root')
  return context
}

export function Root({ open: controlled, onOpenChange, children }: ComponentPropsWithoutRef<typeof Menu.Root>) {
  const [local, setLocal] = useState(false)
  const open = controlled ?? local
  const openRef = useRef(open)
  openRef.current = open
  const notify = useRef(onOpenChange)
  notify.current = onOpenChange
  const hover = useRef(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const identity = useRef(Symbol())
  function cancelClose() { clearTimeout(timer.current) }
  function change(next: boolean) {
    cancelClose()
    if (openRef.current === next) return
    if (next) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: identity.current }))
    openRef.current = next
    setLocal(next)
    notify.current?.(next)
  }
  const changeRef = useRef(change)
  changeRef.current = change
  useEffect(() => {
    const closeOther = (event: Event) => {
      if ((event as CustomEvent).detail !== identity.current) changeRef.current(false)
    }
    window.addEventListener(OPEN_EVENT, closeOther)
    return () => {
      cancelClose()
      window.removeEventListener(OPEN_EVENT, closeOther)
      if (openRef.current) notify.current?.(false)
    }
  }, [])
  function enter(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    cancelClose()
    if (!openRef.current) { hover.current = true; change(true) }
  }
  function leave(event: PointerEvent) {
    if (event.pointerType !== 'mouse' || !hover.current) return
    cancelClose()
    timer.current = setTimeout(() => changeRef.current(false), 180)
  }
  return <Context.Provider value={{ open, hover, trigger, content, change, enter, leave }}>
    <Menu.Root open={open} onOpenChange={change} modal={false}>{children}</Menu.Root>
  </Context.Provider>
}

export const Trigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Menu.Trigger>>(
  function Trigger({ onPointerEnter, onPointerLeave, onPointerDown, onKeyDown, ...props }, ref) {
    const menu = useMenu()
    return <Menu.Trigger {...props} ref={(node) => {
      menu.trigger.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }}
      onPointerEnter={(event) => {
        onPointerEnter?.(event)
        if (!event.defaultPrevented && !event.currentTarget.disabled) menu.enter(event)
      }}
      onPointerLeave={(event) => { onPointerLeave?.(event); menu.leave(event) }}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        // A click after hovering must not close the menu just opened under the pointer.
        if (menu.open && menu.hover.current && event.button === 0) event.preventDefault()
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        menu.hover.current = false
        if (menu.open && ['Enter', ' ', 'ArrowDown'].includes(event.key)) {
          event.preventDefault()
          menu.content.current?.focus()
        }
      }}
    />
  }
)

export const Content = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Menu.Content>>(
  function Content({ onPointerEnter, onPointerLeave, onCloseAutoFocus, onKeyDown, onPointerDownOutside, onContextMenu, ...props }, ref) {
    const menu = useMenu()
    return <Menu.Content {...props} ref={(node) => {
      // FocusScope exposes a cancellable DOM mount event. DropdownMenu deliberately omits the
      // private onOpenAutoFocus prop, so listen on the actual scope before its mount effect runs.
      if (node) node.addEventListener('focusScope.autoFocusOnMount', (event) => {
        if (menu.hover.current) event.preventDefault()
      }, { once: true })
      menu.content.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }}
      onPointerEnter={(event) => { onPointerEnter?.(event); menu.enter(event) }}
      onPointerLeave={(event) => { onPointerLeave?.(event); menu.leave(event) }}
      onPointerDownOutside={(event) => {
        if (menu.hover.current && menu.trigger.current?.contains(event.target as Node)) event.preventDefault()
        onPointerDownOutside?.(event)
      }}
      onContextMenu={(event) => { menu.hover.current = false; onContextMenu?.(event) }}
      onCloseAutoFocus={(event) => {
        if (menu.hover.current) event.preventDefault()
        onCloseAutoFocus?.(event)
      }}
      onKeyDown={(event) => { menu.hover.current = false; onKeyDown?.(event) }}
    />
  }
)
