import { defineConfig } from 'vitest/config'
import source from './vitest.channel-history.config.mts'

export default defineConfig({ ...source, cacheDir: source.cacheDir + '-group-initialization', plugins: [...source.plugins!, {
  name: 'group-initialization-source-mutation', enforce: 'pre',
  transform(code, id) {
    if (!process.env.AGENTMUX_TEST_GROUP_INPUT_MUTATION || !id.split('?')[0]!.endsWith('/connectors/src/durable-ingress.ts')) return
    const anchor = "return this.options.inputTarget?.(record, binding) ?? binding.inputTarget ?? { kind: 'session-conversation' }"
    if (code.split(anchor).length !== 2) throw new Error('Group input target mutation must load exactly one actual owner')
    return { code: code.replace(anchor, anchor.replace('session-conversation', 'manual-actor')), map: null }
  }
}], test: { ...source.test, include: ['packages/connectors/test/group-input-initialization.test.ts'], maxWorkers: 1, testTimeout: 20000 } })
