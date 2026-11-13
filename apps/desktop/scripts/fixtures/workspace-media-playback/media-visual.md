# 工作区媒体播放真实 Renderer 采图场景

本说明对应 [main.cjs](./main.cjs) 驱动的采图与重启两段进程，由 [verify-workspace-media-playback.mjs](../../verify-workspace-media-playback.mjs) 构建并执行。设计预期只读取当前 SSOT：交互合同的 [主观审美端到端验证](../../../../../docs/design/behavior/shared-rules.md#agent-主观审美的端到端验证)、[本地链接的真实格式预览与二进制保全](../../../../../docs/design/behavior/files-and-git.md#本地链接的真实格式预览与二进制保全)，以及密度合同的 [主观审美判断边界](../../../../../docs/design/presentation/shared-rules.md#agent-主观审美的判断边界)、[本地文件查看与编辑表面](../../../../../docs/design/presentation/files-and-git.md#本地文件查看与编辑表面)。此处不复制设计规则。

## 真实入口与操作

[entry.tsx](./entry.tsx) 初始化真实 store，挂载 `FileExplorer`、`WorkspaceWorkbench` 与 `WindowOverlayHost`，使用产品 `styles/index.css`；页面的 Content-Security-Policy 在构建时从产品 `renderer/index.html` 原样注入。HTML 只设宿主根容器尺寸。Main 侧是真实的 `WorkspaceFiles`、`WorkspaceMediaStreams` 与 `AgentMuxSpatialStateStore`，经生产 preload 暴露；File 通过 store 的 `openFile` 打开，与人点击文件树走同一入口。

| 帧 | 实际操作 | 观察对象 |
| --- | --- | --- |
| `video-start-dark` | 打开 55 MB H.264/AAC 的 `promo.mp4`，等首帧，空闲 5.5 秒不播放 | 开播前主播放圆盘、画面适配后的舞台 |
| `video-controls-dark` / `-light` | 播放、暂停、拖到 80%，唤出控件并悬停进度条 35% 处 | 玻璃控件条、已缓冲范围、指针处时间气泡、明暗主题 |
| `video-narrow-dark` | 右侧并排 `notes.md`，视频 Region 约 34% 宽 | 窄 Region 中保留的播放、静音、时间与全屏 |
| `audio-card-dark` / `-light` / `-narrow-dark` | 打开 `tone.m4a`，再并排到约 30% 宽 | 音频卡片、主绿走带控件、窄宽度下的收起 |
| `hls-vod-dark` | 打开本地 HLS 点播 `hls/index.m3u8` | 列表播放与点播时长 |
| `live-dark` / `-light` | ffmpeg 正在写入的 `live/live.m3u8`，播放超过 2 秒后再观察 15 秒 | LIVE 标记、无伪造总时长、明暗主题 |
| `deleted-dark` | 打开 `doomed.mp4` 后删除文件，拖到 95% 读取从未取过的尾部 | 「File was deleted」而不是格式不支持 |
| `restart-dark` | 同 profile 第二个进程启动 | 原 Tab、Region 与 File 引用恢复后重新解码 |

## 断言与边界

行为断言写在 [main.cjs](./main.cjs)：开播前读取量小于整份文件且空闲 4 秒增长不超过 1 MiB，拖动产生非零起点的 206，观看与拖动后总读取仍小于文件；窄 Region 四类控件可命中；直播 15 秒内列表请求不超过 20 次；删除后的失败原因来自租约事实；生产 CSP 不拦任何媒体请求；重启后 Tab 与布局和退出前落盘的一致。PNG 成功不代表审美通过。

媒体全部由 ffmpeg 现场生成（测试图与正弦音），不含真实用户内容。Session、Git 与 Host 只在 API 边界给出空集或「非 Git 仓库」，不代表这些能力的验收。远端 Workspace 的播放不在本场景内。
