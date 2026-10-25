import { memo, useMemo, type Ref } from 'react'
import { ConversationMessage } from '@agentmux/client-ui'
import type { ConversationMessageProps } from '@agentmux/client-ui/components/ConversationMessage'
import type { AgentProviderSessionHistoryPage } from '@agentmux/core'

/** Catalog and row-preview updates do not change this original history page. */
export const LauncherResumeConversation = memo(function LauncherResumeConversation({ page, sourceKey, workspacePath, readHistoryResource, lastMessageRef }: {
  page: AgentProviderSessionHistoryPage
  sourceKey: string
  workspacePath: string
  readHistoryResource: NonNullable<ConversationMessageProps['readHistoryResource']>
  lastMessageRef: Ref<HTMLElement>
}) {
  const messages = useMemo(() => page.items.filter(item => item.kind === 'user-message' || item.kind === 'assistant-message'), [page])
  return <>
    {messages.map((item, index) => <article key={`${sourceKey}:${item.id}`} ref={index === messages.length - 1 ? lastMessageRef : undefined} className="launcher-resume__message">
      <ConversationMessage compact content={item.contentParts} messageId={item.id} providerId={page.source.providerId}
        {...(item.questionAnswers ? { questionAnswers: item.questionAnswers } : {})}
        {...(item.questionDiagnostic ? { questionDiagnostic: item.questionDiagnostic } : {})}
        name={item.kind === 'user-message' ? 'Input' : 'Assistant'} workspaceRoot={workspacePath}
        nativeResourceRecord={{ source: page.source, recordId: item.id, ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }}
        readHistoryResource={readHistoryResource} />
    </article>)}
    {!messages.length ? <p className="launcher-resume__muted">No user or assistant messages on this page.</p> : null}
  </>
})
