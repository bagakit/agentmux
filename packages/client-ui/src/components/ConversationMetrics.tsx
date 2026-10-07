import type { ConversationMetricsObservation } from '../lib/conversation-metrics.js'
import { formatDuration } from '../lib/conversation-time.js'
import { SemanticIcon } from '../theme/icons.js'

export function conversationMetricsLabel({ metrics }: ConversationMetricsObservation): string {
  const scope = metrics.scope === 'turn' ? '本轮' : '本次响应'
  return metrics.status === 'failed' ? `${scope}失败`
    : metrics.status === 'interrupted' ? `${scope}已中断` : metrics.status === 'completed' ? scope : `${scope}记录`
}

export function ConversationMetricsInline({ observation }: { observation: ConversationMetricsObservation }) {
  const { durationMs, usage } = observation.metrics
  return <span className="conversation-metrics__inline">
    <span>{durationMs === undefined ? '耗时未记录' : `用时 ${formatDuration(durationMs)}`}</span>
    <span aria-hidden="true">·</span>
    <span>{usage?.outputTokens === undefined ? '输出用量未记录' : `输出 ${usage.outputTokens.toLocaleString()} tokens`}</span>
  </span>
}

export function ConversationMetricsDetails({ observation }: { observation: ConversationMetricsObservation }) {
  const { metrics, turnId, recordIds } = observation
  const fields = [
    ['输入', metrics.usage?.inputTokens], ['输出', metrics.usage?.outputTokens],
    ['合计', metrics.usage?.totalTokens], ['缓存输入', metrics.usage?.cachedInputTokens],
    ['推理输出', metrics.usage?.reasoningOutputTokens]
  ] as const
  return <div className="conversation-metrics__details">
    <p>{metrics.scope === 'turn' ? '原生整轮报告' : '原生单次响应报告'} · 仅披露已加载记录</p>
    <dl>
      {metrics.durationMs === undefined ? null : <div><dt>墙钟耗时</dt><dd>{metrics.durationMs.toLocaleString()} ms</dd></div>}
      {fields.map(([label, value]) => value === undefined ? null : <div key={label}><dt>{label}</dt><dd>{value.toLocaleString()} tokens</dd></div>)}
      <div><dt>结束方式</dt><dd>{metrics.status === 'completed' ? metrics.scope === 'turn' ? '原生回合已结束' : '原生响应已结束'
        : metrics.status === 'failed' ? '失败' : metrics.status === 'interrupted' ? '中断' : '未记录'}</dd></div>
      {turnId ? <div><dt>原回合</dt><dd><code>{turnId}</code></dd></div> : null}
      <div><dt>来源记录</dt><dd>{recordIds.map(id => <code key={id}>{id}</code>)}</dd></div>
    </dl>
  </div>
}

/** No process is invented for a response-only sample. Disclosure contains its actual recorded metrics. */
export function ConversationMetrics({ observation }: { observation: ConversationMetricsObservation }) {
  return <details className="conversation-metrics">
    <summary><SemanticIcon name="navigation.disclosure" size={12} className="conversation-metrics__chevron" /><span>{conversationMetricsLabel(observation)}</span><span aria-hidden="true">·</span><ConversationMetricsInline observation={observation} /></summary>
    <ConversationMetricsDetails observation={observation} />
  </details>
}
