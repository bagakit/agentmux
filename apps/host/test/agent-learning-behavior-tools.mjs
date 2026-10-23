import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(value).digest('hex')

/** Finite test tool delegation only. Production bytes and the original caller remain unchanged. */
export async function writeBehaviorTools({ directory, cliPath, endpoint, caller, capability, operationId, production }) {
  const executable = join(directory, 'amux.mjs')
  await writeFile(executable, `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2),needsInput=args.some((arg,index)=>arg==='--input'&&args[index+1]==='-')||args.includes('--content-stdin');const input=needsInput?readFileSync(0):Buffer.alloc(0);
const env={...process.env,AGENTMUX_ENV:undefined,AGENTMUX_RPC_ENDPOINT:${JSON.stringify(endpoint)},AGENTMUX_AGENT_SESSION_ID:${JSON.stringify(caller)},AGENTMUX_AGENT_CAPABILITY:${JSON.stringify(capability)}};
const r=spawnSync(process.execPath,[${JSON.stringify(cliPath)},...args],{env,input,maxBuffer:16*1024*1024});
appendFileSync(${JSON.stringify(join(directory, 'cli-actions.ndjson'))},JSON.stringify({caller:${JSON.stringify(caller)},operationId:${JSON.stringify(operationId)},argv:args,stdin:input.toString(),status:r.status,stdout:r.stdout?.toString(),stderr:r.stderr?.toString(),error:r.error?.message})+'\\n');
if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exit(r.status??1);
`, { mode: 0o700 })
  const preface = `Tool bridge for this isolated behavior observation: both bare amux and $AGENTMUX_CLI in the production packet map to ${JSON.stringify(executable)}. At the start of each shell invocation set the task-local AGENTMUX_CLI to this exact path, then invoke node "$AGENTMUX_CLI"; do not use the inherited parent CLI. It reaches the original private business/resource owners using the explicitly delegated fixture Core caller ${caller} for operation ${operationId}. You are an actual native model task; this does not identify your native task as that physical Provider Session. Runtime I/O in this fixture is controlled. Use this CLI for original work/context and knowledge reads/writes; do not access resource files directly. Temporary stdin JSON files belong only in ${JSON.stringify(directory)}. Complete the production task below, preserving original unknown outcomes. Do not inspect test source, assertions or evaluation notes.\n\n`
  const supplied = preface + production
  await writeFile(join(directory, 'tool-preface.txt'), preface)
  await writeFile(join(directory, 'supplied-input.txt'), supplied)
  return { executable, productionInputSHA256: digest(production), suppliedInputSHA256: digest(supplied), toolPrefaceSHA256: digest(preface) }
}
