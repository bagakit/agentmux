import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const result = spawnSync(process.execPath, [join(import.meta.dirname, 'verify-goal-node-claims.mjs'), '--delivery'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
