import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string, string]> = {
  "forget-native-source-key": ["packages/core/src/native-input-adoption.ts", "plan.sourceId !== nativeInputSourceId(source)", "false"],
  "foreign-token": [
    "packages/core/src/native-input-adoption.ts",
    "plan.clientCorrelation !== native.clientCorrelation ||",
    "false ||"
  ],
  "provider-forged-adoption": [
    "packages/core/src/native-input-adoption.ts",
    "const original = item.conversation ? { ...item, conversation } : item",
    "const original = item"
  ],
  "first-native-wins": [
    "packages/core/src/conversation-stream.ts",
    "candidates?.length === 1 && candidates[0]!.key && !unconfirmed && !unconfirmedKeys.has(key) && !ambiguous.has(key)",
    "!!candidates?.length && !unconfirmed"
  ],
  "forget-retained-counterevidence": [
    "packages/core/src/conversation-input-witness-index.ts",
    "new ConversationInputWitnessIndex(this)",
    "new ConversationInputWitnessIndex()"
  ],
  "witness-overflow": [
    "packages/core/src/conversation-input-witness-index.ts",
    "return { witnesses, unconfirmedKeys }",
    "return { witnesses, unconfirmedKeys, ...(this.records.size + (this.parent?.records.size ?? 0) > 1200 ? { unconfirmed: true as const } : {}) }"
  ],
  "changed-original-witness": [
    "packages/core/src/conversation-stream.ts",
    "if (!next || next.semanticItemId !== fact.semanticItemId || conversationInputWitnessGroup(next) !== conversationInputWitnessGroup(fact) ||\n        !!fact.key && conversationInputWitnessKey(next) !== conversationInputWitnessKey(fact))",
    "if (false)"
  ],
  "incomplete-window-validation": [
    "packages/core/src/conversation-changes.ts",
    "if (target ? !actual || actual.kind !== 'same-event' || !same(target, actual.to) : actual !== undefined) return bad('Native adoption contradicts the complete accepted window or its retained counterevidence.')",
    "if (false) return bad('Native adoption contradicts the complete accepted window or its retained counterevidence.')"
  ],
  "receipt-correlation": [
    "packages/client-ui/src/lib/input-receipt-projection.ts",
    "native.threadId, native.expectedTurnId, native.clientCorrelation, input?.kind, input?.operation, input?.protocolId, input?.sourceId,\n      input?.actorId, input?.threadId, input?.expectedTurnId, input?.clientCorrelation]",
    "native.threadId, native.expectedTurnId, input?.kind, input?.operation, input?.protocolId, input?.sourceId,\n      input?.actorId, input?.threadId, input?.expectedTurnId]"
  ],
  "discard-unconfirmed-candidate": [
    "packages/core/src/conversation-stream.ts",
    "(!adopted || conversationInputKey(record))",
    "!!adopted && !!conversationInputKey(record)"
  ],
  "forget-unconfirmed-retained": [
    "packages/core/src/conversation-input-witness-index.ts",
    "if (!next) continue",
    "if (!next?.key) continue"
  ],
  "drop-valid-diagnostic": [
    "packages/core/src/conversation-provenance.ts",
    "try { return { conversation: parseConversationProvenance(value.conversation),\n    ...(value.conversationDiagnostic === undefined ? {} : { conversationDiagnostic: value.conversationDiagnostic as NonNullable<AgentSessionHistoryItem['conversationDiagnostic']> }) } }",
    "try { return { conversation: parseConversationProvenance(value.conversation) } }"
  ]
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/state/conversation-unified-timeline/T-020-vitest-cache', process.env.AGENTMUX_NATIVE_ADOPTION_MUTATION ?? 'positive'),
  plugins: [{ name: 'actual-native-adoption-source', enforce: 'pre',
    resolveId(source, importer) {
      if (process.env.AGENTMUX_NATIVE_ADOPTION_COMPILED === '1') return
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const exports = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
        const entry = exports['./' + source.slice('@agentmux/core/'.length)]?.import as string | undefined
        if (entry?.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
      }
      if (!importer || !source.startsWith('.')) return
      const path = resolve(dirname(importer), source)
      const match = path.match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
    },
    transform(code, id) {
      const path = relative(root, id.split('?')[0]!)
      if ((!path.startsWith('packages/core/src/') && path !== 'packages/client-ui/src/lib/input-receipt-projection.ts') || !path.endsWith('.ts')) return
      const original = code, mutation = process.env.AGENTMUX_NATIVE_ADOPTION_MUTATION
      const change = mutation ? mutants[mutation] : undefined
      if (mutation && !change) throw new Error('Unknown native input source mutation')
      if (change && path === change[0]) {
        if (code.split(change[1]).length !== 2) throw new Error('Native input mutation anchor is not unique: ' + mutation)
        code = code.replace(change[1], change[2])
      }
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      if (process.env.AGENTMUX_NATIVE_ADOPTION_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_ADOPTION_LOADED, JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/native-input-adoption.test.ts', 'packages/client-ui/test/input-receipt-identity.test.tsx'], testTimeout: 30_000 } })
