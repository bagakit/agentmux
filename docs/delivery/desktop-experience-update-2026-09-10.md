# 桌面体验与分层更新交付清单

这份清单固定用户所说的「本轮约定」的范围，用于 compact、重启和交接后恢复。
它只索引需求与验收所有者，不维护任务状态；状态、gate、阻塞和证据以 Feature Tracker
的 `state.json`、`tasks.json` 和 `owner-receipt.json` 为准。Feature 归档后按相同 ID
从 Tracker 索引查找，不因原目录移动而重建 Feature。

## 范围与所有者

| 用户需求 | Feature | Task |
| --- | --- | --- |
| Split 与同类菜单 hover 即展开，能一下解决的不多点一下 | `f-24n8fj87m` / hover-menu | T-001 |
| 键盘帮助移到项目栏底部设置右边 | `f-24p8fqgte` / explorer-links | T-001 |
| Explorer 显示忽略项；软链接用目标类型图标，目录链接原地展开 | `f-24p8fqgte` / explorer-links | T-002 |
| 输入区可收起；文件引用、截屏、真实技能、快捷指令；中断图标清楚 | `f-24q8ff2aw` / composer-tools | T-001 |
| Projects 层级与项目图标可辨；运行提示、通知详情与定位清楚 | `f-24r8fa4j9` / project-rail-clarity | T-001 |
| 纯前端热更新与回切；宿主更新保留或恢复会话；底层变化单独审查 | `f-24s8f5q7f` / layered-updates | T-001、T-002 |
| Redraw 有真实结果反馈，成功请求后不再让历史缺失横幅一直占顶部 | `f-24t8fnuzz` / terminal-redraw-feedback | T-001 |
| 中文组字不重复旧文字，持续输出不乱码，不依赖手动缩放恢复 | `f-24u8fn4jt` / terminal-ime-rendering | T-001、T-002 |
| 验证共同候选、提交、打包安装重启，并验收已安装版本的更新与会话连续性 | `f-24n8fj87m` / hover-menu | T-002、T-003 |

行为约束由 [Desktop interaction](../design/agentmux-desktop-interaction.md) 持有，
视觉约束由 [Surface density](../design/agentmux-surface-density.md) 持有；本清单不另写一份设计合同。
每项的可证伪 acceptance、verification command 和实施证据读取上表对应 Task。

## 交付边界

最终安装验收复用 `f-24n8fj87m`，消费其余六个 Feature 的已验证结果，不重建实施任务。
交付必须能核对共同候选、安装副本与运行实例的身份；实际执行相容前端更新及回切，
核对 Session、Run 和进程连续性，以及草稿、未保存内容和布局保留。
仅有提交、构建成功、单测通过或「已请求重启」不能替代安装后证据。
合成输入事件与真实系统输入法实测须明确区分，不能把前者写成后者。

实现任务依项目规则保存变异红绿和排除定义文件的非空生产调用证据；扫描测试必须证明扫描非空。
参与交付的 Feature 完成任务后还须执行 closeout，不能把 `pending_closeout` 当成交付完成。
既有安装重启授权持续有效；只有无法保留或恢复 Session 的有损重启需要再次确认。

## 历史需求边界

文件树「作为项目打开」、自定义 Executor 创建与完整元信息、分屏重复加载、Region 空间判断
及独立布局包仍由 `file-tree-open-as-project` 与 `agent-spatial-control` 等原 Feature 持有。
它们没有因为这份交付清单而被取消或完成；本次安装不能被表述成所有历史需求都已交付。

## 恢复入口

先读 `.bagakit/feature-tracker/features/f-24n8fj87m/goal.md`，再核对同目录
`owner-receipt.json`、`state.json`、`tasks.json`；实际工作树从 state 解析。
其余 Feature 是独立需求所有者，依据固定 ID 查询其当前或归档记录。
当前提交、失败日志、下一步和机器路径属于执行证据，不写入稳定 Goal。
