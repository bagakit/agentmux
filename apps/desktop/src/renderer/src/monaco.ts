import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { typescript as monacoTypeScript } from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { getUnregisteredDetectedLanguageIds } from './lib/language-detect'
import { registerAstroLanguage } from './lib/monaco-languages/register-astro'
import { registerJsonlLanguage } from './lib/monaco-languages/register-jsonl'
import { registerSvelteLanguage } from './lib/monaco-languages/register-svelte'
import { registerVueLanguage } from './lib/monaco-languages/register-vue'

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

registerVueLanguage(monaco)
registerSvelteLanguage(monaco)
registerAstroLanguage(monaco)
registerJsonlLanguage(monaco)

const unregisteredDetectedLanguages = getUnregisteredDetectedLanguageIds(
  monaco.languages.getLanguages().map((language) => language.id)
)
if (unregisteredDetectedLanguages.length > 0) {
  throw new Error(
    `Language detector returned unregistered Monaco ids: ${unregisteredDetectedLanguages.join(', ')}`
  )
}

// Adapt Orca's sandboxed Monaco setup to AgentMux's editable, single-file
// surface. The worker cannot resolve the Workspace module graph, so semantic
// and suggestion diagnostics create false unresolved-import errors. Keep
// syntax validation enabled because AgentMux edits complete files, not diffs.
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: false
}
monacoTypeScript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTypeScript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTypeScript.typescriptDefaults.setCompilerOptions({
  ...monacoTypeScript.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTypeScript.JsxEmit.Preserve
})
monacoTypeScript.javascriptDefaults.setCompilerOptions({
  ...monacoTypeScript.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTypeScript.JsxEmit.Preserve
})

loader.config({ monaco })

const resourceWindow = window as typeof window & {
  __agentmuxMonacoModelCount?: () => number
  __agentmuxMonacoEditorCount?: () => number
  __agentmuxFileEditingProbe?: {
    value(): string | null
    setValue(value: string): void
  }
}
resourceWindow.__agentmuxMonacoModelCount = () => monaco.editor.getModels().length
resourceWindow.__agentmuxMonacoEditorCount = () => monaco.editor.getEditors().length
// 隐藏的 Tab 不再被卸载（改用 visibility:hidden 保活），而 visibility:hidden 的节点 isConnected
// 仍是 true——所以「第一个连着的 editor」会一直是先打开的那个，读数永远停在旧文件上。判定必须再问
// 一句「它在不在隐藏区里」，取用户真正看得见的那个。
const mountedEditorModel = () => monaco.editor.getEditors()
  .find((editor) => {
    const node = editor.getDomNode()
    return node?.isConnected === true && node.closest('.pane-body__region[data-active="false"]') === null
  })
  ?.getModel() ?? null
resourceWindow.__agentmuxFileEditingProbe = {
  value: () => mountedEditorModel()?.getValue() ?? null,
  setValue(value) {
    const model = mountedEditorModel()
    if (!model) throw new Error('File editing probe has no Monaco model')
    model.setValue(value)
  }
}
