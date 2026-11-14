# 原 Profile 的 SOCKS TCP 原生验收

从仓库根目录运行 `node apps/desktop/scripts/verify-browser-proxy-transport-tcp.mjs`。运行器复用现有 Electron、esbuild 和依赖，将当前 Core CLI、Control endpoint worker 与真实 Main owner 编译到本树产物；不安装包，不运行或替换用户 App。

夹具使用私有 home、独立 Profile metadata、原加密凭据 owner、真实 native Session 和隐藏 BrowserWindow。它启动本地 HTTP、HTTPS 与有认证／无认证 SOCKS5 TCP 服务；仅允许连接这些夹具端口。HTTPS 只在这些私有 Session 中接受准确主机和准确 leaf 证书，另一 leaf 必须真实拒绝；不改全局证书策略。公开证书与 fingerprint 留在收据中，私钥随私有 home 清理。

第一进程创建 direct、plain SOCKS 和 authenticated SOCKS 三个原 Profile。真实页面与 HTTPS CONNECT、普通 HTTP、compiled CLI → JSON-RPC → 原 network owner 的 check/probe 分别核对线路。原 Session 的私有代理 capability 不能供其他 Session 或任意本机客户端使用，也不能转发到目标站。认证拒绝仅使准确请求失败；明确修正凭据后恢复。证书拒绝和凭据观察未知不能改写或关闭已经健康的线路，三份原页面与站点数据继续保留。

第一进程退出后，第二个不同 PID 从原 metadata、原 encrypted credential 文件和原 native partition 恢复；不重新创建身份或重种站点数据。原 Profile ID、配置、partition、native storagePath、cookie、localStorage、IndexedDB 与页面草稿必须相同。第二进程先经 compiled CLI 只读原 operation 的历史，外部 wire 同时核对没有新代理连接，然后才显式发起新的检查。此证明不代签完整 Desktop 工作面或 Agent Run 恢复。

运行器记录源码／产物 SHA、准确原 PID、退出与残留、证书、wire 和各 owner 回执；失败也保留原收据。`node apps/desktop/scripts/verify-browser-proxy-transport-tcp-mutations.mjs` 将四个变异分别载入真实生产 transport 模块，要求真实 native 业务断言 RED，并逐项恢复原源码取得 GREEN；原文件不被改写。

这里仅验收 TCP。成功收据始终保留 `taskComplete: false` 与 `unfinished: ['UDP relay', 'QUIC']`。TCP owner 回归位于 `apps/desktop/test/browser-proxy-authenticated-tcp.test.ts`；不能用本夹具或这些测试代替完整 UDP／QUIC 任务的验收。
