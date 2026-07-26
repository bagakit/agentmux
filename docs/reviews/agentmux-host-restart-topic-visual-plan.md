# AgentMux Host、重启恢复与 Topic 头像修复计划

状态：approved（用户已确认三项回归并要求直接修复）

## 保护目标

桌面 App 从 GUI 启动时必须发现本机可执行的 Agent CLI；重启后必须先恢复原有 Workbench 布局，再按同一持久化根目录恢复 Agent Session；Scratch Topic 中的头像只把“正在运行”表达为外描边/发光，其余头像保持无边框并灰度化。

## 约束与证据

- Host discovery 的 owner 是 Desktop main 启动时的 PATH hydration 与 Core `hasExecutable`，不能在 Renderer 另造 Provider 清单。
- Workbench 布局是 Renderer 持久化事实，Session/Provider handle 是 Core 持久化事实；二者必须绑定同一个 Electron `userData`，空 snapshot 或路径漂移不得静默裁剪布局。
- Topic Agent 头像沿用既有 Provider 图标和状态语汇；运行态才产生视觉强调，停止态不画常驻边框。

## 任务与验收

1. GUI Host PATH hydration：login-shell 交互探测失败时，以非交互 login shell 和已有 PATH 合并重试；Provider discovery 对可执行 codex/claude 返回 available，并保留可见的探测降级信息。
2. Restart Workbench/Session recovery：统一 Desktop userData 路径，恢复流程在 snapshot 暂不可用时保留原 Region；有效 recovery candidate 到达后沿用原 View/Region，不要求用户先点 Resume。
3. Topic avatar states：删除常驻 avatar border；working/running 显示外描边或 glow，非运行态 grayscale；状态、图标与点击导航保持既有语义。

每个任务都必须有针对生产接线的回归测试；删掉接线或把状态塌缩回旧行为时测试必须变红，并执行定义文件之外的 zero-caller 检查。
