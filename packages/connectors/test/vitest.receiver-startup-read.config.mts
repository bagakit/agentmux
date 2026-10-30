import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.user-cards.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const selected = process.env.RECEIVER_STARTUP_MUTANT
const owner = 'packages/connectors/src/adapters/feishu/index.ts'
const anchor = 'receiver.botOpenId = await this.withReadClient(config, credential, client => this.bot(client), signal)'
const changes = {
  'drop-startup-read': anchor.replace('this.withReadClient', 'this.withClient'),
  'drop-receiver-signal': anchor.replace(', signal)', ')')
} as const
if (selected && !(selected in changes)) throw Error('Unknown original startup read mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/receiver-startup-read'),
  plugins: [...original.plugins!, { name: 'loaded-receiver-startup-read', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    let output = input
    if (selected && file === owner) {
      if (input.split(anchor).length !== 2) throw Error('Original startup call mutation boundary changed')
      output = input.replace(anchor, changes[selected as keyof typeof changes])
    }
    const marker = process.env.RECEIVER_STARTUP_LOADED
    if (marker && [owner, 'packages/connectors/src/connection-receivers.ts', 'packages/core/src/observation-read.ts', 'packages/core/src/client.ts'].includes(file)) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : selected }
      return { code: "import {appendFileSync as __startupLoaded} from 'node:fs'; __startupLoaded(" + JSON.stringify(marker) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output, map: null }
    }
    return input === output ? undefined : { code: output, map: null }
  } }],
  test: { ...original.test, include: ['packages/connectors/test/receiver-startup-read-consumer.test.ts'],
    globalSetup: [], passWithNoTests: false, fileParallelism: false, testTimeout: 60_000 }
})
