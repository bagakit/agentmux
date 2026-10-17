import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MailboxNavigation } from './MailboxNavigation'

const InputIcon = semanticIconComponent('object.mail')
const AgentIcon = semanticIconComponent('object.inbox')
const NoticeIcon = semanticIconComponent('object.notifications')
export type MailboxFolder = 'inbox' | 'outbox' | 'user' | 'system' | 'progress' | 'collaboration'
export type AgentMessageFolder = 'inbox' | 'outbox' | 'collaboration'
export const isAgentMessageFolder = (folder: MailboxFolder): folder is AgentMessageFolder =>
  folder === 'inbox' || folder === 'outbox' || folder === 'collaboration'

/** Task navigation only. Original readers, receipts and automation keep their own owners. */
export function MailboxWorkspaceNavigation({ id, folder, agentFolder, onSelect, unread, pending, notices, collaboration }: {
  id: string; folder: MailboxFolder; agentFolder: AgentMessageFolder; onSelect(folder: MailboxFolder): void
  unread: number; pending: number; notices: number; collaboration: boolean
}) {
  const agents = isAgentMessageFolder(folder)
  return <>
    <MailboxNavigation id={id} selected={agents ? 'agents' : folder === 'system' ? 'system' : 'user'}
      onSelect={key => onSelect(key === 'agents' ? agentFolder : key)} items={[
        { key: 'user', label: 'Inputs', description: `Inputs: ${pending} pending`, icon: <InputIcon size={14} />, count: pending },
        { key: 'agents', label: 'Agent messages', description: `Agent messages: ${unread} unread in loaded messages`, icon: <AgentIcon size={14} />, count: unread },
        { key: 'system', label: 'Notices', description: `Notices: ${notices} need attention`, icon: <NoticeIcon size={14} />, count: notices }
      ]} />
    {agents ? <MailboxNavigation id={id} selected={folder} onSelect={onSelect} secondary label="Agent message folders" items={[
      { key: 'inbox', label: 'Received', description: 'Received Agent messages', icon: null, count: 0 },
      { key: 'outbox', label: 'Sent', description: 'Sent Agent messages', icon: null, count: 0 },
      ...(collaboration ? [{ key: 'collaboration' as const, label: 'Collaboration', description: 'Supervised collaboration', icon: null, count: 0 }] : [])
    ]} /> : null}
  </>
}
