import * as Dialog from '@radix-ui/react-dialog'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useEffect, useId, useRef, useState } from 'react'
import { browserViewportSize, browserViewportsEqual, isBrowserViewport, BROWSER_VIEWPORT_MAX_DIMENSION,
  type BrowserViewport, type BrowserViewportSize } from '../../../shared/browser-viewport'
import * as Menu from './HoverDropdownMenu'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const SelectedIcon = semanticIconComponent('status.selected')

type Option = { id: string; label: string; viewport: BrowserViewport }
// CSS screen dimensions, referenced from Playwright's maintained device descriptors.
// These choices do not change the page's user agent, touch support or operating system.
const groups: { label: string; options: Option[] }[] = [
  { label: 'Common sizes', options: [
    { id: 'mobile', label: 'Mobile', viewport: 'mobile' },
    { id: 'tablet', label: 'Tablet · iPad mini', viewport: 'tablet' },
    { id: 'desktop', label: 'Desktop', viewport: 'desktop' }
  ] },
  { label: 'Phones', options: [
    { id: 'iphone-se', label: 'iPhone SE (3rd gen)', viewport: { width: 375, height: 667, screenPosition: 'mobile' } },
    { id: 'iphone', label: 'iPhone 16', viewport: { width: 393, height: 852, screenPosition: 'mobile' } },
    { id: 'iphone-pro', label: 'iPhone 16 Pro', viewport: { width: 402, height: 874, screenPosition: 'mobile' } },
    { id: 'iphone-max', label: 'iPhone 16 Pro Max', viewport: { width: 440, height: 956, screenPosition: 'mobile' } },
    { id: 'pixel', label: 'Pixel 7', viewport: { width: 412, height: 915, screenPosition: 'mobile' } },
    { id: 'galaxy', label: 'Galaxy S24', viewport: { width: 360, height: 780, screenPosition: 'mobile' } }
  ] },
  { label: 'Tablets', options: [
    { id: 'ipad-pro', label: 'iPad Pro 11', viewport: { width: 834, height: 1194, screenPosition: 'mobile' } }
  ] },
  { label: 'Desktop screens', options: [
    { id: 'laptop', label: 'Laptop', viewport: { width: 1440, height: 900, screenPosition: 'desktop' } },
    { id: 'full-hd', label: 'Full HD', viewport: { width: 1920, height: 1080, screenPosition: 'desktop' } }
  ] }
]

/** Both Browser menu entries render the same applied values and commands. */
export function BrowserViewportOptions({ value, disabled, onSelect, onCustom }: {
  value: BrowserViewport; disabled: boolean; onSelect(value: BrowserViewport): void; onCustom(): void
}) {
  const size = browserViewportSize(value)
  const orientation = size && size.width > size.height ? 'landscape' : 'portrait'
  const options = [{ id: 'responsive', label: 'Responsive', viewport: 'responsive' as const }, ...groups.flatMap(group => group.options)]
  const selected = options.find(option => {
    if (browserViewportsEqual(option.viewport, value)) return true
    const dimensions = browserViewportSize(option.viewport)
    return size && dimensions && size.screenPosition === dimensions.screenPosition &&
      (size.width === dimensions.width && size.height === dimensions.height || size.width === dimensions.height && size.height === dimensions.width)
  })?.id ?? 'custom'
  const select = (id: string) => {
    const option = options.find(option => option.id === id)
    if (option) onSelect(option.viewport)
  }
  const row = (option: Option) => {
    const dimensions = option.id === selected ? size : browserViewportSize(option.viewport)
    return <Menu.RadioItem key={option.id} value={option.id} className="browser-menu__item" disabled={disabled}>
      <span className="browser-menu__indicator"><Menu.ItemIndicator><SelectedIcon size={12} /></Menu.ItemIndicator></span>
      <span>{option.label}</span><small>{dimensions ? `${dimensions.width} × ${dimensions.height}` : 'Fit pane'}</small>
    </Menu.RadioItem>
  }
  return <>
    <Menu.RadioGroup value={selected} onValueChange={select}>{row(options[0]!)}</Menu.RadioGroup>
    <Menu.Item className="browser-menu__item" disabled={disabled} onSelect={onCustom}>
      <span className="browser-menu__indicator">{selected === 'custom' ? <SelectedIcon size={12} /> : null}</span>
      <span>Custom size…</span><small>{size ? `${size.width} × ${size.height}` : 'Width × height'}</small>
    </Menu.Item>
    <Menu.Separator className="browser-menu__separator" />
    <Menu.Label className="browser-menu__label">Orientation</Menu.Label>
    <Menu.RadioGroup value={size ? orientation : ''} onValueChange={next => {
      if (size && next !== orientation) onSelect({ ...size, width: size.height, height: size.width })
    }}>
      {['portrait', 'landscape'].map(next => <Menu.RadioItem key={next} value={next} className="browser-menu__item" disabled={disabled || !size}>
        <span className="browser-menu__indicator"><Menu.ItemIndicator><SelectedIcon size={12} /></Menu.ItemIndicator></span>
        <span>{next === 'portrait' ? 'Portrait' : 'Landscape'}</span>
      </Menu.RadioItem>)}
    </Menu.RadioGroup>
    <Menu.Separator className="browser-menu__separator" />
    <Menu.RadioGroup value={selected} onValueChange={select}>
      {groups.map(group => <Menu.Group key={group.label} aria-label={group.label}>
        <Menu.Label className="browser-menu__label">{group.label}</Menu.Label>{group.options.map(row)}
      </Menu.Group>)}
    </Menu.RadioGroup>
  </>
}

