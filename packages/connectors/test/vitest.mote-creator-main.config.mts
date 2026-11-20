import { defineConfig } from 'vitest/config'
import native from './vitest.mote-host.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const variants: Record<string, { path: string; before: string; after: string }> = {
  'skip-retained-intake': { path: 'packages/connectors/src/connection-receivers.ts', before: 'for (const id of page.ingressIds) retry.add(id)', after: 'void page.ingressIds' },
  'skip-priority': { path: 'packages/core/src/public-rpc-service.ts', before: "if (executor && executor.availability !== 'missing') return id", after: 'if (id === order[0]) return id' },
  'disconnect-creator-setup': { path: 'packages/connectors/src/mote-chat.ts', before: 'await owner.prepare(configuration.target, assertCreator)', after: 'await Promise.resolve()' },
  audience: { path: 'packages/connectors/src/mote-chat.ts', before: "if (shared) fail('MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE'", after: "if (false) fail('MOTE_CHAT_MAIN_EXTERNAL_AUDIENCE'" },
  alias: { path: 'packages/connectors/src/mote-chat.ts', before: 'if (executionRuntimeId && runtimeId) return executionRuntimeId === runtimeId', after: 'return binding.executionHostId === hostId' },
  'old-lane': { path: 'packages/connectors/src/mote-chat.ts', before: "if (lane?.binding && lane.binding.state !== 'detached') candidates.push(lane.binding)", after: 'void lane' },
  'local-reauth': { path: 'packages/connectors/src/durable-ingress.ts', before: 'this.assertInputAudience(record)', after: 'void record' },
  'remote-reauth': { path: 'packages/connectors/src/durable-ingress.ts', before: 'const issue = this.options.inputRoute?.(ingress)?.unavailable', after: 'const issue = undefined' },
  cold: { path: 'packages/connectors/src/mote-chat.ts', before: 'let session = await this.options.session!(source.current.hostId, source.current.sessionId)', after: "if (!this.options.executionRuntimeId?.(source.current.hostId)) return fail('MOTE_CHAT_MAIN_UNCONFIRMED', 'Cold metadata')\n      let session = await this.options.session!(source.current.hostId, source.current.sessionId)" },
  history: { path: 'packages/connectors/src/mote-chat-diagnosis.ts', before: 'code: moteChatDiagnosisCode(record.code), codeRecorded: record.code !== undefined', after: 'code: moteChatDiagnosisCode(record.code ?? routeCode), codeRecorded: record.code !== undefined || routeCode !== undefined' },
  creator: { path: 'packages/connectors/src/mote-chat.ts', before: 'if (same(configuration.creator, incoming.actor))', after: 'if (true)' },
  role: { path: 'packages/connectors/src/mote-chat.ts', before: 'await main.assertCurrent(source)', after: 'await Promise.resolve()' },
  'api-authority': { path: 'packages/connectors/src/mote-chat.ts', before: 'apiBinding(bindingId: string): RoomBinding | null {\n    const row', after: "apiBinding(bindingId: string): RoomBinding | null {\n    const main = this.store.mainAdmission(bindingId, 'binding'); if (main) return main.binding;\n    const row" },
  'host-main-consumer': { path: 'apps/host/src/connections.ts', before: 'main: creatorMain', after: 'main: undefined' },
  'restored-run': { path: 'packages/connectors/src/durable-ingress.ts', before: 'return result.session\n  }\n  private async continueInput', after: 'return session\n  }\n  private async continueInput' },
  'frozen-route': { path: 'packages/connectors/src/durable-ingress.ts', before: 'return this.options.inputRoute?.(record)?.binding ?? this.options.bindings.findActiveAudience', after: 'return this.options.bindings.findActiveAudience' }
}
const mutant = process.env.MOTE_CREATOR_MAIN_MUTANT, change = mutant ? variants[mutant] : undefined
if (mutant && !change) throw Error('Unknown Main intake mutation')
export default defineConfig({ ...native, cacheDir: '.local/state/mote-link-chat-review/main-cache-' + (mutant ?? 'original'),
  plugins: [{ name: 'creator-main-loaded-mutation', enforce: 'pre', resolveId(source) {
    if (source.startsWith('@agentmux/client-ui/')) {
      const subpath = './' + source.slice('@agentmux/client-ui/'.length)
      const manifest = JSON.parse(readFileSync(resolve(native.root!, 'packages/client-ui/package.json'), 'utf8'))
      const pattern = Object.keys(manifest.exports).filter(key => key.includes('*') && subpath.startsWith(key.split('*')[0])).sort((a, b) => b.length - a.length)[0]
      const entry = manifest.exports[subpath] ?? manifest.exports[pattern]
      if (entry?.types) return resolve(native.root!, 'packages/client-ui', entry.types.replace('*', subpath.slice(pattern?.split('*')[0].length ?? 0)))
    }
  }, transform(code, id) {
    const path = relative(native.root!, id.split('?')[0]!)
    if (!/^(apps\/host\/src|packages\/(core|connectors)\/src)\//u.test(path)) return
    if (process.env.MOTE_CREATOR_MAIN_SOURCE_LOADED) appendFileSync(process.env.MOTE_CREATOR_MAIN_SOURCE_LOADED, JSON.stringify({ path, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    if (path !== change?.path) return
    if (code.split(change.before).length !== 2) throw Error('Main intake mutation anchor is missing or ambiguous')
    const candidate = code.replace(change.before, change.after)
    if (process.env.MOTE_CREATOR_MAIN_LOADED) appendFileSync(process.env.MOTE_CREATOR_MAIN_LOADED, JSON.stringify({ mutant, path,
      originalSHA256: createHash('sha256').update(code).digest('hex'), candidateSHA256: createHash('sha256').update(candidate).digest('hex') }) + '\n')
    return candidate
  } }, ...native.plugins!],
  test: { ...native.test, include: ['packages/connectors/test/mote-creator-main.integration.test.ts'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
