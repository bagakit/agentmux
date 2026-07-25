import { describe, expect, it } from 'vitest'
import {
  cloneLaunchOptions,
  describeLaunchOptions,
  resolveLaunchOptionArgv,
  validateLaunchOptionDeclarations,
  type LaunchOptionDeclaration
} from '../src/agent-launch-option.js'

const twoOptions: readonly LaunchOptionDeclaration[] = [
  {
    id: 'sandbox',
    label: 'Sandbox',
    choices: [
      { id: 'read-only', label: 'Read only', tier: 'safe', argv: ['--sandbox', 'read-only'] },
      { id: 'full', label: 'Full access', tier: 'danger', argv: ['--sandbox', 'danger-full-access'] }
    ]
  },
  {
    id: 'approval',
    label: 'Approval policy',
    choices: [
      { id: 'never', label: 'Never', argv: ['--ask-for-approval', 'never'] }
    ]
  }
]

describe('sealed launch-option contract', () => {
  it('resolves an undeclared option to nothing (a provider that offers no option contributes no argv)', () => {
    expect(resolveLaunchOptionArgv('traex', [], {})).toEqual([])
    // A provider WITH options but no selection also contributes nothing — absence, not a forced default.
    expect(resolveLaunchOptionArgv('codex', twoOptions, {})).toEqual([])
  })

  it('fails closed on an unknown option id rather than silently ignoring it', () => {
    expect(() => resolveLaunchOptionArgv('codex', twoOptions, { model: 'o3' }))
      .toThrowError(/does not declare launch option 'model'/)
  })

  it('fails closed on an unknown choice id for a declared option', () => {
    expect(() => resolveLaunchOptionArgv('codex', twoOptions, { sandbox: 'no-such-choice' }))
      .toThrowError(/has no choice 'no-such-choice'/)
  })

  it('contributes exactly the declared choice argv', () => {
    expect(resolveLaunchOptionArgv('codex', twoOptions, { sandbox: 'read-only' }))
      .toEqual(['--sandbox', 'read-only'])
    expect(resolveLaunchOptionArgv('codex', twoOptions, { sandbox: 'full' }))
      .toEqual(['--sandbox', 'danger-full-access'])
  })

  it('composes two options in declaration order regardless of selection key order', () => {
    expect(resolveLaunchOptionArgv('codex', twoOptions, { approval: 'never', sandbox: 'full' }))
      .toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'])
  })

  it('projects only the DESCRIBE half across IPC — never the argv', () => {
    const described = describeLaunchOptions(twoOptions)
    expect(described).toEqual([
      {
        id: 'sandbox',
        label: 'Sandbox',
        choices: [
          { id: 'read-only', label: 'Read only', tier: 'safe' },
          { id: 'full', label: 'Full access', tier: 'danger' }
        ]
      },
      {
        id: 'approval',
        label: 'Approval policy',
        choices: [{ id: 'never', label: 'Never' }]
      }
    ])
    // The serializable descriptor carries no argv on any choice.
    for (const option of described) {
      for (const choice of option.choices) expect('argv' in choice).toBe(false)
    }
  })

  it('clones the DESCRIBE half so a catalog copy shares no mutable structure', () => {
    const described = describeLaunchOptions(twoOptions)
    const copy = cloneLaunchOptions(described)
    copy[0]!.choices[0]!.label = 'mutated'
    expect(described[0]!.choices[0]!.label).toBe('Read only')
  })

  it('validates declarations fail closed on duplicate ids, empty labels, and unknown defaults', () => {
    expect(() => validateLaunchOptionDeclarations('codex', [
      { id: 'a', label: 'A', choices: [{ id: 'x', label: 'X', argv: [] }] },
      { id: 'a', label: 'B', choices: [{ id: 'y', label: 'Y', argv: [] }] }
    ])).toThrowError(/Duplicate launch option id 'a'/)
    expect(() => validateLaunchOptionDeclarations('codex', [
      { id: '', label: 'A', choices: [{ id: 'x', label: 'X', argv: [] }] }
    ])).toThrowError(/non-empty id and label/)
    expect(() => validateLaunchOptionDeclarations('codex', [
      { id: 'a', label: 'A', choices: [] }
    ])).toThrowError(/at least one choice/)
    expect(() => validateLaunchOptionDeclarations('codex', [
      {
        id: 'a', label: 'A', defaultChoiceId: 'nope',
        choices: [{ id: 'x', label: 'X', argv: [] }]
      }
    ])).toThrowError(/unknown defaultChoiceId 'nope'/)
    // A well-formed declaration (including a named default) validates without throwing.
    expect(() => validateLaunchOptionDeclarations('codex', twoOptions)).not.toThrow()
  })
})
