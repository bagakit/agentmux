import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import host from '../../../apps/host/test/connection-owner-consumer.config.mts'

const root = host.root!, mutant = process.env.FEISHU_CJK_MUTANT
if (mutant && !['parser-disconnected', 'raw-budget-restored'].includes(mutant)) throw Error('Unknown CJK presentation mutation')
export default defineConfig({ ...host, cacheDir: resolve(root, '.cache/feishu-cjk-emphasis'), plugins: [{
  name: 'loaded-cjk-presentation', enforce: 'pre', resolveId(source) {
    if (source === '@agentmux/client-ui/theme') return resolve(root, 'packages/client-ui/src/theme/index.ts')
    if (source.startsWith('@agentmux/client-ui/note/')) return resolve(root, 'packages/client-ui/src/note', source.slice('@agentmux/client-ui/note/'.length) + '.ts')
    if (source.startsWith('@agentmux/client-ui/components/')) return resolve(root, 'packages/client-ui/src/components', source.slice('@agentmux/client-ui/components/'.length) + '.tsx')
    if (source.startsWith('@agentmux/client-ui/')) return resolve(root, 'packages/client-ui/src/lib', source.slice('@agentmux/client-ui/'.length) + '.ts')
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/(?:src|test)\/.+\.[cm]?[jt]s$/u.test(path)) return
    let output = input
    if (mutant === 'parser-disconnected' && path === 'packages/connectors/src/adapters/feishu/reply-card.ts') {
      const target = '.use(remarkCjkFriendly)'
      if (input.split(target).length !== 2) throw Error('CJK mutation requires its exact production parser connection')
      output = input.replace(target, '')
    }
    if (mutant === 'raw-budget-restored' && path === 'packages/connectors/src/adapters/feishu/publication.ts') {
      const target = 'const displayed = { ...payload, text: part.text,'
      if (input.split(target).length !== 2) throw Error('Raw budget mutation requires the exact native budget owner')
      output = input.replace(target, 'if (!/[\\r\\n]/u.test(part.text) && Buffer.byteLength(part.text) > FEISHU_MESSAGE_BODY_BYTES) return false; ' + target)
    }
    if (process.env.FEISHU_CJK_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, original: sha(input), loaded: sha(output), ...(input === output ? {} : { mutant }) }
      output = "import { appendFileSync as __cjkLoaded } from 'node:fs'; __cjkLoaded(" + JSON.stringify(process.env.FEISHU_CJK_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + output
    }
    return output === input ? undefined : { code: output, map: null }
  }
}, ...host.plugins!], test: { ...host.test,
  include: ['packages/connectors/test/feishu-cjk-consumer.test.ts', 'packages/connectors/test/feishu-role-card.test.ts'],
  ...(mutant ? { testNamePattern: mutant === 'parser-disconnected' ? 'default Host sends CJK emphasis' : 'default Host keeps a fitting normalized request' } : {})
} })
