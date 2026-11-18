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
- 对象查看：实时 watch 刷新、名称过滤、YAML 详情与复制；详情栏可**一键铺满整个内容区**（双击标题栏或点最大化按钮，Esc 还原）
- 对象编辑：**YAML 编辑并以服务端 apply 提交**、删除、扩缩容（Deployment/StatefulSet/ReplicaSet）、滚动重启（Deployment/StatefulSet/DaemonSet）
- Pod 能力：多容器选择、**日志流式查看**、**Exec 交互终端**（复用 xterm，走 MessagePort 通道）
- 集群凭据（kubeconfig 全文）用 `safeStorage` 加密存储，`config.json` 只留元数据

**数据库管理（MySQL / PostgreSQL）**
- 连接管理：MySQL / MariaDB、PostgreSQL，密码用 `safeStorage` 加密；支持经 **SSH 隧道**访问内网数据库
- 结构树（对齐 DataGrip）：库 / Schema → 表 / 视图 → **列 / 键 / 索引** 三层可折叠。列显示类型并标记主键；键里列出主键与全部外键（含引用目标表/列）；索引显示唯一性与列组合
- 右键菜单：表上支持「新建查询、生成 CREATE 模板、复制限定名、重命名、清空表、删除表、刷新」；列上支持「插入列名、复制列名」；库上支持「新建查询、复制库名、设为当前数据库」。**新建查询 / 生成 CREATE 模板 / 双击表都会新开一个查询页**，不会覆盖当前 SQL
- 建连接时**数据库留空则列出全部库**（业务库在前、系统库弱化显示），SQL 自动带库名前缀
- SQL 编辑器：CodeMirror 6，语法高亮、**基于真实 schema 的表名/字段名自动补全**、括号自动闭合、撤销历史；右键菜单支持执行选中/当前语句、格式化选中、复制、剪切、粘贴、全选
- SQL 格式化：`sql-formatter`，`Ctrl+Shift+F`，支持只格式化选中片段
- SQL 解析：按分号安全拆分（跳过字符串、注释、`$$` 块）、识别语句类型、列出涉及的表与字段、定位语法错误到第几条语句
- 多查询页：一个数据库标签下可以有多个查询页签，**每个页各自保存 SQL / 结果 / 消息**，切页不丢；`＋` 新建、`×` 关闭（只剩一页时清空内容）
- 执行：`Ctrl+Enter` / `F5` 执行**选中片段或光标所在语句**，「全部」执行整个编辑器；「计划」对当前 SELECT/WITH 执行 `EXPLAIN`
- 事务：`事务`（BEGIN/START TRANSACTION）、`提交`、`回滚`，工具栏显示「事务中」状态
- 多库切换：工具栏下拉直接切换当前数据库（MySQL 重连 + PG 必须重连，已处理）
- 结果网格：列名 + 字段类型、`NULL` 斜体标识；**双击单元格可编辑**，自动按主键生成 `UPDATE` 语句，预览/改写后再执行或插入编辑器
- 多结果集分页签；单次最多 1000 行并提示截断；显示耗时与影响行数；可「停止」中断；编辑器与结果区之间可拖拽调高度

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

- **数据库尚未支持**：结果网格内直接批量编辑（当前是逐格生成 UPDATE）、执行计划图形化（当前是 `EXPLAIN` 文本结果）、SQLite / SQL Server 驱动
- **SQL 解析器限制**：`node-sql-parser` 对部分厂商特有语法（存储过程、复杂 CTE、`CREATE FUNCTION` 等）可能报解析错误；解析失败不影响实际执行，仅「解析」面板会提示
- **K8s 尚未支持**：Pod 端口转发、Events 联动视图、metrics（CPU/内存）、批量 apply
- **K8s 多窗口限制**：同一集群在多个窗口打开时共享同一份客户端缓存，切换 context 会互相影响，建议一个集群只开一个 K8s 窗口
- **内嵌 RDP 未实现**：RDP 通过调用系统客户端完成（纯 JS 无可用协议栈，内嵌需引入 IronRDP / FreeRDP）。VNC 为真正的应用内嵌。
- **未做 known_hosts 校验**：首次连接不比对主机指纹，生产环境建议后续补 TOFU 流程。
- **Linux 密码可见性**：`xfreerdp` 的密码通过命令行传递时会短暂出现在进程列表中，敏感环境建议改用 SSH 隧道或内置 VNC。
- **未签名**：Windows 安装包无代码签名，SmartScreen 会提示"未知发布者"。
- **仅支持密码 / 私钥认证**：尚未接入 ssh-agent。
