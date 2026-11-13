import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { desktopRpcMethods } from '../src/main/desktop-rpc-exposure.js'
import { isStandaloneBrowserObjectRequest, unsupportedDesktopBrowserObject } from '../src/shared/browser-object-host-policy.js'

it('the actual Desktop public composition refuses object-only lifecycle before invoking its renderer owner and reports accurate discovery',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'amux-desktop-browser-scope-')),socketPath=join(directory,'c.sock')
  let invoked=false
  const server=new AgentMuxControlServer({socketPath,exposedMethods:desktopRpcMethods(),coreClients:()=>[],execute:async()=>{invoked=true;throw new Error('Wrongly reached Renderer workface creation')}})
  await server.start();const client=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socketPath}})
  try {
    for(const [method,params] of [['browser.create',{operationId:'create',url:'about:blank'}],['browser.close',{operationId:'close',browserId:'b',navigationId:'n'}]] as const){
      await expect(client.call(method,params)).rejects.toMatchObject({code:'HOST_CAPABILITY_UNAVAILABLE'})
    }
    const endpoint=await client.call('system.endpoint',{})
    expect(endpoint.methods).toContain('browser.open');expect(endpoint.methods).not.toContain('browser.create');expect(endpoint.methods).not.toContain('browser.close')
    expect(invoked).toBe(false)
    const source=await readFile(resolve(import.meta.dirname,'../src/main/ipc.ts'),'utf8')
    const ast=ts.createSourceFile('ipc.ts',source,ts.ScriptTarget.Latest,true),compositions:ts.NewExpression[]=[]
    const visit=(node:ts.Node)=>{if(ts.isNewExpression(node)&&node.expression.getText(ast)==='AgentMuxControlServer')compositions.push(node);ts.forEachChild(node,visit)};visit(ast)
    expect(compositions).toHaveLength(1)
    const options=compositions[0]!.arguments![0] as ts.ObjectLiteralExpression
    expect(options.properties.some(property=>ts.isPropertyAssignment(property)&&property.name.getText(ast)==='exposedMethods'&&property.initializer.getText(ast)==='desktopRpcMethods()')).toBe(true)
  }finally{await client.dispose();await server.stop();await rm(directory,{recursive:true,force:true})}
})
it('the original Renderer executeControl body rejects object lifecycle before any spatial open fallback',async()=>{
  const source=await readFile(resolve(import.meta.dirname,'../src/renderer/src/store.ts'),'utf8'),ast=ts.createSourceFile('store.ts',source,ts.ScriptTarget.Latest,true)
  const methods:ts.MethodDeclaration[]=[]
  const visit=(node:ts.Node)=>{if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='executeControl'&&node.body)methods.push(node);ts.forEachChild(node,visit)};visit(ast)
  expect(methods).toHaveLength(1)
  const body=methods[0]!.body!.getText(ast)
  const compiled=ts.transpileModule(`export default async function(request,signal,options)${body}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
  const exports:{default?:(request:unknown)=>Promise<unknown>}={};vm.runInNewContext(compiled,{exports,isStandaloneBrowserObjectRequest,unsupportedDesktopBrowserObject})
  for(const operation of ['browser.create','browser.close'])await expect(exports.default!({operation})).rejects.toMatchObject({code:'BROWSER_OBJECT_HOST_UNSUPPORTED'})
})
