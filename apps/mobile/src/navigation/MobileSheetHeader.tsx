import type { ReactNode } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileSheetHandle } from './MobileSheetHandle'

export function MobileSheetHeader({ title, closeLabel, onClose }: { title: ReactNode; closeLabel: string; onClose(): void }) {
  return <>
    <MobileSheetHandle onClose={onClose} />
    <div className="mobile-sheet-title">
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Close asChild><IconButton className="mobile-icon-button" aria-label={closeLabel}>
        <SemanticIcon name="action.close" size={18} />
      </IconButton></Dialog.Close>
    </div>
  </>
}
