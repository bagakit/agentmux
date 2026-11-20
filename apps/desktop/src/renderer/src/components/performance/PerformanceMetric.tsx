import { PerformanceTrend } from './PerformanceTrend'

export function PerformanceMetric({ label, value, hint, points, color, sourceKey, unit = '%', compact = false, live = false, emptyLabel }: {
  label: string; value: string; hint: string; points?: { id: string; at: number; value: number | null }[]
  color: string; sourceKey?: string; unit?: '%' | 'KiB'; compact?: boolean; live?: boolean; emptyLabel?: string
}) {
  return <section className={compact ? 'performance-metric performance-live-metric' : 'performance-metric'}>
    <span className="performance-metric__label">{label}</span><strong key={value} className="performance-metric__value">{value}</strong><small>{hint}</small>
    {points ? <PerformanceTrend key={sourceKey} points={points} color={color} label={label} unit={unit} compact={compact} live={live} emptyLabel={emptyLabel} /> : null}
  </section>
}
