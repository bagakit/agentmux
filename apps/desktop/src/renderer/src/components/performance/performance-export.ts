import type { RendererTraceResult } from '@agentmux/core/control'

export function downloadPerformanceBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
export function downloadPerformanceJSON(value: unknown, name: string) {
  downloadPerformanceBlob(new Blob([JSON.stringify(value)], { type: 'application/json' }), name)
}
/** Decode only on explicit export. The Renderer never inflates or parses the native timeline. */
export function downloadPerformanceTrace(trace: NonNullable<RendererTraceResult['trace']>) {
  const bytes = Uint8Array.from(atob(trace.data), character => character.charCodeAt(0))
  downloadPerformanceBlob(new Blob([bytes], { type: 'application/gzip' }), 'renderer-trace.json.gz')
}
