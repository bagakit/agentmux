# 性能技术剖面

本文说明当前性能证据由谁产生、怎样接到产品和公共入口，以及每层能回答什么。行为约束归[资源面板](../design/behavior/settings-and-observation.md#status-bar-cpumemory-资源面板)，诊断引用与安全投影归 [Diagnostic Evidence](../design/diagnostic-evidence.md)；操作方法归 [Core system 指南](../../packages/core/guides/modules/system.md)，准确参数由该版本 CLI help 持有。

## 从进程到调用者

性能定位先确认实际运行的构建、进程及创建身份，再核对同一来源的区间增量。Main、主 Renderer、Browser、GPU、Agent Run 和 Runtime 是不同成本主体。界面显示的脚本名称、Session 数量或某个累计计数不能代替成本归因。

| 层 | 当前 owner 与消费者 | 能回答的问题与边界 |
| --- | --- | --- |
| 进程资源 | [ProcessResourceSampler](../../apps/desktop/src/main/process-resource-sampler.ts) → [metrics port](../../apps/desktop/src/main/resource-usage-control.ts) → Performance／公共 metrics | 准确进程的区间 CPU、RSS 与身份；组的 reading peak 不是区间平均，RSS 不证明持有者或泄漏。 |
| Host 环境 | [HostResourceObserver](../../apps/desktop/src/main/host-resource-observer.ts) → 原共享 sampler／diagnostics → metrics／Performance 总览 | 全 Host 容量口径的区间 CPU、物理内存、平台 Swap／压力与准确接口吞吐；不相加物理／VPN 流量，不归因给 App／Run，不从空闲内存猜压力。卷容量仍来自原 Main home 卷观察。 |
| Renderer 业务活动 | [renderer-performance](../../apps/desktop/src/renderer/src/lib/renderer-performance.ts) → 原 metrics Renderer source | 状态检查、提交、写入、交互与观测成本；检查次数不是 CPU，parser callback wall time 不是纯解析成本。 |
| V8 函数样本 | [RendererV8Profiler](../../apps/desktop/src/main/renderer-v8-profile.ts) → 原 metrics capture → [共享分析器](../../packages/core/src/v8-profile-analysis.ts) → [Performance](../../apps/desktop/src/renderer/src/components/performance/PerformanceCapture.tsx)／[本机分析](../../packages/core/src/v8-profile-analysis-cli.ts) | 原生成脚本的 self／inclusive 权重、行列和调用者；不保证原 TS 模块、全部 native 或 worker CPU。 |
| 浏览器管线 | [RendererTimelineTracer](../../apps/desktop/src/main/renderer-trace.ts) → 原压缩 trace | 原线程上的脚本、Style／Layout、Paint 与合成事件。按实际 PID／线程和区间去重；没有调度 CPU 数据时，事件 wall time 不能代替线程 CPU。 |
| 内存 | [RendererMemoryInspector](../../apps/desktop/src/main/renderer-memory.ts)、[allocation sampler](../../apps/desktop/src/main/renderer-allocations.ts) 与 [heap owner](../../apps/desktop/src/main/renderer-heap-snapshot.ts) | heap／backing 点读、采样窗口内存活分配或显式对象持有关系，各有范围；计数可能重叠，不能拼成全部 RSS 分账。 |
| 现场组合 | [PerformanceSceneOwner](../../apps/desktop/src/main/performance-scene.ts) → [安全诊断投影](../../packages/core/src/performance-scene-evidence.ts) | 串行阶段的原身份、区间、原件与失败／unknown；不是同一时刻的全系统快照。 |

原采样器以同一个消费时钟独立读取 App／Main，进程树扫描保持单笔在途。扫描完成只合入本来源结果和真实时间，随后由正常发布消费；不会重读 App 或额外制造一帧。公共首帧因而可含可用 App 和仍 pending 的进程树；任何一源的迟到、失败或换代都不刷新另一源的年龄。

显式 Renderer 时间线请求 Chromium 的 `devtools.timeline.stack`，在平台实际提供时保留脚本触发样式或布局的调用位置；它不是完整 CPU 采样，也不保证每个事件都有栈。节点级 invalidation tracking 不属于默认录制。回执的 `requestedCategories` 保存原 producer 当时请求的类别与顺序，不与当前 reader 的录制列表强制相等；读取旧原件不能补造当时没有的栈。调用栈中的名称和 URL 只随原显式材料导出，不写入普通安全诊断投影。

各层沿原公共 owner 接线。分析器是无 IO 的便携纯函数，不持有 Session、进程、debugger 或历史；本机 CLI 只转换用户明确指定的导出文件，不创建另一套服务事实。[Performance 本机导入](../../apps/desktop/src/renderer/src/components/performance/PerformanceProfileImport.tsx)通过用户选择的 `File` 读取有界原字节，复用同一解析、加权分析和技术摘要；[共享视图](../../apps/desktop/src/renderer/src/components/performance/PerformanceProfileView.tsx)同时服务原现场和导入结果。文件选择与下载归 client，Core 不引入文件系统或 UI 服务。

## 函数样本的解释

分析器保留原调用树和 `timeDeltas`。self 权重只分配到实际采样节点，inclusive 权重再沿树聚合；父子 inclusive 不能相加计算总工作。脚本热度按原 URL 聚合，属于生成脚本，不能从 bundle 名推断 React 组件或业务模块。

技术摘要分别报告 profile 的原始起止时长、样本数、加权时长、最大样本间隔及末次样本至结束的未代表尾段。权重超过原区间时保留负尾段和异常，不裁剪或归一化成正常；这些数字都不是进程 CPU 覆盖率或丢样率。idle 和 GC 仅识别精确 V8 合成节点，其余无法归属的样本保持未知；四类只分 self 权重。

GUI 与离线分析共用上述解释及 `agentmux.v8-profile-analysis.v1` 技术摘要。裸 `.cpuprofile` 没有可验证的 PID、进程创建身份或构建归属；本机报告保留输入原字节 SHA，捕获回执另行关联，不能用文件名补造身份。派生摘要限制展示行、调用者深度和标签长度并报告省略，原文件不变。默认诊断封套继续只读安全投影，不能将函数名、原 URL 或源代码自动写入日志、上传或扩散到普通查询。

## 复用成熟分析工具

[Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)和 [VS Code 性能排障](https://github.com/microsoft/vscode/wiki/Performance-Issues)采用先找高成本进程、再分析 profile 的路径。这里复用平台采集，不引入常驻探针或第三套 profiler。

- 函数树和对象持有链分别交给 DevTools CPU／Memory；显式离线 profile 也可用 [speedscope](https://github.com/jlfwong/speedscope) 查看。通用查看器不证明构建或对象身份相同。
- 跨线程 timeline 使用 [Perfetto UI／Trace Processor](https://perfetto.dev/docs/analysis/perfetto-sql-getting-started)；固定查询和原材料能够复现分析，避免临时手工累加嵌套事件。无原调度数据时不输出推测的线程 CPU。
- source map 只有与实际 bundle 内容绑定才可用于源码归因；当前构建未生成这样的映射，不能拿当前 checkout 解释旧包的行列。

## 当前可观测边界

当前内置函数采集针对 Renderer V8 主目标，尚无 Main 的对应函数采集入口；OS 原生栈中的匿名 JIT 地址也不能还原为准确 JS owner。Worker、GPU 和系统压力须各看自己的证据，不用 Renderer idle 或无长任务宣布它们没有成本。

Main 函数采集、构建绑定的源码映射和完整 RSS 对象归因仍是不同的能力缺口。现有采集和共享分析不代签这些能力已实现，也不因一次 RSS 回落或对象计数稳定宣布长期无泄漏。
