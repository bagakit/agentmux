export const mailboxMutations = [
  { label: 'journal-is-the-message-source', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: "items={name === 'inbox' ? incoming : outgoing}", after: 'items={[]}', tests: ['apps/desktop/test/session-mailbox-a2a.test.tsx'] },
  { label: 'copy-keeps-the-complete-original', file: 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
    before: 'content={record.envelope.body} copyText={record.envelope.body}', after: 'content={record.envelope.body} copyText={record.envelope.body.slice(0, 240)}', tests: ['apps/desktop/test/mailbox-a2a.test.tsx'] },
  { label: 'late-source-cannot-fill-another-agent', file: 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
    before: "if (!isCurrent()) throw new Error('This reading surface changed.", after: "if (false) throw new Error('This reading surface changed.", tests: ['apps/desktop/test/mailbox-a2a.test.tsx'] },
  { label: 'selected-mid-survives-page-replacement', file: 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
    before: "const selectedId = selectedKey?.startsWith('a2a:') ? selectedKey.slice(4) || undefined : undefined", after: 'const selectedId = selected?.envelope.messageId', tests: ['apps/desktop/test/mailbox-a2a.test.tsx'] },
  { label: 'delivery-does-not-reset-human-reading', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'String(item.sequence)', after: 'JSON.stringify([item.sequence, item.delivery])', tests: ['apps/desktop/test/session-mailbox-a2a.test.tsx'] },
  { label: 'unseen-arrivals-stay-unread-in-detail', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: "!(selection?.scope === scope && selection.folder === 'inbox') && receipts.unread.length", after: 'receipts.unread.length', tests: ['apps/desktop/test/session-mailbox-a2a.test.tsx'] },
  { label: 'refresh-keeps-the-window-contiguous', file: 'apps/desktop/src/renderer/src/lib/use-session-messages.ts',
    before: ': new Map<string, AgentMuxMessageMetadata>()', after: ': new Map(previous.items.map(item => [item.envelope.messageId, item]))', tests: ['apps/desktop/test/session-messages-read.test.tsx'] },
  { label: 'cancelled-is-not-a-reply', file: 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
    before: "if (delivery.state === 'cancelled') return 'Delivery cancelled'", after: "if (delivery.state === 'cancelled') return 'Reply recorded'", tests: ['apps/desktop/test/mailbox-a2a.test.tsx'] }
]
