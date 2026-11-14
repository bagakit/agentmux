import * as Menu from '@radix-ui/react-dropdown-menu'
import type { ComponentPropsWithRef, ComponentPropsWithoutRef } from 'react'
import { useClientUiOverlayHost } from '../overlay-host.js'

export {
  Root, Trigger, Group, Label, Item, Separator, RadioGroup, RadioItem,
  CheckboxItem, ItemIndicator, Sub, SubTrigger, Arrow
} from '@radix-ui/react-dropdown-menu'

/** Pointer, touch and keyboard activation use the same Radix disclosure. */
export function Portal({ container, ...props }: ComponentPropsWithoutRef<typeof Menu.Portal>) {
  const host = useClientUiOverlayHost()
  return <Menu.Portal {...props} container={container ?? host?.overlayContainer()} />
}

export function Content({ className, ...props }: ComponentPropsWithRef<typeof Menu.Content>) {
  return <Menu.Content {...props} className={className ? 'agent-dropdown-menu ' + className : 'agent-dropdown-menu'} />
}

export function SubContent({ className, ...props }: ComponentPropsWithRef<typeof Menu.SubContent>) {
  return <Menu.SubContent {...props} className={className ? 'agent-dropdown-menu ' + className : 'agent-dropdown-menu'} />
}
