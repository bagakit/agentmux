import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCatalogEntry } from '../src/types.js'

// Wrap node:fs/promises so the tests can observe HOW discovery walks, not just its result. realpath is
// the first await inside visit(): counting concurrent realpath calls proves the sibling walk overlaps,
// and recording every readdir target proves the prune skipped node_modules. Everything else delegates to
// the real implementation, so the walk runs against a real temp filesystem.
const trace = vi.hoisted(() => ({ readdirTargets: [] as string[], realpathInFlight: 0, realpathPeak: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: (async (...args: Parameters<typeof actual.realpath>) => {
      trace.realpathInFlight += 1
      trace.realpathPeak = Math.max(trace.realpathPeak, trace.realpathInFlight)
      try { return await (actual.realpath as (...a: unknown[]) => Promise<unknown>)(...args) }
      finally { trace.realpathInFlight -= 1 }
    }),
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      trace.readdirTargets.push(String(args[0]))
      return await (actual.readdir as (...a: unknown[]) => Promise<unknown>)(...args)
    })
  }
})

const { discoverAgentSkills } = await import('../src/agent-skills.js')

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  trace.readdirTargets = []; trace.realpathInFlight = 0; trace.realpathPeak = 0
})

// A catalog whose only meaningful field is the skill root; discovery must not branch on anything else.
const catalogWithRoot = (root: string) => ({ composer: { skillRoots: [root], commands: [] } } as unknown as AgentCatalogEntry)

it('prunes node_modules and build output instead of walking the whole workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-skill-prune-')); roots.push(root)
  const workspacePath = join(root, 'project'), home = join(root, 'home')
  const skillDir = join(workspacePath, '.agents/skills/review')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: Review the code\n---\nBody')
  // A node_modules tree INSIDE the declared root, holding its own SKILL.md. A pruning walk must never
  // open it and must never surface its skill; an unpruned walk would descend every level and find it.
  const noise = join(workspacePath, '.agents/skills/node_modules/pkg/nested/deeper')
  await mkdir(noise, { recursive: true })
  await writeFile(join(noise, 'SKILL.md'), '---\nname: SHOULD_NOT_APPEAR\ndescription: dependency noise\n---\n')
  await mkdir(home, { recursive: true })

  const skills = await discoverAgentSkills({ catalog: catalogWithRoot('.agents/skills'), workspacePath, home })

  // Non-vacuous: the walk must have opened something, and the real skill must be found.
  expect(trace.readdirTargets.length).toBeGreaterThan(0)
  expect(skills.map((skill) => skill.name)).toEqual(['review'])
  // The prune, proven two independent ways: the dependency skill never surfaced, and no directory at or
  // below node_modules was ever opened.
  expect(skills.some((skill) => skill.name === 'SHOULD_NOT_APPEAR')).toBe(false)
  expect(trace.readdirTargets.some((dir) => dir.includes('node_modules'))).toBe(false)
})

it('walks sibling skill directories concurrently rather than one after another', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-skill-conc-')); roots.push(root)
  const workspacePath = join(root, 'project'), home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const names = ['alpha', 'beta', 'gamma', 'delta']
  for (const name of names) {
    const dir = join(workspacePath, '.agents/skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
  }
  const skills = await discoverAgentSkills({ catalog: catalogWithRoot('.agents/skills'), workspacePath, home })
  expect(skills.map((skill) => skill.name)).toEqual(names.slice().sort())
  // Serial `for (…) await visit(…)` peaks at one realpath in flight; Promise.all over the siblings
  // suspends all of them at realpath before any resolves, so the peak exceeds one.
  expect(trace.realpathPeak).toBeGreaterThan(1)
})

it('serves an unchanged skill folder from cache without re-walking, but re-discovers when it changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-skill-cache-')); roots.push(root)
  const workspacePath = join(root, 'project'), home = join(root, 'home')
  const skillsRoot = join(workspacePath, '.agents/skills')
  await mkdir(join(skillsRoot, 'first'), { recursive: true })
  await writeFile(join(skillsRoot, 'first/SKILL.md'), '---\nname: first\ndescription: one\n---\n')
  await mkdir(home, { recursive: true })
  const input = { catalog: catalogWithRoot('.agents/skills'), workspacePath, home }

  const one = await discoverAgentSkills(input)
  expect(one.map((skill) => skill.name)).toEqual(['first'])
  const afterFirstWalk = trace.readdirTargets.length
  expect(afterFirstWalk).toBeGreaterThan(0)

  // Re-open with the folder untouched: no new readdir happens (served from cache), same result.
  const two = await discoverAgentSkills(input)
  expect(two.map((skill) => skill.name)).toEqual(['first'])
  expect(trace.readdirTargets.length).toBe(afterFirstWalk)

  // Add a skill — the root directory's mtime changes, so the signature no longer matches and discovery
  // re-runs, surfacing the new skill. (Bump mtime explicitly: a same-second write can leave mtimeMs equal
  // on coarse filesystems, which would make this assert vacuously about timing rather than invalidation.)
  await mkdir(join(skillsRoot, 'second'))
  await writeFile(join(skillsRoot, 'second/SKILL.md'), '---\nname: second\ndescription: two\n---\n')
  const future = new Date(Date.now() + 5000)
  const { utimes } = await import('node:fs/promises')
  await utimes(skillsRoot, future, future)

  const three = await discoverAgentSkills(input)
  expect(three.map((skill) => skill.name)).toEqual(['first', 'second'])
  expect(trace.readdirTargets.length).toBeGreaterThan(afterFirstWalk)
})
