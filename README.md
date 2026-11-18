# DesktopTool

跨平台（Windows / Linux / macOS）远程运维工作台，一个窗口里完成 SSH 终端、SFTP、端口转发与远程桌面。

## 功能

**SSH 终端**
- 密码 / 私钥（OpenSSH、PEM）/ 私钥口令 / keyboard-interactive 认证
- 多跳跳板机（`ProxyJump` 等价链路，最多 5 跳）
- xterm.js + WebGL 渲染，支持中文、256 色、搜索（`Ctrl+Shift+F`）
- 复制 `Ctrl+Shift+C` / 粘贴 `Ctrl+Shift+V`，多标签
- keepalive 保活、断线状态提示、一键重连

**SFTP 文件管理**
- 目录浏览、面包屑、上传（多选）、下载（进度条）
- 新建目录、重命名、删除、权限展示
- 2MB 以内的文本文件在线编辑并保存

**端口转发**
- 本地转发 `-L`、远程转发 `-R`、动态 SOCKS5 `-D`
- 运行态开关、连接数、错误信息展示、随应用退出清理

**远程桌面**
- RDP：Windows（`mstsc` + `cmdkey` 临时注入凭据，30 秒后自动清除）、macOS（Windows App / Microsoft Remote Desktop）、Linux（`xfreerdp` → `rdesktop` → `remmina`）
- VNC：应用内嵌 noVNC（全平台），macOS / Linux 也可调用系统客户端
- 支持 **RDP / VNC over SSH 隧道**：先经 SSH 建隧道，再连接 `127.0.0.1:随机端口`
- 没有可用客户端时降级为展示可复制的连接命令

**Kubernetes 管理**
- 集群接入：本地 kubeconfig 文件、`~/.kube/config` 一键导入、粘贴 kubeconfig、**从 WSL 发行版读取**（文件型证书自动内联成 base64）
- 内网集群可经 **SSH 跳板隧道**访问：复用已有 SSH 会话，隧道后仍用原域名做 SNI 与证书校验
- 多集群并存：每个 K8s 标签页独立绑定集群 / context / namespace
- 资源浏览：通过 discovery 动态发现全部资源类型（含 CRD），按工作负载 / 网络 / 存储 / 配置 / 集群 / 自定义分类；**资源分类默认全部折叠**，点击展开（展开状态会记住）
- 对象查看：实时 watch 刷新、名称过滤、YAML 详情与复制
- 对象编辑：**YAML 编辑并以服务端 apply 提交**、删除、扩缩容（Deployment/StatefulSet/ReplicaSet）、滚动重启（Deployment/StatefulSet/DaemonSet）
- Pod 能力：多容器选择、**日志流式查看**、**Exec 交互终端**（复用 xterm，走 MessagePort 通道）
- 集群凭据（kubeconfig 全文）用 `safeStorage` 加密存储，`config.json` 只留元数据

**其他**
- 连接分组、搜索、右键菜单（打开 / SFTP / 系统客户端 / 断开 / 编辑 / 复制 / 删除）
- 凭据使用 Electron `safeStorage` 加密（Windows DPAPI、macOS Keychain、Linux libsecret）；密钥环不可用时默认拒绝明文保存
- 配置导出 / 导入（可选是否包含密码）
- 深色 / 浅色主题、终端字号与字体自定义

## 技术栈

- Electron 33 + Vue 3 + TypeScript + Vite（electron-vite）
- `ssh2`（SSH / SFTP）、`node-pty`（本机终端）、`@xterm/xterm`、`@novnc/novnc`

终端与本机 PTY 的数据走 Electron 原生 **MessagePort**（`MessageChannelMain` + `webContents.postMessage`），既不经过 IPC 的序列化，也**不监听任何 TCP 端口**。内置 VNC 因为 noVNC 只支持 WebSocket，改为**按需懒启动**一个 `127.0.0.1` 随机端口，关闭 VNC 后立即释放。

## 开发

```bash
npm install                 # 若安装脚本被 npm 拦截：npm approve-scripts --all
npm run dev                 # 开发模式（默认 5173，被占用会自动顺延）
npm run typecheck           # 主进程 + 渲染进程类型检查
npm run build               # 类型检查 + 三端产物到 out/
```

### 端到端自检

不需要真实服务器即可验证 SSH 全链路：

```bash
npm run mock:ssh            # 终端 A：启动本地 mock SSH（admin/admin，端口 2222，内网 HTTP 9099）
npm run build
node_modules/electron/dist/electron.exe . --smoke-ssh
```

预期输出：

```
[smoke-ssh] PASS ["ssh-connect ok","ssh-shell ok (true)","rd-detect ok (mstsc:yes,builtin:yes)","local-forward ok (true)","socks5-forward ok (true)"]
```

K8s 端到端自检（会临时导入本机 `~/.kube/config`，结束后自动清理）：

```bash
node_modules/electron/dist/electron.exe . --smoke-k8s
# [smoke-k8s] PASS ["k8s-connect ok (v1.36.1 @ docker-desktop)","k8s-discovery ok (62 types)", ...]
```

另有窗口渲染自检：`electron . --smoke-test`。

## 打包

```bash
npm run build:win      # release/desktop-tool-<version>-setup.exe (NSIS)
npm run build:linux    # AppImage + deb（需在 Linux 或 CI 上执行）
npm run build:mac      # dmg（必须在 macOS 上执行）
```

macOS 产物无法在 Windows 上构建，需要 macOS 机器或 GitHub Actions 的 `macos-latest` runner。

完整的开发 / 自检 / 打包命令、镜像设置、CI 示例与常见问题见 **[docs/build.md](docs/build.md)**。

## 数据目录

`app.getPath('userData')` 下：

- `config.json`：连接、分组、转发规则、设置
- `credentials.json`：经 `safeStorage` 加密的密码 / 私钥口令

设置页可直接打开该目录，并支持导出 / 导入。

## 已知限制

- **K8s 尚未支持**：Pod 端口转发、Events 联动视图、metrics（CPU/内存）、批量 apply
- **K8s 多窗口限制**：同一集群在多个窗口打开时共享同一份客户端缓存，切换 context 会互相影响，建议一个集群只开一个 K8s 窗口
- **内嵌 RDP 未实现**：RDP 通过调用系统客户端完成（纯 JS 无可用协议栈，内嵌需引入 IronRDP / FreeRDP）。VNC 为真正的应用内嵌。
- **未做 known_hosts 校验**：首次连接不比对主机指纹，生产环境建议后续补 TOFU 流程。
- **Linux 密码可见性**：`xfreerdp` 的密码通过命令行传递时会短暂出现在进程列表中，敏感环境建议改用 SSH 隧道或内置 VNC。
- **未签名**：Windows 安装包无代码签名，SmartScreen 会提示"未知发布者"。
- **仅支持密码 / 私钥认证**：尚未接入 ssh-agent。
