import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  const desktop = resolve(import.meta.dirname, '..')
  const output = process.argv[2] ?? join(desktop, 'resources', 'bin', 'agentmux-mac-location.node')
  const temporary = output + '.' + process.pid + '.tmp'
  const headers = resolve(dirname(process.execPath), '..', 'include', 'node')
  mkdirSync(dirname(output), { recursive: true })
  try {
    execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-mmacosx-version-min=12.0',
      '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-framework', 'CoreLocation',
      '-I', headers, '-DNODE_GYP_MODULE_NAME=agentmux_mac_location', join(desktop, 'native', 'mac-location.mm'),
      '-o', temporary], { stdio: 'inherit' })
    renameSync(temporary, output)
  } finally {
    rmSync(temporary, { force: true })
  }
}
