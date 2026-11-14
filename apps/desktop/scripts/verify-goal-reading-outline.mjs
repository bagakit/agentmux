import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const run = (file, ...args) => execFileSync(process.execPath, [resolve(import.meta.dirname, file), ...args], { cwd: root, stdio: 'inherit' })
run('verify-goal-outline-interaction.mjs')
run('verify-goals-surface.mjs', '--goal-reading-outline-only', '--evidence', resolve(root, '.tmp/goal-reading-outline'))
