import { Portal as SharedPortal } from '@agentmux/client-ui/components/DropdownMenu'
import type { ComponentProps } from 'react'
import { DocumentOverlayPortal } from './WindowOverlayHost'

export {
  Root, Trigger, Group, Label, Item, Separator, RadioGroup, RadioItem, CheckboxItem,
  ItemIndicator, Sub, SubTrigger, Arrow, Content, SubContent
} from '@agentmux/client-ui/components/DropdownMenu'

/** Keep the invoking workbench document and its original modal scope. */
export function Portal({ container, ...props }: ComponentProps<typeof SharedPortal>) {
  return <DocumentOverlayPortal component={SharedPortal} container={container} {...props} />
}
