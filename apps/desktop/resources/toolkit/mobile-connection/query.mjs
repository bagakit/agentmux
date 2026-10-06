import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
const [cli, endpoint, mode] = process.argv.slice(1)
const { connectToolkitResultChannel } = await import(new URL('./toolkit-result-channel.js', pathToFileURL(cli)).href)
const channel = await connectToolkitResultChannel()
const closed = new Promise((resolve, reject) => { channel.once('close', resolve); channel.once('error', reject) })
void closed.catch(() => {}) // Report channel errors below without abandoning an in-flight owner query.
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
// Explicit user Toolkit invocation uses the local user port, never an inherited Agent claim.
delete env.AGENTMUX_AGENT_SESSION_ID
delete env.AGENTMUX_AGENT_CAPABILITY
async function query(action) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--endpoint', endpoint, 'device', action], { env, timeout: 15000, maxBuffer: 1024 * 1024 })
  const response = JSON.parse(stdout)
  if (response.ok !== true) throw new Error(response.error?.message ?? 'Device query did not complete')
  return response.result
}
try {
  const facts = await query('ls')
  const registered = facts.devices.filter(device => device.revokedAt === undefined)
  const devices = registered.filter(device => device.online === true)
  const unconfirmed = registered.some(device => device.online === undefined)
  const result = { schema: 'agentmux.toolkit.result.v1', summary: unconfirmed ? `${devices.length} confirmed connected · other connections unconfirmed` : `${devices.length} connected`,
    items: devices.map(device => ({ label: device.name, value: device.connection?.address ? `Connected · ${device.connection.address}` : 'Connected' })), links: [],
    notice: (facts.mobileAccess.state === 'connected' ? 'Connect your phone and Mac to the same Wi-Fi, then open the link.' : `Phone connection unavailable: ${facts.mobileAccess.message}`)
      + (unconfirmed ? ' Some device connections are unconfirmed. Refresh to check their status.' : '') }
  if (mode === 'link') {
    const link = await query('link')
    result.links.push({ label: 'Phone connection link', url: link.url })
  }
  if (channel.destroyed) throw new Error('Toolkit result channel closed before the connection document was sent.')
  channel.end(JSON.stringify(result) + '\n')
  await closed
} finally { channel.destroy() }
