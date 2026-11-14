import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { parseAgentScheduleCalendar } from '../src/agent-schedule.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

it('compiled action help supplies complete original-parser examples without contacting a service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-help-'))
  try {
    let examples = 0
    for (const [prefix, actions] of [
      [['agent', 'progress'], ['list', 'create', 'action', 'update']],
      [['schedule'], ['list', 'inspect', 'create', 'update', 'pause', 'resume', 'cancel']]
    ] as const) for (const action of actions) {
      const args = [...prefix, action]
      const help = await runCompiledObjectCli([...args, '--help'], objectCliEnvironment(root))
      expect(help.code, help.stderr).toBe(0)
      const match = /Example JSON: (\{[^\n]*\})/.exec(help.stdout)
      expect(match, help.stdout).not.toBeNull()
      const input = JSON.parse(match![1]!)
      const dataPath = join(root, 'example.json')
      await writeFile(dataPath, JSON.stringify(input))
      const parse = async (value: unknown) => { await writeFile(dataPath, JSON.stringify(value)); return parseAgentMuxCliInvocation([...args, '--data', dataPath]) }
      const invocation = await parse(input)
      expect(invocation.command.method).toBe(args.join('.'))
      expect(invocation.params).toEqual(input)
      if (action === 'create') {
        const missingTarget = { ...input }; delete missingTarget.target
        await expect(parse(missingTarget)).rejects.toThrow()
      }
      if ('expectedRevision' in input) {
        await expect(parse({ ...input, expectedRevision: 0 })).rejects.toThrow()
      }
      if ('expectedLoop' in input) {
        await expect(parse({ ...input, expectedLoop: { loopId: 'EXACT_LOOP' } })).rejects.toThrow()
      }
      examples++
    }
    expect(examples).toBe(11)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('calendar help and offline guide expose all five distinct original civil rule shapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-calendar-help-'))
  try {
    const help = await runCompiledObjectCli(['schedule', 'create', '--help'], objectCliEnvironment(root))
    const input = JSON.parse(/Example JSON: (\{[^\n]*\})/.exec(help.stdout)![1]!)
    const guide = await readFile(new URL('../guides/modules/schedule.md', import.meta.url), 'utf8')
    for (const [kind, extras] of [['once', { date: '2030-01-01' }], ['daily', {}], ['weekly', { weekday: 1 }], ['monthly', { day: 31 }], ['yearly', { month: 2, day: 29 }]] as const) {
      expect(help.stdout).toContain(kind); expect(guide).toContain('`' + kind + '`')
      const { weekday: _weekday, ...base } = input.calendar
      const calendar = { ...base, kind, ...extras }
      expect(parseAgentScheduleCalendar(calendar)).toEqual(calendar)
      const dataPath = join(root, 'calendar.json')
      await writeFile(dataPath, JSON.stringify({ ...input, calendar }))
      await expect(parseAgentMuxCliInvocation(['schedule', 'create', '--data', dataPath])).resolves.toMatchObject({ params: { calendar } })
      expect(() => parseAgentScheduleCalendar({ ...calendar, policies: { ...calendar.policies, gap: 'invented' } })).toThrow()
    }
    expect(help.stdout).toContain('schedule.loopId'); expect(help.stdout).toContain('creationOperationId')
  } finally { await rm(root, { recursive: true, force: true }) }
})
