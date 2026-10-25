import type { AgentMuxRunInputData } from './types.js'

// Classify the whole transport payload without decoding binary mouse coordinates or
// allocating per report. This grants no input authority: the original preclaim still
// requires the exact Runtime ACK and a fresh target verification.
export function isTerminalMouseReportPayload(data: AgentMuxRunInputData): boolean {
  const string = typeof data === 'string'
  const byte = (index: number): number => string ? data.charCodeAt(index) : data[index]!
  let offset = 0
  while (offset < data.length) {
    if (byte(offset++) !== 27 || byte(offset++) !== 91) return false
    const format = byte(offset++)
    if (format === 77) {
      if (offset + 3 > data.length) return false
      const button = byte(offset++), col = byte(offset++), row = byte(offset++)
      // The legacy encoder uses binary bytes; non-ASCII JS strings would be
      // UTF-8 encoded into different bytes on the wire. Zero coordinates are invalid.
      if (button < 32 || col < 33 || row < 33 || button > 255 || col > 255 || row > 255 ||
          string && (button > 127 || col > 127 || row > 127)) return false
    } else if (format === 60) {
      for (let field = 0; field < 3; field++) {
        let value = 0, digits = 0
        while (offset < data.length && byte(offset) >= 48 && byte(offset) <= 57) {
          value = value * 10 + byte(offset++) - 48
          if (!Number.isSafeInteger(value)) return false
          digits++
        }
        if (!digits || (field === 0 ? value > 255 : value < 1)) return false
        if (field < 2 && byte(offset++) !== 59) return false
      }
      const action = byte(offset++)
      if (action !== 77 && action !== 109) return false
    } else return false
  }
  return offset === data.length && offset > 0
}
