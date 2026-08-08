# Desktop delivery Goal and final acceptance review

Review: approved

授权来源：用户已要求完成约定改进并重新安装，随后明确要求创建
bagakit-feature-tracker 与 bagakit-set-loop-goal，使 compact 后能恢复具体清单。
本次只固化已确认范围与交付证据，不引入新产品功能。

复用七个既有 Feature。清单为 `docs/delivery/desktop-experience-update-2026-09-10.md`。
可执行 Goal 绑定 `f-24n8fj87m` 的安装交付边界；其他 Feature 保留独立实施与 closeout 所有权。

计划修订保留 T-001 和进行中的 T-002 的全部语义、验证与依赖，不重置既有 gate。
新增 T-003 验收安装后的前端切换、回切和会话连续性，依赖 T-002：
真实安装后的 loader 是开始这项验收的必要输入。命令检查可以提前准备，但不能替代
安装实例的最终观察。T-003 是验收汇合点，没有下游实施任务，不增设仪式性任务。
其余六个 Feature 的既有结果作为共同候选的输入证据核对，不建立阻止 T-002 排障的循环依赖。

T-003 的命令 gate 检查更新、回切、草稿与终端合同；manual 证据必须补齐安装身份、
实际 activation/rollback 回执、前后 Session/Run/PID、用户状态保持及相关 Feature closeout。
命令绿不能独自关闭任务。若候选发生变化，受影响验证和安装实例验收须重新绑定该候选。
复用安装工作树的 Git 分支作为候选恢复点，精确 SHA 留在验证证据，不放进稳定 Goal。

现有设计 SSOT 已覆盖上述行为；本次只为其分层更新章节增加交付清单索引。
Goal 采用 terminal / state，以实际安装验收及 Tracker closeout 为停止条件；
不得以历史布局需求扩大本 Goal，也不得掩盖它们尚未交付。

## 安装 gate 排障：项目身份

隔离原生探针在 `file editing Workspace project` 等待超时。项目行的 tooltip 已按
既有需求增加状态说明，但探针仍把整个 title 当成目录身份做等值匹配。
在 T-002 的原有安装验证范围内修复探针：使用产品已暴露的 `data-workspace-id`，
从已核实的 fixture Workspace 传入 ID，不删状态说明或放宽原生交互断言。
复跑同一原生探针及完整安装 gate；将选择器改回旧 title 时须重现红灯，
`runDesktopFileEditingProbe` 的生产调用仍在 Main 启动路径。
