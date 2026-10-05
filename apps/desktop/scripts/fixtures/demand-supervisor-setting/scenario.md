# Goals requester Supervisor preference

Owning behavior: [负责人、相关会话与当前推进](../../../../../docs/design/behavior/goals-and-demand.md#负责人相关会话与当前推进).
Presentation: [协作关系与持续推进](../../../../../docs/design/presentation/goals-and-demand.md#协作关系与持续推进的呈现).

The private renderer mounts the original SettingsPanel and GoalsSettingsPane through the Desktop UI adapter, shell styles and original preview API. Native clicks edit and save the default checked requester choice; 1080px and 420px light/dark full frames show the real pane, note, checkbox and Save feedback. It does not mount App, launch Agents or read user configuration. Durable Main/CLI ownership is proved separately by verify-demand-supervisor-setting.mjs; screenshots require independent visual approval.
