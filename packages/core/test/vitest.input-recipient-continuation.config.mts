import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..'), connectorRequire = createRequire(resolve(root, 'packages/connectors/package.json'))
const mutation = process.env.AGENTMUX_TEST_RECIPIENT_MUTATION
if (mutation && !['recipient-denied', 'recipient-reenables-stopped', 'recipient-adopts-generation'].includes(mutation)) throw Error('Unknown recipient mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.local/channel-current-session-regression/input-recipient-continuation/cache', mutation ?? 'candidate'),
  plugins: [{ name: 'recipient-actual-owner', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/src\/.+\.ts$/u.test(path)) return
    let served = original
    const replace = (anchor: string, value: string) => { if (served.split(anchor).length !== 2) throw Error('Mutation needs one owner anchor: ' + anchor); served = served.replace(anchor, value) }
    if (path === 'packages/core/src/client.ts' && mutation === 'recipient-denied') replace('if (!recipientContinuation) await this.assertInputWaitingAuthor(saved.intent, input.caller)', 'await this.assertInputWaitingAuthor(saved.intent, input.caller)')
    if (path === 'packages/core/src/agent-global-message-queue.ts' && mutation === 'recipient-reenables-stopped') replace("if (mode === 'recipient-continue') throw", 'if (false) throw')
    if (path === 'packages/core/src/client.ts' && mutation === 'recipient-adopts-generation') {
      replace("if (isDeepStrictEqual(saved.control.ref, ref) && saved.control.state === 'enabled'", "if (saved.control.state === 'enabled'")
      replace('context = { ref, input, producer,', 'context = { ref: saved.control.ref, input, producer,')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_TEST_RECIPIENT_LOADED) appendFileSync(process.env.AGENTMUX_TEST_RECIPIENT_LOADED, JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(served), ...(served === original ? {} : { mutation }) }) + '\n')
    return served === original ? undefined : { code: served, map: null }
  }, resolveId(source, importer) {
    if (source === '@larksuiteoapi/node-sdk' || source === '@discordjs/rest') return connectorRequire.resolve(source)
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
    if (source.startsWith('.') && importer) { const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u); if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts') }
  } }], test: { environment: 'node', globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/input-recipient-continuation.test.ts'], testTimeout: 90_000, hookTimeout: 20_000 } })
