import { expect, it } from 'vitest'
import { formatGoalConfirmation, parseGoalConfirmation } from '../src/goal-confirmation.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'

const goalUrl = 'amux://goal/GOAL?runtime=RUNTIME&namespace=NAMESPACE'
const notice = { goalUrl, alignmentRevision: 2, operationId: 'original-confirmation' }

it('uses a complete versioned Goal declaration with the exact canonical link', () => {
  const wire = formatGoalConfirmation(notice)
  expect(wire).toBe('<amux:goal version="1" action="confirm-and-continue">\n' +
    '{"goalUrl":"amux://goal/GOAL?runtime=RUNTIME\\u0026namespace=NAMESPACE","alignmentRevision":2,"operationId":"original-confirmation"}\n' +
    '</amux:goal>')
  expect(parseGoalConfirmation(wire)).toEqual(notice)
  expect(parseAgentMuxMessagePrefix(wire)?.protocol).toMatchObject({ id: 'goal-confirmation', raw: wire })
  expect(composeAgentPrompt(undefined, wire)).toEqual({ text: wire, systemContext: wire })
  expect(composeAgentPrompt(wire)).toEqual({ text: wire })
})

it('keeps malformed and unsupported declarations as ordinary text', () => {
  const wire = formatGoalConfirmation(notice)
  for (const input of [wire.replace('version="1"', 'version="2"'), wire.replace('confirm-and-continue', 'claim'),
    wire.replace('\\u0026', '&amp;'), wire.replace('original-confirmation"', 'original-confirmation","other":1'),
    wire + '\nTail', wire.replace('","alignmentRevision"', '#T-' + 'A'.repeat(43) + '","alignmentRevision"')]) {
    expect(parseGoalConfirmation(input)).toBeNull()
    expect(parseAgentMuxMessagePrefix(input)).toBeNull()
  }
})
