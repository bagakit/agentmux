// Canonical T-004 acceptance needs actual authenticated native devices and independent image review.
// A preparation fixture/browser viewport must never silently become this task's acceptance.
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const xcode = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' })
const sdk = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME
let android = false
if (sdk) { try { await access(resolve(sdk, 'platforms/android-36'), constants.R_OK); android = true } catch {} }
const missing = []
if (xcode.status !== 0 || !xcode.stdout.trim().includes('/Xcode.app/Contents/Developer')) missing.push('full Xcode 26+ and an iPhone build/signing environment')
if (!android) missing.push('Android API 36 SDK and a signed device build environment')
missing.push('actual authorized iPhone and Android input/clipboard/keyboard/attachment/reconnect evidence')
missing.push('independent review of the actual authenticated native device screenshots')
console.error(`T-004 is not accepted. Preparation may be checked separately in ${mobile}.\nMissing:\n${missing.map(value => `- ${value}`).join('\n')}`)
process.exitCode = 1
