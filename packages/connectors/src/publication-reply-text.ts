import type { ReplyPublicationMetadata } from './publication-reply-metadata.js'

/** Presentation only. All values and their scope come from the original Publication owner. */
export function publicationReplyText(metadata: Readonly<ReplyPublicationMetadata>): string {
  const metrics = metadata.metrics, parts: string[] = []
  if (metrics?.durationMs !== undefined) parts.push(metrics.durationMs < 1000 ? `${metrics.durationMs}ms` : `${Math.round(metrics.durationMs / 100) / 10}s`)
  for (const [key, label] of [['totalTokens', 'total'], ['outputTokens', 'output'], ['inputTokens', 'input']] as const) {
    const value = metrics?.usage?.[key]
    if (value === undefined) continue
    parts.push(`${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${label} tokens`)
    break
  }
  if (parts.length) parts.unshift(metrics?.scope === 'response' ? 'This response' : 'This turn')
  if (metadata.outcome) parts.push({ completed: 'Turn ended', interrupted: 'Turn interrupted', failed: 'Turn failed' }[metadata.outcome])
  return parts.join(' · ')
}
