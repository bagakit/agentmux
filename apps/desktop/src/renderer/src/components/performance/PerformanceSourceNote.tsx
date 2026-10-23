import type { MetricsSource } from '@agentmux/core/control'

export function PerformanceSourceNote({ source }: { source: MetricsSource<unknown> | undefined }) {
  if (!source) return <p className="performance-state">Waiting for the first observation.</p>
  if (source.state === 'available') return null
  return <p className="performance-state" data-tone={source.state === 'pending' ? 'neutral' : 'warning'}>
    {source.state === 'pending' ? 'Collecting this source…' : source.state === 'stale' ? 'Previous reading' : 'Source unavailable'}
    {source.reason ? ` · ${source.reason}` : ''}
  </p>
}
