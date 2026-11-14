import { defineConfig } from 'vitest/config'
import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const root = process.cwd(), mutation = process.env.AGENTMUX_GROK_SYNTHETIC_MUTATION, loaded = process.env.AGENTMUX_GROK_SYNTHETIC_LOADED
export default defineConfig({ ...base, cacheDir: '.tmp/grok-synthetic-input/cache', plugins: [...base.plugins ?? [], {
  name: 'original-grok-synthetic-input', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/core/src/providers/grok-native-history.ts') return
    const needle = mutation === 'omit-purpose' ? ", recordPurpose: 'system-event' as const" : "isRecord(update._meta) && update._meta.syntheticPrompt === true"
    if (mutation && source.split(needle).length !== 2) throw Error('Grok source mutation must hit one actual owner contribution')
    const code = mutation ? source.replace(needle, mutation === 'omit-purpose' ? '' : 'false') : source
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (loaded) appendFileSync(loaded, JSON.stringify({ file, source: sha(source), consumed: sha(code), mutated: code !== source }) + '\n')
    return code
  }
}], test: { ...base.test, include: ['apps/desktop/test/grok-synthetic-input.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
