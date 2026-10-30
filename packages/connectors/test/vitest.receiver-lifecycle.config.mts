import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.user-cards.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.RECEIVER_MUTANT
const changes = {
  watchdog: ['packages/connectors/src/adapters/feishu/index.ts', 'wsConfig: { pingTimeout: RECEIVER_PONG_SECONDS }', 'wsConfig: {}'],
  terminal: ['packages/connectors/src/connection-receivers.ts', 'if (end?.automatic === true &&', 'if (false && end?.automatic === true &&']
} as const
if (mutant && !(mutant in changes)) throw Error('Unknown original receiver mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/receiver-lifecycle'),
  plugins: [...original.plugins ?? [], { name: 'loaded-receiver-lifecycle', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^packages\/(core|connectors)\/src\/.+\.ts$/u.test(file)) return
    let output = input
    const change = mutant ? changes[mutant as keyof typeof changes] : undefined
    if (change?.[0] === file) {
      if (input.split(change[1]).length !== 2) throw Error('Original receiver mutation anchor missing')
      output = input.replace(change[1], change[2])
    }
    if (process.env.RECEIVER_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = JSON.stringify({ file, source: sha(input), loaded: sha(output), mutation: output !== input ? mutant : null }) + '\n'
      return { code: "import {appendFileSync as __receiverMark} from 'node:fs'; __receiverMark(" + JSON.stringify(process.env.RECEIVER_LOADED) + ',' + JSON.stringify(row) + ');\n' + output, map: null }
    }
    return input === output ? undefined : { code: output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/receiver-lifecycle-consumer.test.ts'], testTimeout: 60000, passWithNoTests: false } })
