import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const child=spawn(process.execPath,[fileURLToPath(new URL('./verify-browser-recovery-restart.mjs',import.meta.url)),'--case-overlay'],{stdio:'inherit',env:process.env})
child.once('error',error=>{console.error(error);process.exitCode=1})
child.once('close',code=>{process.exitCode=code??1})
