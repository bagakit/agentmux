import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
const owner = resolve(import.meta.dirname, '../src/delegations.ts')
const mutants = {
  'require-input': ["record(value, 'delegation.attention', attentionKeys, ['inputEpoch'])", "record(value, 'delegation.attention', attentionKeys)"],
  'require-snapshot': ["[...attentionKeys, 'preparedAt', 'attemptedAt'], ['inputEpoch', 'attemptedAt'])", "[...attentionKeys, 'preparedAt', 'attemptedAt'], ['attemptedAt'])"]
} as const
const mutation = process.env.ATTENTION_OPTIONAL_MUTATION as keyof typeof mutants | undefined
if (mutation && !mutants[mutation]) throw Error('Unknown original attention mutation')
export default defineConfig({ plugins: [{ name: 'actual-attention-qualification', enforce: 'pre', transform(source, id) {
  if (id.split('?')[0] !== owner) return
  const sha = (value: string) => createHash('sha256').update(value).digest('hex'), originalSHA256 = sha(source)
  if (mutation) { const [anchor, replacement] = mutants[mutation]; if (source.split(anchor).length !== 2) throw Error('One actual reader anchor required'); source = source.replace(anchor, replacement) }
  if (process.env.ATTENTION_OPTIONAL_LOADED) appendFileSync(process.env.ATTENTION_OPTIONAL_LOADED, JSON.stringify({file: 'packages/demand/src/delegations.ts', originalSHA256, loadedSHA256: sha(source), mutation: mutation ?? null}) + '\n')
  return source
} }], test: { include: ['packages/demand/test/attention-optional-qualification.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
