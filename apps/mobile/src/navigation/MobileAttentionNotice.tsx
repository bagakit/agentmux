import { useId, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileNotice } from '../notices/MobileNotice'
import { MobileSheetHeader } from './MobileSheetHeader'

/** The shell retains the original read failure; this view only opens its existing recovery action. */
export function MobileAttentionNotice({ issue, owner, retry }: { issue: string; owner: object | null; retry(): void }) {
  const description = useId(), [open, setOpen] = useState(false)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <MobileNotice owner={owner} identity={[issue]} className="mobile-service-notice mobile-attention-notice">
      <Dialog.Trigger asChild><button type="button" className="mobile-text-button" aria-label="需要你列表尚未确认，查看原因和恢复操作">
        <SemanticIcon name="status.info" size={14} /><span>需要你列表尚未确认</span><SemanticIcon name="navigation.submenu" size={14} />
      </button></Dialog.Trigger>
    </MobileNotice>
    <Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-attention-details" aria-describedby={description}>
      <MobileSheetHeader onClose={() => setOpen(false)} title="需要你列表尚未确认" closeLabel="关闭需要你列表信息" />
      <Dialog.Description id={description}>保留了最近一次列表，数量可能已变化；你可以继续对话，也可以重新读取。</Dialog.Description>
      <button type="button" className="mobile-text-button" onClick={retry}><SemanticIcon name="action.refresh" size={16} />重新读取需要你列表</button>
      <details className="mobile-directory-technical"><summary>技术信息</summary><p>{issue}</p></details>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
