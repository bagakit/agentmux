import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILTER_DIRECTORIES = {
  '@agentmux/core': 'packages/core',
  '@agentmux/desktop': 'apps/desktop',
  '@agentmux/layout': 'packages/layout'
}

function commandDirectory(command, root) {
  const cd = /cd\s+(\S+)\s*&&/.exec(command)
  if (cd) return cd[1].startsWith('/') ? relative(root, cd[1]) : cd[1]
  const filter = /--filter\s+(\S+)/.exec(command)
  return (filter && FILTER_DIRECTORIES[filter[1]]) || '.'
}

/** Audit explicit local Tracker data; absent or empty evidence is never a passed audit. */
export function auditTrackerTestTargets({ root, features }) {
  const named = []
  let commands = 0
  for (const feature of readdirSync(features)) {
    const tasksFile = join(features, feature, 'tasks.json')
    if (!existsSync(tasksFile)) continue
    const parsed = JSON.parse(readFileSync(tasksFile, 'utf8'))
    for (const task of parsed.tasks ?? []) {
      const status = task.status ?? 'unknown'
      if (status === 'todo' || status === 'cancelled' || status === 'transferred') continue
      for (const verification of task.verification ?? []) {
        if (verification.kind !== 'command') continue
        const command = (verification.ref ?? '').split('#')[0]
        if (!command.includes('vitest')) continue
        if (command.includes('test -f') || command.includes('test -e')) continue
        commands += 1
        const directory = commandDirectory(command, root)
        for (const token of command.match(/\S*\.test\.[cm]?[jt]sx?\b/g) ?? []) {
          named.push({ feature, task: task.id ?? 'unknown', status, path: normalize(join(directory, token)) })
        }
      }
    }
  }
  const missing = named.filter(entry => {
    const absolute = join(root, entry.path)
    // A .test.ts filter also selects .test.tsx; an exact extension is not required.
    return !existsSync(absolute) && globSync(`${absolute}*`).length === 0
  })
  return { state: commands > 0 && named.length > 0 ? 'audited' : 'unconfirmed', commands, named, missing }
}

function main(argv) {
  let root = process.cwd(), features
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    if (!value || !['--root', '--features'].includes(name)) throw new Error('Usage: audit-tracker-test-targets.mjs [--root directory] [--features directory]')
    if (name === '--root') root = resolve(value)
    else features = resolve(value)
  }
  const result = auditTrackerTestTargets({ root, features: features ?? join(root, '.bagakit/feature-tracker/features') })
  console.log(JSON.stringify(result))
  process.exitCode = result.state !== 'audited' ? 2 : result.missing.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) }
  catch (error) {
    console.error(JSON.stringify({ state: 'unconfirmed', error: error.message }))
    process.exitCode = 2
  }
}
