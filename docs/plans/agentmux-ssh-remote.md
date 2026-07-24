# AgentMux SSH Remote Daemon 方案

状态：T-003 已实现候选

## 结论

SSH 不新增第二套 Session Runtime。Local 与 Remote 都使用同一份 Daemon Protocol、`AgentMuxClient`、Session Manager 和 node-pty Owner；差异只在 Client 如何得到一条双向字节连接。

```text
AgentMuxClient
      │
      ├─ LocalAgentMuxDaemonConnector ── Unix Socket
      │
      └─ SshAgentMuxDaemonConnector
             └─ ssh -T <host> "node agentmuxd connect --socket <path>"
                                      │
                                      └─ 用户私有 Unix Socket
                                             │
                                             └─ 同一个 agentmuxd
```

运行期每个 Client 使用一个长期 `ssh -T` stdio Transport。Write、Resize、Ack、Signal、Stop 和 Event 都走这一条连接，不再为每个输入或状态检查启动 ssh/tmux 命令。短连接 SSH 只用于显式的安装、Activation、Status、Shutdown、Upgrade 和 Uninstall 控制面。

## 身份与握手

Protocol v3 的 Hello 同时携带：

- `protocolVersion`：协议结构身份；
- `buildIdentity`：Remote Artifact／Daemon Build 身份；
- `hostId`：AgentMux 配置中的逻辑 Execution Host 身份；
- `daemonInstanceId`：当前 Daemon 进程实例；
- `daemonPid`：同一用户控制面执行显式 Shutdown 的实时 PID。

SSH Client 仍由系统 OpenSSH 根据用户已有的 `~/.ssh/config`、Agent、硬件 Key、Known Hosts 与交互式认证完成真实主机认证。AgentMux 不复制、读取或保存 Private Key，也不加入 `StrictHostKeyChecking=no`。`hostId` 不是 SSH Host Key 的替代品；它用于阻止一条已认证连接被错误绑定到另一个 AgentMux Host 配置。

重连必须重新通过 Protocol／Build／Host Hello，再由上层按原 `sessionId + incarnationId + output cursor` Attach。Mismatch 直接失败，不创建新 Session，不切 tmux，不进入兼容路径。

## Remote Artifact

T-003 定义的显式 Artifact 合同：

```json
{
  "schema": "agentmux.remote-artifact.v1",
  "buildIdentity": "<stable-build-id>",
  "platform": "linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64",
  "entrypoint": "package/dist/agentmuxd.js"
}
```

tar.gz 根目录包含上述 `agentmux-artifact.json` 与 `package/`。安装器在本地先拒绝绝对路径和 `..` Archive Entry，再通过系统 SSH 把 Archive 流式送入远端 `tar`；不会把整个包读入内存，也不会在远端执行 npx、npm install 或联网下载。

远端布局固定为当前用户 Home 下的受管目录：

```text
~/.agentmux/
├─ agentmuxd.sock
├─ agentmuxd.sock.sessions.json
└─ versions/
   └─ <buildIdentity>/
      ├─ agentmux-artifact.json
      └─ package/
```

安装过程使用 `umask 077`、私有目录、同目录 Stage 和原子 Rename。已存在的同 Build 只验证 Manifest，不覆盖；不同 Build 并排安装，Upgrade 明确执行“安装新 Build → Shutdown 旧 Daemon → Activate 新 Build”。当前 Daemon 不能跨二进制替换保留 PTY，因此 Upgrade 是显式中断边界，不伪造 Session Migration。

## Daemon 命令

- `agentmuxd serve`：前台持有 Socket、PTY 与 Session。
- `agentmuxd activate`：若身份匹配的 Daemon 已存在则复用，否则 detached 启动并等待 Hello；身份冲突 Fail Closed。
- `agentmuxd connect`：只把 stdin/stdout 与私有 Socket 桥接，不启动 Daemon。
- `agentmuxd status`：输出已核对的 Protocol／Build／Host／Instance。
- `agentmuxd shutdown`：先从活 Socket 读取实时 PID，再发 SIGTERM 并等待 Endpoint 关闭。

`connect` 与 `activate` 分开是必要边界：网络抖动或 SSH Client Crash 只能结束 Proxy，不能顺带结束或重复启动 Remote Daemon。

## 安装、审计与卸载

`AgentMuxSshRemoteDaemon` 提供一条显式顺序：

1. `install(artifact)`：Remote Node Platform Probe、Manifest／平台核对、流式安装；
2. `activate(installation)`：启动或复用精确 Build；
3. `audit(installation)`：核对当前 Hello；
4. `createClient(installation)`：创建长期 SSH Connector；
5. `upgrade(nextArtifact, previous)`：显式替换；
6. `uninstall(installation)`：尝试精确 Shutdown，并在 Socket 仍存在时拒绝删除，再只删除受管 `.agentmux/versions/<build>`。

所有会删除远端内容的方法都会重新验证 Host、Build、`.agentmux` Base 和派生路径，调用方伪造任意目录不会扩大 `rm` 范围。

## 失败语义

- SSH Client／本地进程退出：Remote Daemon 与 PTY 继续；重新 Connect、Hello、Attach。
- 网络分区：当前 Client Pending Request 失败并清空本地 Input Tail；恢复后从 Daemon 的 Input／Output Cursor 继续。
- Create Response 丢失：使用调用前持有的 `createOperationId` 查询；不盲目 Spawn。
- SSH exit 255、远端 Node／agentmuxd 不可用：返回 `SSH_TRANSPORT_FAILED` 或控制面命令错误；不回退 tmux。
- Protocol／Build／Host Mismatch：Fail Closed。
- Replay 超窗：Remote 与 Local 同样返回 Gap；SSH 不隐藏或补造历史。
- Daemon Crash：Remote Journal 与 Local 同样发布 `lost`；它不是 SSH Transport Recovery。

## 当前平台与后续边界

T-003 的受支持 Remote 是带 Unix Socket、`sh`、`tar` 和 Node 的 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。Windows Remote 明确返回 `UNSUPPORTED_REMOTE_PLATFORM`，不进入未验证的 Pipe／PowerShell Fallback。

隔离 SSH Fixture 真实执行 Node、tar、stdio、node-pty、独立 Daemon 和进程组，只把 SSH Server 替换为受控本地跳板，用于确定性制造 SSH Client SIGKILL、输出延迟和 Host unavailable。T-006 仍需把 Artifact 生成、内容哈希、目标平台 Native PTY、干净 Consumer 与正式 Doctor 固化为候选 Package；T-007 继续负责真实远端／多平台安全与 Soak 证据。
