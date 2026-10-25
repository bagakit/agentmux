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
  if (metrics?.durationMs !== undefined) parts.push(duration(metrics.durationMs))
  for (const [field, label] of [['totalTokens', '合计'], ['outputTokens', '输出'], ['inputTokens', '输入']] as const) {
    const value = metrics?.usage?.[field]
    if (value === undefined) continue
    parts.push(`${label} ${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens`)
    break
  }
  if (parts.length) parts.unshift(metrics?.scope === 'response' ? '本次响应' : '本轮')
  if (metadata.outcome) parts.push({ completed: '本轮已结束', interrupted: '本轮中断', failed: '本轮失败' }[metadata.outcome])
  return parts.length ? [{ tag: 'hr', margin: '4px 0px' },
    { tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: parts.join(' · '),
      text_size: 'notation', text_color: 'grey', lines: 1 } }] : []
}

/** Budget-only maximum numeric display, never stored or published as facts. */
export function feishuReplyFooterBudget(metadata: Readonly<ReplyPublicationMetadata>): ReplyPublicationMetadata {
  return { agentSessionId: metadata.agentSessionId, outcome: 'completed',
    metrics: { scope: 'response', durationMs: Number.MAX_VALUE, usage: { outputTokens: Number.MAX_VALUE } } }
}
