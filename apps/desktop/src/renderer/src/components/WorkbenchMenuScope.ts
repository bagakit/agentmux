import * as ContextMenu from '@radix-ui/react-context-menu'
import { createContext } from 'react'
import * as DropdownMenu from './HoverDropdownMenu'

/** The same menu body uses its invoking Radix scope; action state stays with the original owner. */
export type WorkbenchMenuParts = Pick<typeof ContextMenu,
  'Item' | 'Label' | 'Group' | 'Separator' | 'Sub' | 'SubTrigger' | 'SubContent' | 'Portal'>
export const WorkbenchMenuScope = createContext<WorkbenchMenuParts>(DropdownMenu)
