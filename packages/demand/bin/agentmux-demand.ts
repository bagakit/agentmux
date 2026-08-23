#!/usr/bin/env node
import { runDemandCli } from '../src/cli.js'

const exitCode = await runDemandCli(process.argv.slice(2))
if (exitCode !== 0) process.exitCode = exitCode
