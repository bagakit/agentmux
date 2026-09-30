import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const args=process.argv.slice(2)
assert.ok(args.length===0 || args.length===1 && ['--only=presentation','--only=tab-view'].includes(args[0]),'Select the actual collection slice, --only=presentation or --only=tab-view; unknown/empty selections are rejected.')
const presentation=args[0]==='--only=presentation', tabView=args[0]==='--only=tab-view'
const helper='apps/desktop/src/renderer/src/lib/survey-workface.ts', store='apps/desktop/src/renderer/src/store.ts', global='apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', editor='apps/desktop/src/renderer/src/components/EditorPane.tsx', choices='apps/desktop/src/renderer/src/components/SurveyPanelChoices.tsx'
const app='apps/desktop/src/renderer/src/App.tsx'
const mutations=tabView ? [
 {label:'explicit-exact-tab-view',file:app,before:"{ kind: 'tab', tabId: surveySelection.active.tabId } : { kind: 'zone', zoneId: surveySelection.zoneId }",after:"{ kind: 'zone', zoneId: surveySelection.zoneId } : { kind: 'zone', zoneId: surveySelection.zoneId }"}
] : presentation ? [
 {label:'collapse-explicit-control',file:global,before:'onClick={() => setSidebarCollapsed(true)}',after:'onClick={() => setSidebarCollapsed(false)}'},
 {label:'restore-explicit-control',file:global,before:'onClick={() => setSidebarCollapsed(false)}',after:'onClick={() => setSidebarCollapsed(true)}'},
 {label:'keyboard-wrap-owner',file:editor,before:'onCheckedChange={() => toggleWordWrap()}',after:'onCheckedChange={() => {}}'},
 {label:'chooser-exact-nonfirst-target',file:choices,before:'ordinal={ordinal} onSelect={onSelect}',after:'ordinal={ordinal} onSelect={() => onSelect(choices[0]!)}'}
] : [
 {label:'browser-kind',file:helper,before:"region.kind === 'browser'",after:"region.kind === 'agent'"},
 {label:'exact-browser-member',file:helper,before:'tab.regionIds.some(regionId =>\n    browserRegions.has(JSON.stringify([tab.tabId, regionId])))',after:'browserRegions.size > 0'},
 {label:'explicit-ui-write',file:store,before:'set({ surveyCollectedZones: { ...state.surveyCollectedZones, [zoneId]: true } })',after:'set({ surveyCollectedZones: state.surveyCollectedZones })'},
 {label:'retained-ui-restore',file:helper,before:'.filter(([id, collected]) => id.length > 0 && collected === true)',after:'.filter(() => false)'},
 {label:'selection-does-not-mint',file:store,before:'setSurveyZoneSelection(surveyZoneSelection) { set({ surveyZoneSelection }) }',after:'setSurveyZoneSelection(surveyZoneSelection) { set({ surveyZoneSelection, surveyCollectedZones: surveyZoneSelection ? { [surveyZoneSelection.zoneId]: true } : {} }) }'},
 {label:'note-explicit-caller',file:store,before:'get().setSurveyZoneCollected(target.zoneId, true)',after:'void target.zoneId'},
 {label:'unknown-held-occurrence',file:global,before:'if (held?.zoneId !== zoneId) setSelection',after:'if (true) setSelection'}
]
assert.ok(mutations.length>0,'Actual selected loaded cases must be nonempty.')
for (const mutation of mutations) assert.equal((await readFile(mutation.file, 'utf8')).split(mutation.before).length - 1, 1, `Unique actual Source anchor: ${mutation.label}`)
await verifyRendererSourceMutations({name:`survey-collection-${tabView?'tab-view':presentation?'presentation':'behavior'}-${Date.now()}`,owningConfig:'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
 tests:tabView?['apps/desktop/test/survey-surface.test.tsx']:presentation?['apps/desktop/test/survey-surface.test.tsx','apps/desktop/test/file-preview-pane.test.tsx']:['apps/desktop/test/survey-collection.test.ts','apps/desktop/test/survey-surface.test.tsx','apps/desktop/test/note-survey-presentation.test.tsx'],
 sources:[helper,store,global,editor,choices,...(tabView?[app]:[]),'apps/desktop/test/helpers/composer-dom-fixture.tsx'],mutations})
