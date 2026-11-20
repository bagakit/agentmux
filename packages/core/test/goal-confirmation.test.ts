import { expect, it } from 'vitest'
import { formatGoalConfirmation, parseGoalConfirmation } from '../src/goal-confirmation.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import { parseAgentMuxMessagePrefix } from '../src/agent-message-render.js'

const goalUrl = 'amux://goal/GOAL?runtime=RUNTIME&namespace=NAMESPACE'
const notice = { goalUrl, alignmentRevision: 2, operationId: 'original-confirmation' }

it('uses a complete versioned Goal declaration with the exact canonical link', () => {
  const wire = formatGoalConfirmation(notice)
  const opening = '<amux:goal version="2" action="confirm-and-continue" goal="amux://goal/GOAL?runtime=RUNTIME&amp;namespace=NAMESPACE" revision="2" operation-id="original-confirmation">\n'
  expect(wire.startsWith(opening)).toBe(true)
  expect(parseGoalConfirmation(wire)).toEqual(notice)
  const body = wire.slice(opening.length, -'\n</amux:goal>'.length)
  expect(body).toContain('The user confirmed this Goal proposal')
  expect(body).toContain('collect reports, arrange independent review and advance newly ready work')
  expect(body).toContain('Continue until results are ready for the user to accept or a concrete blocker needs action')
  expect(parseAgentMuxMessagePrefix(wire)?.protocol).toMatchObject({ id: 'goal-confirmation', raw: wire, body })
  expect(composeAgentPrompt(undefined, wire)).toEqual({ text: wire, systemContext: wire })
  expect(composeAgentPrompt(wire)).toEqual({ text: wire })
})

it('retains a previously frozen confirmation without rewriting its original input', () => {
  const original = '<amux:goal version="1" action="confirm-and-continue">\n' +
    '{"goalUrl":"amux://goal/GOAL?runtime=RUNTIME\\u0026namespace=NAMESPACE","alignmentRevision":2,"operationId":"original-confirmation"}\n' +
    '</amux:goal>'
  expect(parseGoalConfirmation(original)).toEqual(notice)
  expect(composeAgentPrompt(undefined, original)).toEqual({ text: original, systemContext: original })
})

it('keeps malformed and unsupported declarations as ordinary text', () => {
  const wire = formatGoalConfirmation(notice)
  for (const input of [wire.replace('version="2"', 'version="3"'), wire.replace('confirm-and-continue', 'claim'),
    wire.replace('&amp;', '&'), wire.replace('original-confirmation"', 'original-confirmation" other="1"'),
    wire + '\nTail', wire.replace('NAMESPACE"', 'NAMESPACE#T-' + 'A'.repeat(43) + '"')]) {
    expect(parseGoalConfirmation(input)).toBeNull()
    expect(parseAgentMuxMessagePrefix(input)).toBeNull()
  }
})
