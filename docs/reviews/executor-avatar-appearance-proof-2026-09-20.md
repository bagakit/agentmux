# Executor avatar appearance

Approved scope: feature f-27q8fjs45, T-002. User: “Agent 图标: 中央由 provider 决定, 设置中可以调整颜色叠加, 左上角可以设置自定义角标…右上角表示状态, 右下角显示数量堆叠…外轮廓描边…邮箱未读…在信封上…交互…分开”; persistence scope confirmed “按执行器配置”. Parent approved the small SettingsNavigation context to reuse App's settings route.

## Delivery

Desktop AppearanceConfig owns an optional agentAvatars map keyed by executor ID. ConfigStore validates/persists tint and short badge text without changing Provider/Core configuration. Appearance settings shows actual Provider avatars for every configured executor, supports preview, independent reset, save, and local save-error feedback. Existing appearance fields are retained on save.

AgentAvatar remains a presentational component: Provider mark at the center, alpha-masked tint, status-colored alpha contour, top-left custom badge, top-right shared status dot, bottom-right count. It does not read config or create a second status map. The shared status dot keeps its hollow/solid shapes and error/waiting glyphs; Avatar styles only position it. The shape is not a rectangular status outline.

SelectorPresence, RegionMosaic, WorkspaceTopicsPanel, BranchesPanel and Session Composer consume executor appearance. Branch stacks group by executor rather than Provider. Their representative status uses the same attention rank as the roster; a working/waiting stack is not hardcoded as ready/running. Counts belong to the Avatar, removing the old second badge implementation.

The Session control row has independent mailbox and identity buttons. Identity opens a native anchored popover with name, Provider, executor and status. Customize avatar goes through SettingsNavigation to App's existing Appearance route. No second settings surface, window-global event or store state was introduced. AgentComposer has separate identity and mailbox slots. SessionMailbox itself is owned by the parallel mailbox task and is untouched here.

## Evidence

- 17 related suites, 236 tests pass: new avatar settings/config tests; existing avatar visuals, Topic status, selection/affordance, Session composer, Branch presence, settings/style/scale/controlled-input/config tests; nonempty-scan guards and IME discovery.
- New tests exercise real settings input and preview, save/reopen/reset, fresh ConfigStore reload, malformed-write retention, local save error, SettingsPanel inventory, Session identity/settings entry, separate mailbox button, per-executor Branch and Topic rendering, shared Region and list paths, Provider mark, count and click propagation.
- Production desktop typecheck passes. Broad test-tree typing retains existing baseline diagnostics; new avatar tests and sources have none.
- Thirteen deliberate production mutants are killed: omit appearance on save; drop durable map; group by Provider; select appearance by Provider in Session/Topic/Branch; drop count; drop tint; replace Provider mark; disconnect settings entry; remove alpha contour; erase shared hollow status; hardcode every Branch stack as running. Restored implementation passes.
- Production caller inspection: SettingsPanel mounts AppearanceSettingsPane with executors; AgentSessionComposer mounts AgentIdentity with executor appearance; AgentIdentity consumes App's SettingsNavigation; both presence paths pass Avatar appearance/count; Branch/Topic read the saved map using executor IDs. No feature exists only in its definition/test file.
- Ego Browser used the actual production components/styles. Native identity popover opened beside the avatar, Customize reached Appearance, changing a badge to QA and saving survived browser reload. Four Provider marks (SVG and raster), running/working/waiting/error, custom badge and count were inspected. At 420px viewport the document remained 420px wide and the popover bounds were x=201..383. Computed style confirmed running is a blue inset ring, working is green, and the Avatar container has no outline. Native preview server/page and temporary harness files were removed afterwards.

Local logs: /tmp/avatar-final-tests.log, /tmp/avatar-final-typecheck.log, /tmp/avatar-final-types.log, /tmp/avatar-mutations.json, /tmp/avatar-final-restored.log. Screenshot: /var/folders/42/0r9mq8cs2ls8hxdpymx51_6c0000gn/T/ego-browser-shot-79664-1.png.

Integration note: this commit is authored after the Topic owner's 9cab37ca, 5647523d and ff83c860 changes. Preserve the parallel mailbox's new system/timeline props and extracted notice hooks when merging AgentSessionComposer; retain this commit's independent identity slot and executor appearance selectors.
