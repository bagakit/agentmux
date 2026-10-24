import { resolve } from 'node:path'
import { buildNativeDesktop } from './native-desktop-package.mjs'

const receipt = await buildNativeDesktop({ root: resolve(import.meta.dirname, '../../..'), development: process.argv.includes('--development') })
process.stdout.write(`${JSON.stringify(receipt)}\n`)
