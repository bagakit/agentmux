import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  CircleAlert,
  ExternalLink,
  PanelBottomOpen,
  PanelLeftOpen,
  PanelRightOpen,
  PanelTopOpen,
  SquarePlus
} from 'lucide-react'
import {
  openDestinationNeedsRegion,
  type OpenDestination
} from '../lib/open-destination'

export type OpenDestinationMenuRequest = Readonly<{
  id: number
  url: string
  x: number
  y: number
}>

export const OPEN_DESTINATION_MENU_ITEMS = [
  { destination: 'system', label: 'Open in System Browser' },
  { destination: 'tab', label: 'Open in New Tab' },
  { destination: 'left', label: 'Open on the Left' },
  { destination: 'right', label: 'Open on the Right' },
  { destination: 'up', label: 'Open Above' },
  { destination: 'down', label: 'Open Below' }
] as const satisfies ReadonlyArray<{
  destination: OpenDestination
  label: string
}>

const DESTINATION_ICONS = {
  system: ExternalLink,
  tab: SquarePlus,
  left: PanelLeftOpen,
  right: PanelRightOpen,
  up: PanelTopOpen,
  down: PanelBottomOpen
} satisfies Record<OpenDestination, typeof ExternalLink>

const SPLIT_DESTINATIONS = OPEN_DESTINATION_MENU_ITEMS.filter((item) =>
  openDestinationNeedsRegion(item.destination)
)

const DIRECT_DESTINATIONS = OPEN_DESTINATION_MENU_ITEMS.filter((item) =>
  !openDestinationNeedsRegion(item.destination)
)

export function OpenDestinationPreview({
  destination
}: {
  destination: Exclude<OpenDestination, 'system' | 'tab'>
}) {
  const selected = {
    left: { x: 1, y: 1, width: 9, height: 14 },
    right: { x: 10, y: 1, width: 9, height: 14 },
    up: { x: 1, y: 1, width: 18, height: 7 },
    down: { x: 1, y: 8, width: 18, height: 7 }
  }[destination]

  return (
    <svg
      aria-hidden="true"
      data-open-destination-preview={destination}
      width="20"
      height="16"
      viewBox="0 0 20 16"
      fill="none"
    >
      <rect x="1" y="1" width="18" height="14" rx="2" stroke="currentColor" opacity="0.45" />
      <rect
        data-active-pane={destination}
        x={selected.x}
        y={selected.y}
        width={selected.width}
        height={selected.height}
        rx="1.5"
        fill="currentColor"
        opacity="0.72"
      />
    </svg>
  )
}

export function OpenDestinationMenu({
  request,
  canSplit,
  onSelect,
  onDismiss
}: {
  request: OpenDestinationMenuRequest | null
  canSplit: boolean
  onSelect(destination: OpenDestination): void
  onDismiss(requestId: number): void
}) {
  if (!request) return null

  const requestId = request.id
  const renderItem = (item: (typeof OPEN_DESTINATION_MENU_ITEMS)[number]) => {
    const Icon = DESTINATION_ICONS[item.destination]
    const needsRegion = openDestinationNeedsRegion(item.destination)
    const disabled = needsRegion && !canSplit

    return (
      <DropdownMenu.Item
        key={item.destination}
        className="tab-context-menu__item open-destination-menu__item"
        data-destination={item.destination}
        data-needs-region={needsRegion ? '' : undefined}
        data-disabled-reason={disabled ? 'A precise pane is required' : undefined}
        disabled={disabled}
        title={disabled ? 'Choose a precise pane before opening beside it' : item.label}
        onSelect={() => onSelect(item.destination)}
      >
        <Icon size={14} />
        <span>{item.label}</span>
        {needsRegion ? <OpenDestinationPreview destination={item.destination} /> : null}
      </DropdownMenu.Item>
    )
  }

  return (
    <DropdownMenu.Root
      key={requestId}
      open
      onOpenChange={(open) => {
        if (!open) onDismiss(requestId)
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Open link destination"
          tabIndex={-1}
          style={{
            position: 'fixed',
            left: request.x,
            top: request.y,
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: 'none'
          }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tab-context-menu open-destination-menu"
          aria-label="Choose where to open link"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenu.Label className="tab-context-menu__item open-destination-menu__url">
            <ExternalLink size={14} />
            <span title={request.url}>
              {request.url}
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="tab-context-menu__separator" />
          {DIRECT_DESTINATIONS.map(renderItem)}
          <DropdownMenu.Separator className="tab-context-menu__separator" />
          {!canSplit ? (
            <DropdownMenu.Label
              className="tab-context-menu__item open-destination-menu__hint"
              data-split-destination-explanation=""
            >
              <CircleAlert size={14} />
              <span>Choose a precise pane to open beside it.</span>
            </DropdownMenu.Label>
          ) : null}
          {SPLIT_DESTINATIONS.map(renderItem)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
