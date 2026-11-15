import { defineConfig } from 'vitest/config'
import source from '../../desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'duplicate-send': ['apps/host/src/mote-group.ts', 'if (!fresh) return { message: await readMessage(message) }', 'if (false) return { message: await readMessage(message) }'],
  'drop-quote': ['apps/host/src/mote-group.ts', 'note: inputNote(message.groupId, key.submissionId, quoted)', 'note: inputNote(message.groupId, key.submissionId, undefined)'],
  'reply-admission': ['apps/host/src/mote-group.ts', 'if (!accepted(receipt) || fact?.userContent', 'if (fact?.userContent']
} as const
const variant = process.env.AMUX_MOTE_GROUP_MUTANT as keyof typeof variants | undefined
if (variant && !Object.hasOwn(variants, variant)) throw Error('Unknown Group mutation ' + variant)
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], {
  name: 'original-mote-group-mutation', enforce: 'pre', load(id) {
    if (!variant) return
    const [path, before, after] = variants[variant]
    if (id.split('?')[0] !== resolve(root, path)) return
    const body = readFileSync(id, 'utf8')
    if (body.split(before).length !== 2) throw Error('Original Group mutation anchor changed')
    return body.replace(before, after)
  }
}], test: { ...source.test, include: ['apps/host/test/mote-group.test.ts'], passWithNoTests: false,
  maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } })
