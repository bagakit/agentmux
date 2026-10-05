import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const base='apps/desktop/src/renderer/src/', tool=base+'components/TopicFilesTool.tsx'
const selected=process.argv[2]
await verifyRendererSourceMutations({
  name:'ui-design-cohesion/topics-mutations'+(selected?'-'+selected:''), tests:['apps/desktop/test/topics-navigation-quality.test.tsx'],
  sources:[tool,base+'components/WorkspaceFilesFrame.tsx',base+'components/WorkspaceFilesTool.tsx',base+'components/SurfaceToolDock.tsx',
    base+'components/WorkspaceTopicsPanel.tsx',base+'components/TopicNavigationPanel.tsx',base+'components/SelectorList.tsx',base+'styles/topic-knowledge.css',
    'apps/desktop/test/fixtures/topics-navigation-quality.ts','apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx','apps/desktop/test/helpers/file-tree-geometry.ts',
    'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations:[
    {label:'directory-first',file:tool,before:'directoryFirst={presentation.showTopics}',after:'directoryFirst={false}'},
    {label:'reveal-opens-files',file:tool,before:'useAppStore.getState().setExplorerCollapsed(workspace.id, false)',after:'void workspace.id'},
    {label:'reveal-exact-original-root',file:tool,before:'revealRequest?.path ?? (fileTopic && scratch ? scratchTopicLogicalPath(scratch, fileTopic) : null)',after:'topic && scratch ? scratchTopicLogicalPath(scratch, topic) : null'},
    {label:'return-to-topic-clears-old-reveal',file:tool,before:'useEffect(() => setReveal(undefined), [selectedTopicId, workspace.id, categorySpaceId])',after:'useEffect(() => {}, [selectedTopicId, workspace.id, categorySpaceId])'},
    {label:'reveal-stays-in-original-workspace',file:tool,before:'reveal?.request.workspaceId === workspace.id && reveal.selection',after:'reveal?.selection'},
    {label:'category-refresh-consumes-original-owner',file:base+'components/WorkspaceTopicsPanel.tsx',before:"await api.topics.call('topic.category.ls', {})",after:'await Promise.resolve({ categories: [], unavailable: [] })'},
    {label:'later-category-description-wins',file:base+'components/WorkspaceTopicsPanel.tsx',before:'state.topicCategories.find(item => item.spaceId === spaceId) !== category ? state :',after:'false ? state :'}
  ].filter(item=>!selected||item.label===selected)
})
