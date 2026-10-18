import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptedEarlierWindow } from './fixtures/conversation-progressive-reading/earlier-frame.mjs'

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
