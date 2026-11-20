import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { crossHostMutations } from './goal-cross-host-mutations.mjs'

export const repositoryRoot = resolve(import.meta.dirname, '../../..')
const coreOwners = new Set(['packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/settings-cli.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-creation-authority.ts', 'packages/core/src/agent-message-federation.ts', 'packages/core/src/agent-message-envelope.ts',
  'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/agent-handoff.ts', 'apps/host/src/host.ts'])
const goalOwners = new Set(['apps/host/src/goals.ts', 'apps/host/src/goal-delegation-owner.ts', 'apps/host/src/goal-source-report.ts', 'apps/host/src/goal-worker-closeout.ts',
  'apps/host/src/goal-supervisor-identity.ts', 'packages/core/src/goal-delegation.ts', 'packages/core/src/goal-delegation-source.ts',
  'packages/demand/src/demand-store.ts', 'packages/demand/src/delegations.ts', 'packages/demand/src/goal-plan.ts'])
const packages = readdirSync(resolve(repositoryRoot, 'packages')).map(name => 'packages/' + name).concat(['apps/host'])
  .filter(directory => existsSync(resolve(repositoryRoot, directory, 'package.json')))
  .map(directory => [directory, JSON.parse(readFileSync(resolve(repositoryRoot, directory, 'package.json'), 'utf8')).name])
export const sourceAliases = packages.flatMap(([directory, name]) => {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, directory, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports ?? {}).flatMap(([key, value]) => {
    const entry = typeof value === 'string' ? value : value.types ?? value.import
    if (!entry) return []
    if (key === './runtime-source' && name === '@agentmux/identity') return [{ find: name + '/runtime-source', replacement: resolve(repositoryRoot, directory, value.import) }]
    const source = entry.startsWith('./dist/src/') ? './src/' + entry.slice(11) : entry.replace(/^\.\/dist\//u, './src/')
    const file = resolve(repositoryRoot, directory, source.replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
    return key.includes('*') || existsSync(file) ? [{ find: key === '.' ? name : name + '/' + key.slice(2), replacement: file }] : []
  })
}).sort((a, b) => b.find.length - a.find.length)

export function instrumentCrossHostSource(source, absolutePath, consumer) {
  const path = relative(repositoryRoot, absolutePath)
  // The narrow Core gate records only its real owners; an imported but unused
  // Goal codec must not turn a concurrent Goal edit into a Core candidate drift.
  if (!coreOwners.has(path) && !(process.env.GOAL_CROSS_HOST_SCOPE !== 'core' && goalOwners.has(path))) return source
  const originalSHA256 = createHash('sha256').update(source).digest('hex'), mutant = process.env.GOAL_CROSS_HOST_MUTANT
  if (mutant) {
    if (!Object.hasOwn(crossHostMutations, mutant)) throw Error('Select an exact cross-Host mutation')
    const change = crossHostMutations[mutant]
    if (path === change.path) {
      if (source.split(change.anchor).length !== 2) throw Error('The cross-Host mutation must match one exact original owner: ' + mutant)
      source = source.replace(change.anchor, change.replacement)
    }
  }
  const loadedSHA256 = createHash('sha256').update(source).digest('hex')
  const receipt = { path, consumer, pid: process.pid, originalSHA256, loadedSHA256, ...(originalSHA256 === loadedSHA256 ? {} : { mutant }) }
  const report = process.env.GOAL_CROSS_HOST_LOADED
  if (report) {
    // Evaluation, rather than transformation alone, proves this owner was consumed.
    const header = "import { appendFileSync as __goalCrossHostLoaded } from 'node:fs'; __goalCrossHostLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n'
    const shebang = source.match(/^#![^\n]*\n/u)?.[0] ?? ''
    source = shebang + header + source.slice(shebang.length)
  }
  return source
}
