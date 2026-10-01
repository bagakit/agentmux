import { capturePerformancePanel } from '../performance-panel/capture.mjs'

export function captureCustomToolkit({ root, evidence }) {
  return capturePerformancePanel({ root, evidence, captureScope: 'toolkit', fixtureName: 'toolkit-custom-ui' })
}
