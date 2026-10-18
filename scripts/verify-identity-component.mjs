import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
execFileSync('pnpm', ['--filter', '@agentmux/identity', 'build'], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, ['--test', 'packages/identity/test/runtime.mjs'], { cwd: root, stdio: 'inherit' })
