import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const directory = await mkdtemp(join(tmpdir(), 'agentmux-desktop-resource-'))
const userData = join(directory, 'user-data')
const workspace = join(directory, 'workspace')
const reportPath = join(directory, 'report.json')
const entry = resolve(import.meta.dirname, '../out/main/index.js')
let child = null

try {
  await mkdir(userData, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'resource-probe.ts'), 'export const value = 1\n'.repeat(20_000))
  await writeFile(join(userData, 'agentmux.config.json'), `${JSON.stringify({
    version: 3,
    hosts: [{ id: 'local', kind: 'local', label: 'Resource Probe' }],
    agents: {
      codex: { command: 'codex', args: [], env: {} },
      claude: { command: 'claude', args: [], env: {} },
      traex: { command: 'traex', args: [], env: {} },
      hermes: { command: 'hermes', args: [], env: {} },
      pi: { command: 'pi', args: [], env: {} }
    },
    workspaces: [{ id: 'resource-workspace', name: 'Resource Probe', hostId: 'local', path: workspace, kind: 'folder' }]
  }, null, 2)}\n`, { mode: 0o600 })

  child = spawn(electron, [`--user-data-dir=${userData}`, entry], {
    env: {
      ...process.env,
      AGENTMUX_DESKTOP_RESOURCE_REPORT: reportPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
    if (Buffer.byteLength(stderr) > 1024 * 1024) child.kill('SIGKILL')
  })
  const timer = setTimeout(() => child?.kill('SIGKILL'), 60_000)
  timer.unref()
  const [exitCode] = await once(child, 'exit')
  clearTimeout(timer)
  const report = await readFile(reportPath, 'utf8').catch(() => '')
  if (!report) throw new Error(`Desktop resource probe did not produce a report. ${stderr.trim()}`)
  process.stdout.write(report)
  const parsed = JSON.parse(report)
  if (exitCode !== 0 || parsed.error) throw new Error(parsed.error ?? `Desktop resource probe exited ${exitCode}.`)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  await rm(directory, { recursive: true, force: true })
}
