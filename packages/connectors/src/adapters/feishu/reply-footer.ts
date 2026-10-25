import type { ReplyPublicationMetadata } from '../../publication-reply-metadata.js'

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10}s`
  const seconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}h` : ''}${minutes || !hours ? `${minutes}m` : ''}${seconds % 60 ? `${seconds % 60}s` : ''}`
}

/** Display only: the Publication owner supplies exact native record/turn facts. */
export function feishuReplyFooter(metadata: Readonly<ReplyPublicationMetadata>): Record<string, unknown>[] {
  const metrics = metadata.metrics, parts: string[] = []
  if (metadata.outcome) parts.push({ completed: '本轮已结束', interrupted: '本轮中断', failed: '本轮失败' }[metadata.outcome])
  if (metrics?.durationMs !== undefined) parts.push(`${metrics.scope === 'response' ? '本次响应耗时' : '本轮耗时'} ${duration(metrics.durationMs)}`)
  if (metrics?.usage?.outputTokens !== undefined) parts.push(`${metrics.scope === 'response' ? '本次响应输出' : '本轮输出'} ${metrics.usage.outputTokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens`)
  return [
    { tag: 'hr', margin: '4px 0px' },
    ...(parts.length ? [{ tag: 'div', text_size: 'notation',
      text: { tag: 'plain_text', content: parts.join(' · '), text_size: 'notation', text_color: 'grey' } }] : []),
    { tag: 'button', type: 'text', size: 'small', margin: '0px',
      text: { tag: 'plain_text', content: '打开原对话' },
      icon: { tag: 'standard_icon', token: 'chat_outlined' },
      url: `amux://agent/${encodeURIComponent(metadata.agentSessionId)}` }
  ]
}

/** Budget-only maximum numeric display, never stored or published as facts. */
export function feishuReplyFooterBudget(metadata: Readonly<ReplyPublicationMetadata>): ReplyPublicationMetadata {
  return { agentSessionId: metadata.agentSessionId, outcome: 'completed',
    metrics: { scope: 'response', durationMs: Number.MAX_VALUE, usage: { outputTokens: Number.MAX_VALUE } } }
}
