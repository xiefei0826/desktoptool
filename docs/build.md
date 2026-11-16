# 命令手册（开发 / 自检 / 打包）

所有命令都在项目根目录执行。

## 0. 前置：依赖安装

```bash
npm install
```

本机 npm 11 启用了 allow-scripts 安全策略，安装脚本默认不会执行。若出现
`allow-scripts ... not yet covered` 警告，执行：

```bash
npm approve-scripts --all
npm rebuild electron esbuild node-pty --foreground-scripts
```

国内网络建议先设置镜像，避免 Electron / NSIS 下载卡住：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
```

## 1. 开发

```bash
npm run dev
```

- 渲染进程 dev server 固定优先使用 **5175**（被占用时自动 +1）
- 此端口**只在开发期存在**，打包后的应用用 `file://` 加载页面，不监听 HTTP
- 运行时终端/VNC 数据走 Electron MessagePort，**不占用 TCP 端口**
  （内置 VNC 因 noVNC 只支持 WebSocket，会在打开 VNC 时临时监听 127.0.0.1 随机端口，关闭 VNC 后立即释放）

## 2. 类型检查

```bash
npm run typecheck          # 主进程 + 渲染进程
npm run typecheck:node     # 只查主进程 / preload / shared
npm run typecheck:web      # 只查 Vue 渲染进程
```

类型检查只做静态校验，不产出文件。

## 3. 构建产物

```bash
npm run build              # typecheck + electron-vite build
npx electron-vite build    # 跳过 typecheck 直接构建
npx electron-vite build --watch   # 监听模式（改代码自动增量构建）
```

产物目录：

```
out/
├─ main/index.js      主进程
├─ preload/index.js   预加载
└─ renderer/          渲染进程静态资源
```

## 4. 运行与自检

### 4.1 运行生产构建

```bash
npx electron-vite preview      # 等价于 npm start
node_modules/electron/dist/electron.exe .   # Windows 直接跑 out/ 里的产物
```

### 4.2 窗口渲染自检

```bash
node_modules/electron/dist/electron.exe . --smoke-test
```

预期输出：

```
[smoke] {"shell":true,"sidebar":true,"brand":"DesktopTool","fatal":"","pty":true,...}
```

### 4.3 SSH 全链路自检（无需真实服务器）

终端 A：

```bash
npm run mock:ssh
```

会启动：
- `ssh://admin@127.0.0.1:2222`（密码 `admin`）
- `http://127.0.0.1:9099`（假内网服务，用于验证端口转发）

终端 B：

```bash
node_modules/electron/dist/electron.exe . --smoke-ssh
```

预期输出：

```
[smoke-ssh] PASS ["ssh-connect ok","ssh-shell ok (true)","rd-detect ok (mstsc:yes,builtin:yes)","local-forward ok (true)","socks5-forward ok (true)"]
```

自检会自动创建并清理临时连接与转发规则，不改动你的既有配置。

### 4.4 K8s 自检（需要本机有可用 kubeconfig）

```bash
node_modules/electron/dist/electron.exe . --smoke-k8s
```

预期输出：

```
[smoke-k8s] PASS ["k8s-connect ok (v1.36.1 @ docker-desktop)","k8s-discovery ok (62 types)","k8s-namespaces ok (8)","k8s-pods ok (17)","k8s-yaml ok (5993 chars)","k8s-containers ok (mysql)","k8s-exec ok (true)","k8s-watch ok (subscribed)"]
```

自检会临时导入 `~/.kube/config`，结束后删除本地记录与加密凭据，**不会修改集群内任何资源**（Exec 只执行 `echo`）。

## 5. 打包

打包前先 `npm run build`，或直接用带构建的组合命令。

### 5.1 常用组合命令

```bash
npm run build:win      # Windows NSIS 安装包
npm run build:linux    # Linux AppImage + deb
npm run build:mac      # macOS dmg
```

产物位置：`release/`

```
release/
├─ desktop-tool-0.1.0-setup.exe        Windows 安装包
├─ desktop-tool-0.1.0-setup.exe.blockmap
├─ desktop-tool-0.1.0.AppImage         Linux
├─ desktop-tool_0.1.0_amd64.deb        Linux
├─ desktop-tool-0.1.0.dmg              macOS
└─ win-unpacked/                       免安装目录版
```

### 5.2 直接用 electron-builder

```bash
npx electron-builder --win  --config electron-builder.yml
npx electron-builder --linux --config electron-builder.yml
npx electron-builder --mac  --config electron-builder.yml
```

常用变体：

```bash
# 只出免安装目录，不打安装包（最快，用于验证打包配置）
npx electron-builder --win --dir --config electron-builder.yml

# 指定架构
npx electron-builder --win --x64 --config electron-builder.yml
npx electron-builder --linux --arm64 --config electron-builder.yml

# 同时出多个平台（注意：mac 目标只能在 macOS 上构建）
npx electron-builder --win --linux --config electron-builder.yml
```

### 5.3 平台限制

| 目标 | 可在哪些系统构建 | 说明 |
|---|---|---|
| Windows (NSIS) | Windows / Linux / macOS | 需要 Wine 才能在非 Windows 上出 NSIS |
| Linux (AppImage/deb) | Linux（Windows 需 WSL/Docker） | AppImage 依赖 fuse |
| macOS (dmg) | **仅 macOS** | 需 Xcode Command Line Tools |

### 5.4 代码签名

当前未配置签名，构建日志里的 `no signing info identified, signing is skipped` 属正常。Windows 安装会触发 SmartScreen「未知发布者」提示。

需要签名时设置环境变量后重跑打包：

```powershell
$env:CSC_LINK = 'C:\path\to\cert.pfx'
$env:CSC_KEY_PASSWORD = '证书密码'
npm run build:win
```

## 6. GitHub Actions 三平台构建示例

```yaml
name: build
on: [push, workflow_dispatch]
jobs:
  package:
    strategy:
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm approve-scripts --all
      - run: npx electron-vite build
      - run: npx electron-builder --publish never --config electron-builder.yml
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.os }}-dist
          path: release/**
```

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `Could not find any Visual Studio installation` | 只有 `node-pty` 需要本地编译时才会出现；本项目使用其自带 N-API 预编译，通常可忽略 |
| Electron 下载卡住 | 设置 `ELECTRON_MIRROR` |
| NSIS 工具下载失败 | 设置 `ELECTRON_BUILDER_BINARIES_MIRROR` |
| dev 端口不是 5175 | 5175 被占用，Vite 自动顺延；关闭占用进程或改 `electron.vite.config.ts` 的 `server.port` |
| 打包后白屏 | 检查是否执行过 `npm run build`（`out/renderer` 缺失）；查看 `[renderer]` 日志 |
| 安装后提示未知发布者 | 未签名，属预期行为 |
| `node-pty` 不可用 | 本机终端会降级为管道模式（vim/top 不可用），状态栏会显示；重装依赖后可恢复 |
