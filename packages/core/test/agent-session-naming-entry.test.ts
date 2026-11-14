import { expect, it } from 'vitest'
import { AGENTMUX_SESSION_NAMING_ENTRY } from '../src/agent-messaging-guidance.js'
import { AGENTMUX_SESSION_NAMING_ENTRY as publicEntry } from '../src/index.js'
import { guideSharedRuntime, guideSharedSessionNaming } from '../src/generated/agentmux-guides.js'
import { composeAgentLaunchPrompt, composeAgentResumePrompt } from '../src/agent-outbound-message.js'
import { agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'

const originalRule = 'Early in the conversation, once you understand the task and your role, read name --skill and give your own Session a concise derived task name; continue the task if naming is unavailable.'

it('exports the original short discovery rule from one generated shared owner', () => {
  expect(AGENTMUX_SESSION_NAMING_ENTRY).toBe(originalRule)
  expect(publicEntry).toBe(AGENTMUX_SESSION_NAMING_ENTRY)
  expect(guideSharedSessionNaming.text).toBe(originalRule)
  expect(guideSharedRuntime.text.split(originalRule)).toHaveLength(2)
  expect(AGENTMUX_SESSION_NAMING_ENTRY).not.toContain('--name-revision')
  expect(AGENTMUX_SESSION_NAMING_ENTRY).not.toContain(agentMuxModuleSkill('name')!)
})

it('the actual bootstrap includes one naming entry with the full guide enabled or disabled', () => {
  const body = '  Keep <amux> original user bytes & first task.\r\n'
  const launched = composeAgentLaunchPrompt(body, true)
  expect(launched.systemContext!.split(originalRule)).toHaveLength(2)
  expect(launched.text.endsWith('</amux>\n\n' + body)).toBe(true)
  expect(launched.systemContext).not.toContain(body)
  const disabled = composeAgentLaunchPrompt(body, false)
  expect(disabled.systemContext).toBe('The user request follows.\n\n' + originalRule)
  expect(disabled.text.endsWith('</amux>\n\n' + body)).toBe(true)
  expect(disabled.systemContext).not.toContain('AgentMux runtime guide:')
  expect(composeAgentLaunchPrompt(undefined, false)).toEqual({ text: '' })
})

it('a required discovery note reaches the canonical guide-disabled launch without enabling the full runtime guide', () => {
  const body = 'Original separately supplied task.'
  const launched = composeAgentLaunchPrompt(body, false, AGENTMUX_SESSION_NAMING_ENTRY)
  expect(launched.systemContext).toBe('The user request follows.\n\n' + originalRule)
  expect(launched.text.endsWith('</amux>\n\n' + body)).toBe(true)
  expect(launched.systemContext).not.toContain('AgentMux runtime guide:')
  expect(launched.systemContext).not.toContain('Run "$AGENTMUX_CLI" whoami')
})

it('no-task initialization still waits and no-input restoration never creates a naming turn', () => {
  const waiting = composeAgentLaunchPrompt(undefined, false, AGENTMUX_SESSION_NAMING_ENTRY)
  expect(waiting.systemContext).toBe('No request yet. Complete any read-only initialization below, then wait for the user.\n\n' + originalRule)
  expect(waiting.systemContext!.split(originalRule)).toHaveLength(2)
  expect(composeAgentResumePrompt(undefined)).toEqual({ text: '' })
  expect(composeAgentLaunchPrompt(' \n', false, ' \n', [])).toEqual({ text: '' })
  expect(composeAgentLaunchPrompt(undefined, false, undefined, [{ text: '', omittedText: '' }])).toEqual({ text: '' })
})

it.each([
  { kind: 'note', note: 'Original platform note.' },
  { kind: 'task', task: 'Original authorized platform task.' },
  { kind: 'optional context', optional: [{ text: 'Original bounded context.', omittedText: 'Read the original context by its retained reference.' }] }
])('the original $kind packet carries one shortest entry with the broad guide off', ({ note, task, optional }) => {
  const result = composeAgentLaunchPrompt(undefined, false, note, optional, task)
  expect(result.systemContext!.split(originalRule)).toHaveLength(2)
  expect(result.systemContext).toContain(note ?? task ?? optional![0]!.text)
  expect(result.systemContext).not.toContain('AgentMux runtime guide:')
  expect(result.systemContext).toContain(task ? 'An explicit AgentMux task follows.' : 'No request yet.')
})