export function BrowserViewportSizeDialog({ value, visible, onApply, onClose }: {
  value: BrowserViewport; visible: boolean; onApply(value: BrowserViewportSize): Promise<void>; onClose(): void
}) {
  const initial = browserViewportSize(value) ?? { width: 1280, height: 800, screenPosition: 'desktop' }
  const [width, setWidth] = useState(String(initial.width)), [height, setHeight] = useState(String(initial.height))
  const [layout, setLayout] = useState(initial.screenPosition)
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null), previousFocus = useRef<HTMLElement | null>(null), content = useRef<HTMLDivElement>(null)
  const closed = useRef(false), applying = useRef(false), id = useId()
  useEffect(() => { closed.current = false; return () => { closed.current = true } }, [])
  useEffect(() => { if (!visible) { closed.current = true; onClose() } }, [visible, onClose])
  function close() { closed.current = true; onClose() }
  async function apply() {
    if (applying.current || closed.current) return
    const dimensions = { width: Number(width), height: Number(height), screenPosition: layout }
    if (!isBrowserViewport(dimensions)) { setError('Enter positive whole numbers for width and height.'); return }
    applying.current = true; setPending(true); setError(null)
    try { await onApply(dimensions); if (!closed.current) close() }
    catch (cause) { if (!closed.current) setError(`Size could not be applied: ${presentError(cause)}`) }
    finally { applying.current = false; if (!closed.current) setPending(false) }
  }
  if (!visible) return null
  return <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content ref={content} className="confirmation-dialog dialog-surface browser-viewport-size-dialog" aria-busy={pending}
        onOpenAutoFocus={event => { event.preventDefault(); previousFocus.current = content.current?.ownerDocument.activeElement as HTMLElement | null; field.current?.focus(); field.current?.select() }}
        onCloseAutoFocus={event => { event.preventDefault(); const original = previousFocus.current, active = original?.ownerDocument.activeElement
          if (original?.isConnected && (!active?.isConnected || active === original.ownerDocument.body || content.current?.contains(active))) original.focus({ preventScroll: true }) }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">Custom viewport</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">Page dimensions in CSS pixels. The page fits inside its current pane.</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void apply() }} onKeyDown={event => { if (event.key === 'Enter' && isImeOwnedKeyboardEvent(event.nativeEvent)) event.preventDefault() }}>
          <div className="browser-viewport-size-fields">
            <label htmlFor={`${id}-width`}>Width<TextInput ref={field} id={`${id}-width`} type="number" min={1} max={BROWSER_VIEWPORT_MAX_DIMENSION} step={1} required value={width} disabled={pending} onChange={event => setWidth(event.target.value)} /></label>
            <span aria-hidden="true">×</span>
            <label htmlFor={`${id}-height`}>Height<TextInput id={`${id}-height`} type="number" min={1} max={BROWSER_VIEWPORT_MAX_DIMENSION} step={1} required value={height} disabled={pending} onChange={event => setHeight(event.target.value)} /></label>
          </div>
          <fieldset className="browser-viewport-layout"><legend>Layout</legend>
            {(['desktop', 'mobile'] as const).map(mode => <label key={mode}><input type="radio" name={`${id}-layout`} value={mode} checked={layout === mode} disabled={pending} onChange={() => setLayout(mode)} />{mode === 'desktop' ? 'Desktop' : 'Mobile'}</label>)}
          </fieldset>
          {error ? <p className="surface-inline-error" role="alert">{error}</p> : null}
          <footer><button type="button" className="small-button" onClick={close}>{pending ? 'Close' : 'Cancel'}</button><button type="submit" className="primary-button" disabled={pending}>{pending ? 'Applying…' : 'Apply size'}</button></footer>
        </form>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
