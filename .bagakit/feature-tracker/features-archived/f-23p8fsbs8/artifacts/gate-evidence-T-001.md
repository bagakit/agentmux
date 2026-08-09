# T-001 gate 证据：6 个失败全部不属于本 task

- feature: f-23p8fsbs8
- task: T-001 工具输出接进时间轴
- 提交: `45c53df`
- gate 日志: `gate-T-001-r6-0001.log`
- 日期: 2026-08-30

gate 跑的是整个 `packages/core/test`，因此扫进了并行 agent 的在途改动与机器负载噪音。
本 task 自己的用例全绿：core 47 项、desktop 68 项，共 115 项。

## 逐条归因

| 失败 | 归属 | 证据 |
| --- | --- | --- |
| `session-timeline.test.ts` 单调修订 | **他人在途，已由我修好** | `85f3c00` 把存储改成 JSONL version 3，这条用例仍手写 `version: 2` 的 fixture，被格式校验抢先拒掉。改一个版本号即 11/11 全过，单独提交 `5b13963` |
| `agentmux-cli-help.test.ts` ×3 | **机器负载** | 断言只接受 `CONTROL_UNAVAILABLE/TAB_NOT_OPEN/CONTROL_FAILED`，实际返回 `CONTROL_TIMEOUT`——没有桌面端在跑时的第四种合法结局，负载下超时先到。load average **234**，247 个 node 进程。**该测试不 import 我改的任何模块**（`hook-tool-outcome`/`timelineRows` 在 CLI 侧零引用） |
| `package-consumer.integration.test.ts` | **环境**：npm 离线缓存未命中 | `npm error code ENOTCACHED ... request to registry.npmjs.org/yaml failed: cache mode is 'only-if-cached'` |
| `reliability-stress.integration.test.ts` | **机器负载**：吞吐断言 | `fast Consumer observed only 2836550 bytes before the final marker`；该文件 0 处引用 `toolOutput` |
| `real-codex` / `real-hermes` integration | **环境**：需要真实 Provider CLI | 收集阶段即失败，与本次改动无关 |

失败测试文件没有一个出现在本次提交里；两个 integration 测试对 `toolOutput` 零引用；
CLI 测试对我新增的两个模块零引用。

## 本 task 自己的质检

14 个变异全部会红，覆盖四层：

| 层 | 变异 | 结果 |
| --- | --- | --- |
| 采集规则 | 不截断 / 静默截断 / 退出码 0 也判失败 / 用空串伪造缺席 | 4 红 |
| Core 接线 | 不采集 / 忽略失败恒盖 complete / 事前事件也采集 / 丢掉 toolOutput | 4 红 |
| 校验器 | `session-timeline` 丢掉线上的 toolOutput | 1 红 |
| 渲染接线 | 折叠留错行（原缺陷）/ 无结果行顶掉有结果行 / 失败不算结果 / View 退回旧折叠 / 输出不渲染 | 5 红 |

其中「失败不算结果」一条**先存活了**：fixture 把失败行放在后面，被「都没结果时后来者为准」
的兜底架空。已把顺序倒过来，现在会红。

零调用者检查：`hookToolOutcome`、`MAX_TOOL_OUTPUT_CHARS`、`timelineRows`、`toolOutput`
均有生产侧调用者（3/3/3/8 处），无死代码。
