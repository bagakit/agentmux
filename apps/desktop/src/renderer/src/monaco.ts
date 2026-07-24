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
  __agentmuxFileEditingProbe?: {
    value(): string | null
    setValue(value: string): void
  }
}
resourceWindow.__agentmuxMonacoModelCount = () => monaco.editor.getModels().length
const mountedEditorModel = () => monaco.editor.getEditors()
  .find((editor) => editor.getDomNode()?.isConnected)
  ?.getModel() ?? null
resourceWindow.__agentmuxFileEditingProbe = {
  value: () => mountedEditorModel()?.getValue() ?? null,
  setValue(value) {
    const model = mountedEditorModel()
    if (!model) throw new Error('File editing probe has no Monaco model')
    model.setValue(value)
  }
}
