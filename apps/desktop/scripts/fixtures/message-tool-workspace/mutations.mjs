export const mutations = [
  { name: 'notification-intent-not-persisted', file: 'apps/desktop/src/renderer/src/store.ts',
    before: 'mailboxNotificationIntents: state.mailboxNotificationIntents,', after: 'mailboxNotificationIntents: {},' },
  { name: 'notification-history-replaced', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: 'attempts.slice(1).map(item =>', after: 'attempts.slice(1, 1).map(item =>' },
  { name: 'notification-confirmation-still-busy', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: '...(settled(result.state) ? { sending: false, checking: undefined } : {})', after: '...(settled(result.state) ? { sending: true, checking: undefined } : {})' },
  { name: 'notification-refusal-event-ignored', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: `      for (const event of page.events) {
        if (event.kind !== 'a2a-notification-result' || !event.notificationId || event.state !== 'submitted' && event.state !== 'not-applied' && event.state !== 'unconfirmed') continue
        const intent = originalIntents.get(event.notificationId)
        if (intent) observe(intent, { state: event.state, reason: event.reason, sending: false })
      }
      return page`, after: `      return { ...page, events: [] }` },
  { name: 'a2a-fill-caret-captured-late', file: 'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
    before: 'onFill={() => onFill(async () => (await readForAction(item.envelope.messageId)).envelope.body)}',
    after: 'onFill={async () => onFill((await readForAction(item.envelope.messageId)).envelope.body)}' },

  { name: 'notify-original-mid-replaced', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: 'api.sessions.notifyMessage(reference, messageId, intent.operationId)', after: "api.sessions.notifyMessage(reference, 'replacement-mid', intent.operationId)" },
  { name: 'notify-action-id-reused', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: 'operationId: crypto.randomUUID(), createdAt:', after: "operationId: 'reused-notification-action', createdAt:" },
  { name: 'notify-refresh-replays', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: 'const { record } = await api.sessions.inspectMessageNotification(original, intent.messageId, key)',
    after: 'const { input: record } = await api.sessions.notifyMessage(original, intent.messageId, intent.operationId)' },
  { name: 'notify-unrelated-producer-ack', file: 'apps/desktop/src/renderer/src/lib/use-mailbox-notifications.tsx',
    before: "content?.a2aNotificationId !== intent.operationId", after: 'false' },

  { name: 'automation-object-replaced', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: "const ThemeObjectAutomationIcon = semanticIconComponent('object.automation')", after: "const ThemeObjectAutomationIcon = semanticIconComponent('action.repeat')" },
  { name: 'journal-query-disconnected', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: "query={inputHistory?.history.query ?? ''} selection=", after: "query={''} selection=" },
  { name: 'history-refresh-disconnected', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'void inputMailbox.refresh(); inputHistory.history.refresh()', after: 'void inputMailbox.refresh()' },
  { name: 'journal-refresh-disconnected', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'void inputMailbox.refresh(); inputHistory.history.refresh()', after: 'inputHistory.history.refresh()' },
  { name: 'journal-detail-disconnected', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'journalDetail ?? (selectedMessage ?', after: 'null ?? (selectedMessage ?' },
  { name: 'refresh-drops-earlier-history', file: 'packages/client-ui/src/lib/use-agent-input-history.ts',
    before: '...(cursor || retain ? old.messages : [])', after: '...(cursor ? old.messages : [])' },
  { name: 'journal-edit-loses-selection', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'onSelect={() => {}}', after: "onSelect={key => setSelection({ scope, folder: 'user', key: `queue:${key}` })}" },
  { name: 'automation-form-unmounted', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'presented={progressVisible || progressPresented}', after: 'presented={progressVisible}' },
  { name: 'automation-reading-discarded', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'setSelection(origin?.selection ?? null)', after: 'setSelection(null)' },
  { name: 'automation-visibility-disconnected', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'presented={progressVisible || progressPresented} visible={progressVisible}', after: 'presented={progressVisible || progressPresented}' },
  { name: 'calendar-error-keeps-loading', file: 'apps/desktop/src/renderer/src/components/CalendarScheduleControl.tsx',
    before: ': !source.error ? <p className="continuous-progress-control__help">Reading arrangements…</p> : null}',
    after: ': <p className="continuous-progress-control__help">Reading arrangements…</p>}' },
  { name: 'filtered-queue-neighbors-lost', file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: 'queued={pending} query={query}', after: 'queued={pending.filter(entry => !query || entry.text.includes(query))} query={query}' }
]
