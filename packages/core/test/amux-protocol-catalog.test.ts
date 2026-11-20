import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AGENTMUX_PROTOCOL_CATALOG, AMUX_PROTOCOL_DEFINITIONS, parseAgentMuxMessagePrefix, renderAgentMuxMessageEnvelope } from '../src/agent-message-render.js'
import { composeAgentPrompt, composeOutboundMessage, formatAmuxTriggerNote } from '../src/agent-outbound-message.js'
import { DEFAULT_AGENT_CONTINUITY_CONTINUATION } from '../src/agent-session-recovery/continuity-contract.js'
import { promptReactionMessage, PROMPT_REACTION_STARTERS } from '../src/prompt-reaction.js'
import { formatGoalConfirmation } from '../src/goal-confirmation.js'
import { parseAmuxObjectLink } from '../src/sharing.js'

describe('source-owned amux reading catalog', () => {
  it('uses actual production formats and retains the real reaction producer boundary', () => {
    expect(AGENTMUX_PROTOCOL_CATALOG.length).toBeGreaterThan(0)
    expect(AGENTMUX_PROTOCOL_CATALOG.map(entry => entry.id)).toEqual(Object.keys(AMUX_PROTOCOL_DEFINITIONS))
    for (const entry of AGENTMUX_PROTOCOL_CATALOG) {
      expect(entry.examples.length).toBeGreaterThan(0)
      for (const example of entry.examples) {
        if (entry.form === 'link') expect(parseAmuxObjectLink(example.wire)).toEqual({ kind: 'agent', agentSessionId: 'SID' })
        else if (entry.form === 'frame') expect(example.wire).toMatch(/^--- amux : (?:File|Browser) ---\n[\s\S]+\n-----$/u)
        else expect(parseAgentMuxMessagePrefix(example.wire), entry.id).not.toBeNull()
      }
    }
    const marker = AGENTMUX_PROTOCOL_CATALOG.find(entry => entry.id === 'continue')!.examples[0]!.wire
    expect(marker).toBe(DEFAULT_AGENT_CONTINUITY_CONTINUATION)
    const original = promptReactionMessage(PROMPT_REACTION_STARTERS[0]!, { kind: 'captured', agentSessionId: 'SID', recordId: 'RID' })
    expect(original.agentMuxNote.split('\n')[0]).toBe(AGENTMUX_PROTOCOL_CATALOG.find(entry => entry.id === 'reaction')!.examples[0]!.wire)
    const realWire = composeOutboundMessage({ amux: original.agentMuxNote, user: original.prompt })
    expect(realWire).toContain('&lt;amux:reaction ok /&gt;')
    expect(parseAgentMuxMessagePrefix(realWire)?.protocol).toBeUndefined()
    expect(parseAgentMuxMessagePrefix(realWire)?.body).toBe('\n\n' + original.prompt)
  })

  it.each(['heartbeat', 'calendar', 'automation'] as const)('keeps a %s declaration apart from the original instruction and any sender it quotes', kind => {
    const body = renderAgentMuxMessageEnvelope({ messageId: 'example', sender: { kind: 'agent-session', agentSessionId: 'author' }, senderSessionId: 'author', body: '  body\r\n' })
    const system = formatAmuxTriggerNote(kind, 'Original <source> & receipt.\r\n')
    const { text, systemContext } = composeAgentPrompt(body, system)
    expect(systemContext).toBe(system)
    const raw = `<amux>\n<trigger kind="${kind}"/>\nOriginal &lt;source&gt; &amp; receipt.&#13;\n\n</amux>`
    expect(text).toBe(raw + '\n\n' + body)
    expect(parseAgentMuxMessagePrefix(text)).toEqual({ kind: 'content', sourceLabel: '', declaredAgentSessionId: null,
      declaredTrigger: kind, declaredContexts: [{ raw }], body: '\n\n' + body })
  })

  it('classifies only the complete registered platform declaration', () => {
    const human = 'Mote main heartbeat. Continue the calendar automation.'
    expect(parseAgentMuxMessagePrefix(composeAgentPrompt(human, 'Read the original instructions.').text)?.declaredTrigger).toBeUndefined()
    const quoted = composeAgentPrompt(human, formatAmuxTriggerNote('heartbeat', 'Example.')).text
    const ordinary = parseAgentMuxMessagePrefix(composeAgentPrompt(quoted, 'Read the original instructions.').text)
    expect(ordinary?.declaredTrigger).toBeUndefined()
    expect(ordinary?.body).toBe('\n\n' + quoted)
    for (const header of ['<trigger kind="invented"/>', '<trigger kind="heartbeat" actor="agent"/>', '<trigger kind="calendar"/><trigger kind="automation"/>']) {
      expect(parseAgentMuxMessagePrefix(`<amux>\n${header}\nOriginal source.\n</amux>\n\n${human}`)).toBeNull()
    }
  })

  it('checks nonempty real source literals for unregistered named formats', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url))
    const found = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts')).flatMap(name =>
      [...readFileSync(dir + name, 'utf8').matchAll(/<amux:([a-z][a-z0-9-]*)/gu)].map(match => ({ name, tag: `amux:${match[1]}` })))
    expect(found.length).toBeGreaterThan(0)
    const declared = new Set<string>(Object.values(AMUX_PROTOCOL_DEFINITIONS).map(entry => entry.tag))
    expect(found.filter(item => !declared.has(item.tag))).toEqual([])
  })

  it.each([
    ['<amux:continue />', 'continue'], ['<amux:reaction ok />', 'reaction'],
    ['<amux:future-label />', undefined], ['<amux:a2a-future />', undefined]
  ])('reads a complete independent declaration: %s', (wire, id) => {
    const reading = parseAgentMuxMessagePrefix(wire)
    expect(reading).toMatchObject({ kind: 'content', sourceLabel: '', declaredAgentSessionId: null,
      body: '', protocol: { raw: wire, body: null } })
    expect(reading?.protocol?.id).toBe(id)
  })

  it('reads an adjacent extension and a Goal declaration with previously written prose', () => {
    const extension = '<amux:quote-note>opaque</amux:quote-note>'
    expect(parseAgentMuxMessagePrefix(extension)?.protocol).toMatchObject({ tag: 'amux:quote-note', raw: extension, body: 'opaque' })
    const current = formatGoalConfirmation({ goalUrl: 'amux://goal/GOAL?runtime=RUNTIME&namespace=NAMESPACE', alignmentRevision: 2, operationId: 'original-confirmation' })
    const older = current.slice(0, current.indexOf('>') + 1) + '\nEarlier wording &amp; the original owner.\n</amux:goal>'
    expect(parseAgentMuxMessagePrefix(older)?.protocol).toMatchObject({ id: 'goal-confirmation', raw: older, body: 'Earlier wording &amp; the original owner.' })
    expect(composeAgentPrompt(undefined, older).text).toBe(older)
    expect(parseAgentMuxMessagePrefix(older.replace('&amp;', '&missing;'))).toBeNull()
  })

  it('decodes only header attributes, preserving opaque body including entities and nested protocol samples', () => {
    const body = '\n&unknown; <amux:continue />\r\n<reminder>example</reminder>  '
    const wire = `<amux:future task="A &amp; B" ref="&#65;">${body}</amux:future>`
    const parsed = parseAgentMuxMessagePrefix(wire)!
    expect(parsed.protocol).toEqual({ tag: 'amux:future', attributes: [{ name: 'task', value: 'A & B' }, { name: 'ref', value: 'A' }], body, raw: wire })
    const a2a = renderAgentMuxMessageEnvelope({ messageId: 'MID', sender: { kind: 'agent-session', agentSessionId: 'SID' }, senderSessionId: 'SID', body: wire })
    expect(parseAgentMuxMessagePrefix(a2a)?.body).toBe(wire)
    expect(parseAgentMuxMessagePrefix(a2a)?.protocol).toBeUndefined()
  })

  it.each([
    ' <amux:future />', '<amux:future />\n', 'before <amux:future />', '<amux:future /> after',
    '`<amux:future />`', '```xml\n<amux:future />\n```', '> <amux:future />',
    '<amux:future key="first" key="second" />', '<amux:future key="&missing;" />',
    '<amux:future key="&#0;" />', '<amux:future key="&#xD800;" />', '<amux:future key="\u0000" />', '<amux:future key="\u0001" />',
    '<!DOCTYPE future><amux:future />', '<?xml version="1.0"?><amux:future />',
    '<amux:future key="<nested>" />', '<amux:future key="line\nline" />', '<amux:future bare />',
    '<amux:future>', '<amux:future></amux:different>', '<amux:continue extra="yes" />',
    '<amux:reaction code="ok" />', '<amux:reaction INVALID />', '<amux:a2a from="SID" />'
  ])('keeps incomplete, reserved-invalid or non-standalone input untouched: %s', wire => {
    expect(parseAgentMuxMessagePrefix(wire)).toBeNull()
  })
})
