import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const [cli, endpoint, mode] = process.argv.slice(1)
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
// Explicit user Toolkit invocation uses the local user port, never an inherited Agent claim.
delete env.AGENTMUX_AGENT_SESSION_ID
delete env.AGENTMUX_AGENT_CAPABILITY
async function query(action) {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--endpoint', endpoint, 'device', action], { env, timeout: 15000, maxBuffer: 1024 * 1024 })
  const response = JSON.parse(stdout)
  if (response.ok !== true) throw new Error(response.error?.message ?? '设备查询未完成')
  return response.result
}
const facts = await query('ls')
const devices = facts.devices.filter(device => device.revokedAt === undefined)
const result = { schema: 'agentmux.toolkit.result.v1', summary: `${devices.filter(device => device.online).length} 台在线 · ${devices.length} 台已连接`,
  items: devices.slice(0, 128).map(device => ({ label: device.name, value: device.online ? '在线' : '离线' })), links: [],
  notice: facts.mobileAccess.state === 'connected' ? '手机和 Mac 连接同一 Wi-Fi，打开链接即可操作。' : `手机连接暂不可用：${facts.mobileAccess.message}` }
if (mode === 'link') {
  const link = await query('link')
  result.links.push({ label: '手机连接链接', url: link.url })
}
console.log(JSON.stringify(result))
