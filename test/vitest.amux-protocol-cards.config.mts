import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import overview from '../apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts'

const scope = process.env.AMUX_PROTOCOL_SCOPE ?? 'reader'
const tests = {
  reader: ['packages/core/test/amux-protocol-catalog.test.ts', 'packages/client-ui/test/amux-protocol-cards.test.tsx',
    'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-message-leading-context.test.ts', 'packages/core/test/agent-message-reference-reading.test.ts'],
  cards: ['packages/client-ui/test/amux-protocol-reading.test.tsx', 'packages/client-ui/test/a2a-reference-reading.test.tsx',
    'packages/client-ui/test/conversation-leading-context.test.tsx', 'apps/desktop/test/amux-protocol-consumers.test.tsx',
    'apps/desktop/test/conversation-message-wrapper.integration.test.tsx'],
  settings: ['apps/desktop/test/amux-protocol-settings.test.tsx']
}
const mutations = {
  'drop-generic': ['packages/core/src/agent-message-render.ts', 'const protocol = parseStandaloneProtocol(text)', 'const protocol = null'],
  'allow-invalid-known': ['packages/core/src/agent-message-render.ts', 'if (Object.values(AMUX_PROTOCOL_DEFINITIONS).some(definition => definition.tag === tag)) return null', 'if (false) return null'],
  'lose-opaque-body': ['packages/core/src/agent-message-render.ts', 'const body = selfClosing ? null : text.slice(header[0].length, -closing.length)', 'const body = null'],
  'ignore-body-boundary': ['packages/client-ui/src/components/ConversationMessage.tsx', "contentBoundary !== 'wire' || hasQuestionAnswers", 'false || hasQuestionAnswers'],
  'skip-resource-reader': ['packages/client-ui/src/components/ConversationResourceText.tsx', 'const parsed = parseAgentMuxMessagePrefix(text)', 'const parsed = null'],
  'skip-special-card': ['packages/client-ui/src/components/ConversationInputText.tsx', "const a2a = prefix?.kind === 'references' || prefix?.declaredMessageId !== undefined", 'const a2a = false'],
  'lose-question-resource-boundary': ['packages/client-ui/src/components/ConversationMessage.tsx', "contentBoundary={hasQuestionAnswers ? 'body' : contentBoundary}", 'contentBoundary={contentBoundary}'],
  'unregister-settings': ['apps/desktop/src/renderer/src/components/settings/settings-modules.ts', '  amuxProtocolsSettingsModule,', ''],
  'omit-search-target': ['apps/desktop/src/renderer/src/components/settings/modules/amux-protocols.tsx', 'searchTargets: AGENTMUX_PROTOCOL_CATALOG.map(entry => (', 'searchTargets: AGENTMUX_PROTOCOL_CATALOG.slice(0, -1).map(entry => ('],
  'eager-preview': ['apps/desktop/src/renderer/src/components/settings/modules/amux-protocols.tsx', '{open && active ? <div', '{active ? <div']
} as Record<string, readonly [string, string, string]>

const clientPackage = resolve(overview.root!, 'packages/client-ui')
const clientExports = JSON.parse(readFileSync(resolve(clientPackage, 'package.json'), 'utf8')).exports
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const clientAliases = Object.entries(clientExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser?: string; types: string }).browser ?? (value as { types: string }).types
  return { find: new RegExp('^@agentmux/client-ui' + (key === '.' ? '' : key.slice(1)).split('*').map(escaped).join('(.+)') + '$'),
    replacement: resolve(clientPackage, target.replace('*', '$1')) }
})

export default defineConfig({
  ...overview,
  resolve: { ...overview.resolve, alias: [...(overview.resolve!.alias as []), ...clientAliases], conditions: ['browser'] },
  plugins: [{ name: 'amux-protocol-source-proof', enforce: 'pre', resolveId(id) {
    const match = /^@agentmux\/([^/]+)(.*)$/u.exec(id)
    if (!match) return
    const directory = resolve(overview.root!, 'packages', match[1]!), manifest = resolve(directory, 'package.json')
    if (!existsSync(manifest)) return
    const exported = JSON.parse(readFileSync(manifest, 'utf8')).exports?.[match[2] ? '.' + match[2] : '.']
    const entry = typeof exported === 'string' ? exported : exported?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
  }, transform(code, id) {
    const file = id.split('?')[0]!
    if (/\/(?:packages\/(?:core|client-ui)|apps\/(?:desktop|mobile))\/(?:src|test)\//u.test(file) && !file.startsWith(overview.root! + '/')) {
      throw new Error(`Source consumer escaped this candidate: ${file}`)
    }
    if (!file.startsWith(overview.root!) || !/\/(packages|apps)\/.*\.(ts|tsx)$/u.test(file)) return
    const relative = file.slice(overview.root!.length + 1)
    const mutation = process.env.AMUX_PROTOCOL_MUTATION ? mutations[process.env.AMUX_PROTOCOL_MUTATION] : undefined
    const original = code
    if (mutation && relative === mutation[0]) {
      if (!code.includes(mutation[1])) throw new Error(`Mutation anchor missing: ${relative}`)
      code = code.replace(mutation[1], mutation[2])
    }
    if (process.env.AMUX_PROTOCOL_LOADED) appendFileSync(process.env.AMUX_PROTOCOL_LOADED, JSON.stringify({ file: relative,
      sourceSHA256: createHash('sha256').update(original).digest('hex'), compilerInputSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...overview.test, include: tests[scope as keyof typeof tests] ?? [], maxWorkers: 1 }
})
