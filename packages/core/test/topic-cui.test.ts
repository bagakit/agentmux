import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { parseTopicParams, parseTopicResult, type TopicKnowledgeWrite } from '../src/public-rpc-topics'
import { parseRpcNativeResult } from '../src/rpc-native-codec'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help'
const category = { categoryId: '11111111-1111-4111-8111-111111111111', hostId: 'local', spaceId: JSON.stringify(['local', upstreamFixturePath('topics/category')]), directoryPath: upstreamFixturePath("topics/category"), title: '工作', revision: 'sha256:' + 'a'.repeat(64) }
describe('Topic typed public contract', () => {
  it('rejects spoofed envelopes, malformed revisions and inexact content identities before mutation', () => {
    for (const params of [{ categoryId: category.categoryId, title: 'Valid', caller: { id: 'spoof' } }, { categoryId: '../escape', title: 'Valid' }])
      expect(() => parseTopicParams('topic.category.create', params)).toThrow()
    expect(() => parseTopicParams('topic.move', { topicId: 'view:topic', categoryId: category.categoryId, expectedRevision: -1 })).toThrow()
    expect(() => parseTopicParams('topic.inspect', { topicId: 'self' })).toThrow()
    expect(() => parseTopicParams('topic.category.rename', { categoryId: category.categoryId, title: 'Valid', expectedRevision: 'latest' })).toThrow()
  })
  it('preserves exact original results and refuses a different category or unconfirmed save', () => {
    const params = { categoryId: category.categoryId, title: '工作' }, result = { category, diskDurability: 'confirmed' }
    expect(parseRpcNativeResult('topic.category.create', result, params)).toEqual(result)
    expect(() => parseTopicResult('topic.category.create', { ...result, category: { ...category, categoryId: '22222222-2222-4222-8222-222222222222' } }, params)).toThrow()
    expect(() => parseTopicResult('topic.category.create', { ...result, diskDurability: 'unconfirmed' }, params)).toThrow()
    expect(() => parseTopicResult('topic.migrate.apply', { spatialRevision: 1, backupPath: null, migratedTopicIds: ['self'], diskDurability: 'confirmed' }, { expectedRevision: 0 })).toThrow()
  })
  it('discovers actual executable commands in help and skill without replacing Notebook capabilities', () => {
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic category create')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic migrate preview')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux notebook ls')
    expect(agentMuxCommandHelp('topic.move')).toContain('--revision NUMBER')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic knowledge search')
    expect(agentMuxCommandHelp('topic.knowledge.write')).toContain('--input FILE|-')
  })
  it('requires typed original sources, exact revisions and bounded scopes for knowledge writes and results', () => {
    const input: TopicKnowledgeWrite = { topicId: 'view:topic', entryId: category.categoryId, title: 'Decision', content: 'A reviewed derivation.\nOriginal discussion retained.',
      form: 'derived', certainty: 'decision', sources: [{ kind: 'note', noteId: 'source-note', blockId: 'source-block' }], expectedRevision: null }
    expect(parseTopicParams('topic.knowledge.write', input)).toEqual(input)
    const spaceSource = { kind: 'space', zoneId: 'source-project-zone', tabId: 'source-chat', regionId: 'source-thread' }
    expect(parseTopicParams('topic.knowledge.write', { ...input, sources: [spaceSource] }).sources).toEqual([spaceSource])
    for (const bad of [{ ...input, form: 'reference', sources: [] }, { ...input, expectedRevision: 'latest' }, { ...input, certainty: 'guessed' },
      { ...input, sources: [{ kind: 'note', noteId: 'source-note', copiedChildren: [] }] }, { ...input, sources: [{ ...spaceSource, topicId: 'view:spoof' }] },
      { ...input, sources: [{ kind: 'space', regionId: 'source-thread' }] }, { ...input, sources: [{ kind: 'topic', topicId: 'self' }] },
      { ...input, content: 'x'.repeat(128 * 1024 + 1) }, { ...input, caller: { id: 'spoof' } }])
      expect(() => parseTopicParams('topic.knowledge.write', bad)).toThrow()
    expect(() => parseTopicParams('topic.knowledge.search', { query: '  ' })).toThrow()
    expect(() => parseTopicParams('topic.knowledge.ls', { topicId: input.topicId, limit: 0 })).toThrow()
    const { expectedRevision, ...authored } = input
    const entry = { ...authored, revision: category.revision, updatedAt: 1 }
    expect(parseRpcNativeResult('topic.knowledge.write', { entry, diskDurability: 'confirmed' }, input)).toEqual({ entry, diskDurability: 'confirmed' })
    expect(() => parseTopicResult('topic.knowledge.read', { entry: { ...entry, topicId: 'view:different' } }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.read', { entry: { ...entry, entryId: '22222222-2222-4222-8222-222222222222' } }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.write', { entry, diskDurability: 'unknown' }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.ls', { entries: [entry, entry], unavailable: [] }, { topicId: input.topicId, limit: 1 })).toThrow()
  })
})
