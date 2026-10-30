import { useId } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { IconButton } from '@agentmux/client-ui/components/IconButton'

/** The existing directory owner retains issues; this header entry only discloses them. */
export function MobileDirectoryNotice({ issues, retry }: { issues: { source: string; message: string }[]; retry(): void }) {
  const description = useId()
  if (!issues.length) return null
  return <Dialog.Root><Dialog.Trigger asChild><button type="button" className="mobile-directory-notice"
    aria-label={`目录信息 · ${issues.length} 项待确认`} title="查看目录问题与处理方式">
    <SemanticIcon name="status.warning" size={16} /><span>{issues.length}</span>
  </button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-directory-issues" aria-describedby={description}>
      <div className="mobile-sheet-handle" /><div className="mobile-sheet-title"><Dialog.Title>目录信息</Dialog.Title>
        <Dialog.Close asChild><IconButton className="mobile-icon-button" aria-label="关闭目录信息"><SemanticIcon name="action.close" size={18} /></IconButton></Dialog.Close></div>
      <Dialog.Description id={description}>部分资料尚未确认，已读目录和对话仍可使用。</Dialog.Description>
      <button type="button" className="mobile-text-button mobile-directory-retry" onClick={retry}><SemanticIcon name="action.refresh" size={16} />重新读取目录</button>
      <div className="mobile-directory-issue-list">{issues.map((issue, index) => <section key={index}>
        <h3>{issue.source}</h3><p>这项资料尚未确认，可重新读取；已有工作保留。</p>
        <details className="mobile-directory-technical"><summary>原因与技术信息</summary><p>{issue.message}</p></details>
      </section>)}</div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
