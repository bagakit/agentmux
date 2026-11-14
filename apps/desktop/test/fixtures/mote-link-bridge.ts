import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSpaceLinkParams, parseSpaceLinkResult } from '../../../../packages/core/src/space-link'
import { transformMoteLinkSource } from '../mote-object-links-mutations.mjs'
/** Execute the original registration and preload closure. Electron transport/authentication remains its existing owner. */
export function originalMoteLinkBridge(call: (method: string, input: any) => Promise<any>) {
  const root=resolve(import.meta.dirname,'../../../..'),relative='apps/desktop/src/main/ipc.ts'
  const source=transformMoteLinkSource(readFileSync(resolve(root,relative),'utf8'),relative,'original-main-registration')
  const file=ts.createSourceFile(relative,source,ts.ScriptTarget.Latest,true),parts:string[]=[]
  function visit(node:ts.Node){
    if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(file)==='linkPublications'))parts.push(node.getText(file))
    if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(file)==='handleWithEvent'&&node.expression.arguments[0]?.getText(file)==="'spatial:ensureLink'")parts.push(node.getText(file))
    ts.forEachChild(node,visit)
  }
  visit(file);if(parts.length!==2)throw Error('Expected one original publication map and IPC registration')
  let handler:Function|undefined
  const compiled=ts.transpileModule(parts.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext}}).outputText
  new Function('handleWithEvent','callUserRpc','parseSpaceLinkParams','parseSpaceLinkResult',compiled)((channel:string,fn:Function)=>{if(channel!=='spatial:ensureLink'||handler)throw Error('Original IPC registration mismatch');handler=fn},call,parseSpaceLinkParams,parseSpaceLinkResult)
  const preload='apps/desktop/src/preload/index.ts',preloadSource=transformMoteLinkSource(readFileSync(resolve(root,preload),'utf8'),preload,'original-preload')
  const preloadFile=ts.createSourceFile(preload,preloadSource,ts.ScriptTarget.Latest,true),properties:string[]=[]
  function property(node:ts.Node){if(ts.isPropertyAssignment(node)&&node.name.getText(preloadFile)==='ensureLink')properties.push(node.getText(preloadFile));ts.forEachChild(node,property)}property(preloadFile)
  if(properties.length!==1)throw Error('Expected one exact original ensureLink preload consumer')
  return new Function('ipcRenderer','return ({'+properties[0]+'})')({invoke:async(channel:string,input:any)=>{if(channel!=='spatial:ensureLink')throw Error('Wrong original IPC channel');return handler!({sender:'controlled original document'},input)}}) as {ensureLink(input:{spaceId:string;eventId?:string;operationId:string}):Promise<any>}
}
