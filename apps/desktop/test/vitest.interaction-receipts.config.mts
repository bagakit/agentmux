import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { mergeConfig } from 'vitest/config'
import base from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const trace = process.env.AGENTMUX_TEST_OUTBOX_REFERENCE_MUTATION
const file = 'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx'
const needle = 'isOriginalInputWaitStopped(input, entry.inputStopReceipt)'
const replacement = "entry.inputStopReceipt?.outcome === 'stopped-before-dispatch' && entry.inputStopReceipt.ref.waitGeneration === input.ref.waitGeneration"
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

export default mergeConfig(base, { plugins: [{
  name: 'outbox-foreign-wait-stop',
  enforce: 'pre',
  transform(code: string, id: string) {
    if (!trace || relative(root, id.split('?')[0]!) !== file) return
    if (code.split(needle).length !== 2) throw new Error('The original Outbox stop check was not found exactly once.')
    const mutated = code.replace(needle, replacement)
    appendFileSync(trace, JSON.stringify({ file, before: hash(code), after: hash(mutated) }) + '\n')
    return mutated
  }
}] })
