import * as Shared from '@agentmux/client-ui/components/HoverDropdownMenu'
import type { ComponentPropsWithoutRef } from 'react'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { DocumentOverlayPortal } from './WindowOverlayHost'

// Interaction belongs to client-ui. Desktop supplies its exact document and
// original overlay host; callers keep the same menu and React event boundary.
export { Group, Separator, Label, RadioGroup, ItemIndicator, Item, RadioItem, CheckboxItem, Sub, SubTrigger, SubContent, Trigger, Content, useHoverMenuBranch } from '@agentmux/client-ui/components/HoverDropdownMenu'

export function Root(props: Omit<ComponentPropsWithoutRef<typeof Shared.Root>, 'ownerDocument'>) {
  const document = useWorkbenchDocument()
  return <Shared.Root {...props} ownerDocument={document} />
}

export function Portal({ container, ...props }: ComponentPropsWithoutRef<typeof Shared.Portal>) {
  return <DocumentOverlayPortal component={Shared.Portal} container={container} {...props} />
}
