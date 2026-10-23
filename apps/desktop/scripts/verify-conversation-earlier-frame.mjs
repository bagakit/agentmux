import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptedEarlierWindow, earlierRequestWindow } from './fixtures/conversation-progressive-reading/earlier-frame.mjs'

test('an interleaved input consumer cannot replace the accepted reading frame cursor', () => {
  const reading = { id: 'reading', revision: 2, complete: true, navigation: { older: 'reading-earlier' } }
  const input = { id: 'input-summary', revision: 2, complete: true, navigation: { older: 'input-earlier' } }
  const reads = [{ window: reading }, { window: input }]
  assert.equal(acceptedEarlierWindow(reads, { id: 'reading', revision: 2 }), reading)
  assert.equal(acceptedEarlierWindow(reads, { id: 'input-summary', revision: 2 }), input)
})

test('the accepted revision uses its complete original continuation window', () => {
  const previous = { id: 'reading', revision: 1, complete: true, navigation: { older: 'previous-earlier' } }
  const complete = { id: 'reading', revision: 2, complete: true, navigation: { older: 'accepted-earlier' } }
  const partial = { id: 'reading', revision: 2, complete: false, navigation: { older: 'partial-earlier' } }
  assert.equal(acceptedEarlierWindow([{ window: previous }, { window: complete }, { window: partial }],
    { id: 'reading', revision: 2 }), complete)
})

test('missing, partial and exhausted accepted frames never borrow another window cursor', () => {
  const reads = [
    { window: { id: 'reading', revision: 1, complete: true, navigation: { older: 'previous-earlier' } } },
    { window: { id: 'reading', revision: 2, complete: false, navigation: { older: 'partial-earlier' } } },
    { window: { id: 'reading', revision: 3, complete: true, navigation: { older: null } } },
    { window: { id: 'input-summary', revision: 4, complete: true, navigation: { older: 'input-earlier' } } }
  ]
  for (const accepted of [null, { id: 'reading', revision: 2 }, { id: 'reading', revision: 3 }, { id: 'unobserved', revision: 4 }]) {
    assert.throws(() => acceptedEarlierWindow(reads, accepted), /No complete original earlier window/u)
  }
})

test('an earlier request binds the actual published cursor after the accepted frame advances', () => {
  const accepted = { id: 'reading', revision: 5, complete: true, navigation: { older: 'original-opaque' } }
  const expected = { hostId: 'local', agentSessionId: 'original-session', id: accepted.id, revision: accepted.revision }
  const published = { id: 'reading', revision: 6, complete: true, navigation: { older: 'advanced-opaque' } }
  const input = { hostId: 'local', agentSessionId: 'original-session', preserveCurrent: true, cursor: published.navigation.older }
  const reads = [{ window: accepted }, { window: published },
    { window: { id: 'input-summary', revision: 99, complete: true, navigation: { older: 'foreign-opaque' } } }]
  assert.equal(acceptedEarlierWindow(reads, expected), accepted)
  assert.equal(earlierRequestWindow(reads, expected, 'readAgentConversation', input), published)
})

test('a held earlier request never borrows another target, view or continuation cursor', () => {
  const expected = { hostId: 'local', agentSessionId: 'original-session', id: 'reading', revision: 5 }
  const input = { hostId: expected.hostId, agentSessionId: expected.agentSessionId, preserveCurrent: true, cursor: 'original-opaque' }
  const reads = [
    { window: { id: expected.id, revision: 4, complete: true, navigation: { older: 'old-opaque' } } },
    { window: { id: expected.id, revision: 5, complete: true, navigation: { older: input.cursor } } },
    { window: { id: expected.id, revision: 6, complete: false, navigation: { older: 'partial-opaque' } } },
    { window: { id: 'input-summary', revision: 99, complete: true, navigation: { older: 'foreign-opaque' } } }
  ]
  assert.equal(earlierRequestWindow(reads, expected, 'readConversationChanges', input), null)
  for (const changed of [{ hostId: 'other-host' }, { agentSessionId: 'other-session' }, { preserveCurrent: false },
    ...['old-opaque', 'partial-opaque', 'foreign-opaque', 'continuation-opaque'].map(cursor => ({ cursor }))])
    assert.equal(earlierRequestWindow(reads, expected, 'readAgentConversation', { ...input, ...changed }), null)
})
