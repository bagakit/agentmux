# Board 继续实现的计划复核

Status: approved。授权来源：用户 2026-09-22 要求将交接剩余项与当前未闭合能力全部继续实现，先更新 Tracker 并提供观测链接。

前提变化：真实代码审查确认 interactiveResize=false 未隔离输入、默认入口仅在 Board 页脚、Wiki 缺少注入测试/updatedAt 消费；交接还包含打包安装和失败的 ctxmux 候选。T-001 保留历史 done，不将历史 gate 解释成完整产品已交付。

同一目标内的修订：修正未开始任务的测试路径；新增独立 T-006 补齐 Wiki 文件与原生 UI 行为，其输出供 T-003 默认浮窗集成。T-002 与 T-006 输入均已具备，可以分文件并行；T-003 依赖两者的集成事实，T-004 接通 CUI 与路由决策，T-005 消费最终候选做恢复/打包/安装验收。独立 Worker 只修改自己负责文件和返回证据，主 Agent 持有 Tracker transitions。

ctxmux 候选不是 Board 的实现前提。用户提供的 c019b00 三红是历史交接证据，需读取原日志复核；未通过对照前维持现有 Runtime，不销毁现有 Run。升级诊断另属 Runtime 交付，不把失败候选写入本 Feature 的完成条件。当前生产基线为 main@089d294a。

纠正原交接编号：T-002 是 Session Region/attachment，T-004 才是 CUI 路由。没有新的产品方向；原 Goal 的全局、同页右半工作面、原生 Topic、多 Region、Runtime 单一归属与重启恢复约束继续成立。
