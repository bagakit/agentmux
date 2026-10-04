import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mergeConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const spec = JSON.parse(readFileSync(process.env.AGENTMUX_RECOVERY_ACTION_MUTANT!, 'utf8'))
const root = resolve(import.meta.dirname, '../../../../..')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default mergeConfig(base, { plugins: [{ name: 'loaded-recovery-action-counterexample', enforce: 'pre', transform(code, id) {
  if (id.split('?')[0] !== resolve(root, spec.file)) return
  const original = hash(code)
  for (const [from, to] of spec.replacements) {
    if (code.split(from).length !== 2) throw new Error('Counterexample source seam is missing or ambiguous: ' + spec.id)
    code = code.replace(from, to)
  }
  writeFileSync(spec.witness, JSON.stringify({ id: spec.id, file: spec.file, sourceSha256: original, loadedVariantSha256: hash(code) }))
  return { code, map: null }
} }] })
