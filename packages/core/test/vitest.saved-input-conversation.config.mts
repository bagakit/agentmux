import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.AGENTMUX_SAVED_INPUT_MUTANT
const marker = process.env.AGENTMUX_SAVED_INPUT_LOADED
const dependency = createRequire(resolve(root, 'packages/connectors/package.json'))
const mutations: Record<string, [string, string, string]> = {
  'disconnect-original-record': ['packages/core/src/client.ts', "await this.persistAndPublishTimeline({ type: 'upsert', agentSessionId: key.agentSessionId, item },", "return; await this.persistAndPublishTimeline({ type: 'upsert', agentSessionId: key.agentSessionId, item },"],
  'replace-original-key': ['packages/core/src/client.ts', 'const recordId = `prompt:${key.submissionId}`, original =', 'const recordId = `prompt:${key.submissionId}:${receipt.status}`, original ='],
  'pretend-native-admission': ['packages/core/src/client.ts', 'inputSubmission: { status: receipt.status, observation: receipt.observation },', "inputSubmission: { status: 'admitted', observation: receipt.observation },"],
  'reject-after-effect-read': ['packages/core/src/client.ts', '} catch (error) { this.publishInputConversationFailure(inputRef, error); return }', '} catch (error) { throw error }'],
  'skip-memory-pending-keys': ['packages/core/src/agent-session-store.ts', '.sort((a, b) => a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0).slice(0, 101)', '.sort((a, b) => a.item.id.localeCompare(b.item.id)).slice(0, 101)'],
  'ignore-input-source-failure': ['packages/core/src/client-event-publisher.ts', "event.type === 'agent-error' && event.code === 'AGENT_INPUT_CONVERSATION_UNCONFIRMED'", "event.type === 'agent-error' && event.code === 'MUTATED_SOURCE_FAILURE'"],
  'ignore-input-source-intake': ['packages/core/src/client-event-publisher.ts', "if (event.type === 'agent-input') return event.receipt.key.agentSessionId", "if (event.type === 'agent-input') return undefined"],
  'forget-receipt-recovery': ['packages/core/src/client.ts', 'this.inputConversationRecovered.delete(key.agentSessionId)', 'false'],
  'forget-pending-recovery': ['packages/core/src/client.ts', 'if (!saved || !original?.inputOrigin) throw new AgentMuxError', 'if (!saved || !original?.inputOrigin) continue; if (false) throw new AgentMuxError'],
  'rewrite-saved-original': ['packages/core/src/session-timeline-reducer.ts', 'if (previous.inputOrigin && mutation.content !== undefined && mutation.content !== previous.content)', 'if (false && previous.inputOrigin && mutation.content !== undefined && mutation.content !== previous.content)'],
  'ignore-journal-cut': ['packages/connectors/src/publication-content.ts', 'if (inputOrigin && (!start.inputJournal ||', 'if (false && inputOrigin && (!start.inputJournal ||']
}
if (mutant && !mutations[mutant]) throw Error('Unknown saved Input source mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/saved-input-conversation', mutant ?? 'positive'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { conditions: ['node', 'import', 'default'], alias: ['@larksuiteoapi/node-sdk', '@discordjs/rest'].map(find => ({ find, replacement: dependency.resolve(find) })) },
  plugins: [{ name: 'actual-saved-input-owner', enforce: 'pre', resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source === '@agentmux/client-ui' || source.startsWith('@agentmux/client-ui/')) {
      const key = '.' + source.slice('@agentmux/client-ui'.length)
      const exports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
      const pattern = Object.keys(exports).sort((a, b) => b.length - a.length).find(value => value.endsWith('*') && key.startsWith(value.slice(0, -1)))
      const entry = exports[key] ?? (pattern ? exports[pattern] : undefined)
      const target = typeof entry === 'string' ? entry : entry?.browser ?? entry?.import
      if (target) return resolve(root, 'packages/client-ui', pattern && !exports[key] ? target.replace('*', key.slice(pattern.length - 1)) : target)
    }
    if (source.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const path = resolve(dirname(importer), source), match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }, transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:packages\/(?:core|connectors|client-ui)\/src\/|apps\/(?:desktop|mobile)\/src\/)/u.test(path) || !/\.[cm]?[jt]sx?$/u.test(path)) return
    let output = input
    const selected = mutant ? mutations[mutant] : undefined
    if (selected?.[0] === path) {
      if (input.split(selected[1]).length !== 2) throw Error('Saved Input mutation anchor changed: ' + mutant)
      output = input.replace(selected[1], selected[2])
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (marker) {
      const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : mutant })
      return { code: "import { appendFileSync as __savedInputMark } from 'node:fs'; __savedInputMark(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
    }
    return input === output ? undefined : { code: output, map: null }
  } }], test: { environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/saved-input-conversation.test.ts', 'apps/desktop/test/channel-saved-input-consumer.test.tsx'], testTimeout: 30_000 } })
