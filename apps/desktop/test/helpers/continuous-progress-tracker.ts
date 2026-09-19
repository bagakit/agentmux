import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const execute = promisify(execFile)

/** Test-only explicit operator input. No product discovery, home scan or mutable user Tracker. */
export async function privateTracker(root: string) {
  const selectedPath = process.env.AGENTMUX_TEST_FEATURE_TRACKER_SCRIPT
  if (!selectedPath) throw new Error('Set AGENTMUX_TEST_FEATURE_TRACKER_SCRIPT to the real public feature-tracker.sh for this private test.')
  const readerPath: string = selectedPath
  await execute('/usr/bin/git', ['init', '-q', root])
  await execute('/usr/bin/git', ['-C', root, 'config', 'user.email', 'private-fixture@example.invalid'])
  await execute('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Private Tracker Fixture'])
  await writeFile(join(root, 'README.md'), 'Private business fixture; no user Session or Tracker.\n')
  await execute('/usr/bin/git', ['-C', root, 'add', 'README.md'])
  await execute('/usr/bin/git', ['-C', root, 'commit', '-qm', 'Private source baseline'])
  const run = async (...args: string[]) => (await execute('/bin/bash', [readerPath, args[0]!, '--root', root, ...args.slice(1)], { cwd: root, maxBuffer: 256 * 1024, timeout: 10_000 })).stdout
  await run('initialize-tracker')
  await writeFile(join(root, 'review.md'), '# Private Task fixture\nStatus: approved. One private Task with an exact public gate; no product authority.\n')
  const plan = { schema: 'bagakit.feature-task-plan.v1', review: { status: 'approved', evidence_ref: 'review.md' }, source_refs: ['review.md'], tasks: [{ id: 'T-001', title: 'Private business step', objective: 'Finish a private step', outcome: 'The private step is done', acceptance: ['Exact private gate passes'], verification: [{ kind: 'command', ref: "node -e 'require(\"node:assert/strict\").equal(1,1)'", proves: 'Private step input exists' }], source_refs: ['review.md'], depends_on: [], supersedes: [], estimate_hours: 0.1 }] }
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan))
  await execute('/usr/bin/git', ['-C', root, 'add', '.'])
  await execute('/usr/bin/git', ['-C', root, 'commit', '-qm', 'Private reviewed task fixture'])
  async function create(slug: string, planned = true, transferredFrom?: string) {
    const output = await run('create-feature', '--title', 'Private ' + slug, '--slug', slug, '--goal', 'Complete one private business step', '--workspace-mode', planned ? 'current_tree' : 'proposal_only', ...(planned ? ['--tasks-file', 'plan.json'] : []), ...(transferredFrom ? ['--transferred-from', transferredFrom] : []))
    const ownerId = output.match(/f-[a-z0-9]+/)?.[0]
    if (!ownerId) throw new Error('Nonempty created Feature identity is required: ' + output)
    // A proposal has no receipt until its public projection owner publishes it. Product reads never repair it.
    if (!planned) await run('repair-feature-projections')
    return { root, readerPath, ownerId }
  }
  const closeoutArgs = ['--documentation-disposition', 'not_applicable', '--documentation-rationale', 'Private fixture has no product docs', '--learning-disposition', 'no_reusable_learning', '--learning-rationale', 'Private fixture only', '--promotion-disposition', 'not_needed', '--promotion-rationale', 'Private fixture only']
  return { run, create, closeoutArgs }
}
