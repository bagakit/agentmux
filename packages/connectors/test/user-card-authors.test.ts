import { expect, it } from 'vitest'
import type { AgentInputSubmissionObservation, AgentSessionUserMessageAuthor } from '@agentmux/core'
import type { PublicationOperation } from '../src/publication-store.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { prepareDiscordPublication } from '../src/adapters/discord/render.js'
import { feishuConfig } from './fixtures/feishu.js'

const reference = { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'captured' as const, recordId: 'original-record' } }
const external: AgentSessionUserMessageAuthor = { kind: 'external', connectionId: 'original-connection',
  actor: { application: feishuConfig.application, idType: 'open_id', userId: 'original-person' }, externalConversationId: 'original-room',
  externalMessageId: 'original-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 }
function operation(authors?: AgentSessionUserMessageAuthor[], phase?: 'progress' | 'final'): PublicationOperation & { payload: Extract<PublicationOperation['payload'], { kind: 'speech' }> } {
  return { operationId: 'original-publication', projectionId: 'original-projection', sourceRevision: 'original-revision',
    bindingId: 'original-binding', bindingRevision: 1, reference, target: { connectionId: feishuConfig.connectionId,
      application: feishuConfig.application, externalConversationId: '300' }, effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending',
    payload: { kind: 'speech', text: 'Human user · via amux\nUser-authored **Agent reply** and <amux>literal</amux> 中文🙂',
      ...(phase ? { phase } : {}), ...(authors ? { relay: { sender: 'application', sources: authors.map(author => ({
        part: { record: reference, recordRevision: 'original-revision', selector: { kind: 'captured-field', field: 'content' } }, author })) } } : {}) } }
}

it.each([
  { authors: [{ kind: 'human' }], title: 'User', human: true },
  { authors: [{ kind: 'human' }, { kind: 'human' }], title: 'User', human: true },
  { authors: [], title: 'Unknown author', human: false },
  { authors: [{ kind: 'unknown' }], title: 'Unknown author', human: false },
  { authors: [external], title: 'External message', human: false },
  { authors: [{ kind: 'agent', agentSessionId: 'original-sender' }], title: 'Agent input', human: false },
  { authors: [{ kind: 'human' }, external], title: 'Mixed authors', human: false },
  { authors: [{ kind: 'human' }, { kind: 'unknown' }], title: 'Mixed authors', human: false }
] satisfies Array<{ authors: AgentSessionUserMessageAuthor[]; title: string; human: boolean }>)('both native cards preserve typed $title attribution without interpreting the authored body ($human)', ({ authors, title, human }) => {
  const original = operation(authors, 'progress'), snapshot = structuredClone(original)
  const feishu = new FeishuAdapter().publication.prepare(original)
  const card = JSON.parse(JSON.parse(feishu.request.body!).content)
  expect(card.header).toEqual({ title: { tag: 'plain_text', content: title + ' · via amux' }, template: human ? 'green' : 'grey' })
  expect(card.elements).toEqual([{ tag: 'div', text: { tag: 'plain_text', content: original.payload.text } }])
  const discord = JSON.parse(prepareDiscordPublication(original).request.body!)
  expect(discord.components[0].components[0].content).toBe('**' + title + ' · via amux**\n' + original.payload.text)
  expect(discord.components[0].accent_color).toBe(human ? 0x2e8b57 : undefined)
  expect(discord.allowed_mentions).toEqual({ parse: [] })
  expect(original).toEqual(snapshot)
  expect(new FeishuAdapter().publication.prepare(original)).toEqual(feishu)
})

it.each(['progress', 'final'] as const)('native %s speech stays distinct from User speech with no authored-body inference', phase => {
  const original = operation(undefined, phase), heading = phase === 'progress' ? 'Agent progress' : 'Agent reply'
  const feishu = JSON.parse(JSON.parse(new FeishuAdapter().publication.prepare(original).request.body!).content)
  expect(feishu.header.title.content).toBe(heading)
  expect(feishu.header.template).toBe(phase === 'progress' ? 'grey' : 'blue')
  const discord = JSON.parse(prepareDiscordPublication(original).request.body!)
  expect(discord.components[0].components[0].content).toBe('**' + heading + '**\n' + original.payload.text)
  expect(discord.components[0]).not.toHaveProperty('accent_color')
})

it.each([
  ['waiting', 'Waiting for the original Agent'], ['stopped', 'Input waiting stopped'],
  ['terminal-confirmed', 'Input bytes confirmed; Agent acceptance unconfirmed'],
  ['admitted', 'Accepted by the original Agent; work completion unconfirmed'],
  ['not-applied', 'Input not applied'], ['unknown', 'Input result unknown']
] satisfies Array<[AgentInputSubmissionObservation['status'], string]>)('User cards show original %s input facts separately from speech and Agent completion', (status, label) => {
  const original = operation([{ kind: 'human' }]), body = original.payload.text
  original.payload.inputSubmission = { status, observation: 'closed' }
  const f = JSON.parse(JSON.parse(new FeishuAdapter().publication.prepare(original).request.body!).content)
  expect(f.header.title.content).toBe('User · via amux')
  expect(f.elements).toEqual([{ tag: 'div', text: { tag: 'plain_text', content: body } },
    { tag: 'div', text: { tag: 'plain_text', content: label } }])
  const d = JSON.parse(prepareDiscordPublication(original).request.body!)
  expect(d.components[0].components).toEqual([{ type: 10, content: '**User · via amux**\n' + body }, { type: 10, content: label }])
  original.payload.inputSubmission.observation = 'rejoin-needed'
  const f2 = JSON.parse(JSON.parse(new FeishuAdapter().publication.prepare(original).request.body!).content)
  const d2 = JSON.parse(prepareDiscordPublication(original).request.body!)
  expect(f2.elements[1].text.content).toBe(label + '\nInput observation needs reconnection')
  expect(d2.components[0].components[1].content).toBe(label + '\nInput observation needs reconnection')
})
