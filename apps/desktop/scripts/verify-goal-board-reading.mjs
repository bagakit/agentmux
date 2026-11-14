import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const { values } = parseArgs({ options: { snapshot: { type: 'string' }, evidence: { type: 'string' } } })
const environment = { ...process.env }
if (values.snapshot) environment.AGENTMUX_BOARD_READING_SNAPSHOT = resolve(values.snapshot)
else delete environment.AGENTMUX_BOARD_READING_SNAPSHOT
execFileSync(process.execPath, [resolve(import.meta.dirname, 'verify-goals-surface.mjs'), '--goal-board-reading-only',
  '--evidence', resolve(values.evidence ?? resolve(root, '.tmp/goal-board-reading'))], { cwd: root, stdio: 'inherit', env: environment })
