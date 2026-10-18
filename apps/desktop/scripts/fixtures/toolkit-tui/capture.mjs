import { capturePerformancePanel } from '../performance-panel/capture.mjs'
export const captureTuiToolkit = options => capturePerformancePanel({ ...options, captureScope: 'toolkit', fixtureName: 'toolkit-tui' })
