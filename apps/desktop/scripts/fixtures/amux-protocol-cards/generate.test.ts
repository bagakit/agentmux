import { readFile, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { AGENTMUX_PROTOCOL_CATALOG } from '@agentmux/core/agent-message-render'
import { nativeHistoryFixture, jsonl } from '../../../../../packages/core/test/fixtures/native-history-session'

it('exports nonempty original Core reading frames without starting or changing a Run', async () => {
  const output = process.env.AMUX_PROTOCOL_CAPTURE_DATA
  expect(output, 'The capture owner must supply its exact evidence destination').toBeTruthy()
  const example = (id: string) => AGENTMUX_PROTOCOL_CATALOG.find(entry => entry.id === id)!.examples[0]!.wire
  const generic = `<amux:review note="${'original-id-'.repeat(18)}" scope="Read only">Original opaque body.\n<amux:continue /> remains authored content.\n&unknown; stays literal.</amux:review>`
  const inputs = {
    markers: [generic, example('continue'), example('reaction')],
    collaboration: [example('context'), example('browser'), example('a2a'), example('a2a-reference')]
  }
  const groups: Record<string, unknown> = {}
  for (const [group, wires] of Object.entries(inputs)) {
    const nativeSessionId = `native-${group}`
    const fixture = await nativeHistoryFixture('claude', jsonl(wires.map((text, index) => ({ sessionId: nativeSessionId,
      uuid: `${group}-${index}`, type: 'user', message: { role: 'user', content: text } }))), { nativeSessionId, agentSessionId: 'reader' })
    try {
      const frame = await fixture.client.readAgentConversation({ hostId: 'local', agentSessionId: 'reader', limit: 100, maxBytes: 4 * 1024 * 1024 })
      expect(frame.items.length).toBeGreaterThan(0)
      expect(frame.window.complete).toBe(true)
      const changes = await fixture.client.readConversationChanges({ hostId: 'local', agentSessionId: 'reader',
        checkpoint: frame.window.checkpoint, view: frame.window.view, maxBytes: 4 * 1024 * 1024 })
      expect(fixture.controls.map(control => control.mock.calls.length)).toEqual(fixture.controls.map(() => 0))
      expect(await readFile(fixture.path)).toEqual(fixture.before.native)
      groups[group] = { frame, changes, session: fixture.session, wires }
    } finally { await fixture.close() }
  }
  await writeFile(output!, JSON.stringify({ groups, catalog: AGENTMUX_PROTOCOL_CATALOG, catalogCount: AGENTMUX_PROTOCOL_CATALOG.length,
    boundary: 'Current source Core, built-in Claude reader and private FileStore. Original native authors remain unknown. No Native process, model, user Run, installation or recovery assertion.' }) + '\n')
})
