import type { VegaMode } from './vega-spec'
export type ChartEvent = { source: 'view' | 'window' | 'container'; type: string; x: number; y: number; [key: string]: unknown }
export type ChartBinding = { signal: string; input: string; value: unknown; name?: string; options?: unknown[]; labels?: string[]; min?: number; max?: number; step?: number }
export type ChartSnapshot = { svg: string; width: number; height: number; bindings: ChartBinding[]; events: { source: ChartEvent['source']; type: string }[]; tooltip?: string }
export type ChartRequest = ({ action: 'start'; content: string; mode: VegaMode } | { action: 'event'; event: ChartEvent } | { action: 'signal'; name: string; value: unknown } | { action: 'resize'; width: number; height?: number } | { action: 'resource'; id: number; value?: unknown; error?: string } | { action: 'dispose' }) & { serial?: number }
