import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import parser, { type Token } from 'stream-json/parser.js'

const stopFailureFields = new Set(['hookEventName', 'sessionId', 'promptId', 'error', 'errorDetails', 'lastAssistantMessage', 'subagentType'])

/** The native error hook can contain a large conversation. Only its original identity and error are needed. */
export async function readGrokStopFailure(source: AsyncIterable<Buffer>): Promise<Record<string, string>> {
  const rejected = () => new Error('Agent hook input exceeds the AgentMux limit.')
  async function* bounded() {
    let bytes = 0
    for await (const part of source) {
      bytes += part.byteLength
      if (bytes > 16 * 1024 * 1024) throw rejected()
      yield part
    }
  }
  const selected: Record<string, string> = {}, seen = new Set<string>()
  let depth = 0, key = '', current = '', field = '', overflow = false
  await pipeline(Readable.from(bounded()), parser.asStream({ jsonStreaming: false, packKeys: true, streamKeys: false,
    packStrings: false, streamStrings: true, packNumbers: false, streamNumbers: false }), async (tokens: AsyncIterable<Token>) => {
    for await (const token of tokens) {
      if (token.name === 'startObject' || token.name === 'startArray') depth++
      else if (token.name === 'endObject' || token.name === 'endArray') depth--
      else if (token.name === 'keyValue' && depth === 1) {
        key = stopFailureFields.has(token.value) ? token.value : ''
        if (key && seen.has(key)) throw rejected()
        if (key) seen.add(key)
      } else if (token.name === 'startString') {
        field = depth === 1 ? key : ''; current = ''; overflow = false
      } else if (token.name === 'stringChunk' && field && !overflow) {
        if (current.length + token.value.length > 4096) overflow = true
        else current += token.value
      } else if (token.name === 'endString' && field) {
        if (!overflow) selected[field] = current
        field = ''
      }
    }
  })
  if (selected.hookEventName !== 'stop_failure' || !selected.sessionId || seen.has('subagentType') && selected.subagentType === undefined) throw rejected()
  return selected
}
