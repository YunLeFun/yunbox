# 云匣 YunBox · macOS 推送检查

SwiftUI 原生小工具，调用应用内附带的 YunBox CLI，复用同一套 Git/LFS 检查和 JSON 接口。需要 macOS 14+ 和本机 Node.js（版本要求同根项目）。

## 使用

- 选择或拖入 Git 仓库，检查 HEAD 相对本地 upstream 的已提交内容；没有 upstream 时检查全部历史并提示。
- 分别显示 Git pack 估算、LFS 候选量、预算、文件类型及超限状态；按文件大小降序，支持搜索、类型筛选、仅显示超限。
- 选中文件查看精确字节数、对象 ID、全部已知路径，复制路径或在 Finder 中定位当前仍存在的文件。
- 一键复制完整 JSON；最近仓库、运行环境和可选预算覆盖保存在本机偏好设置中。
- 检查在后台执行，可取消；切换仓库会取消旧任务，旧结果不会覆盖新仓库。进程有 120 秒时限和 64 MiB 输出上限。

快捷键：`⌘O` 选择仓库、`⌘R` 重新检查、`⌘.` 取消、`⇧⌘C` 复制 JSON、`⌘,` 打开设置。

LFS 显示**候选上传量**，实际上传量保持未知；文件原始大小与 Git 压缩上传量不同。窗口中的检查与实际 pre-push 时收到的引用范围可能不同，最终推送仍由 [CLI / Workstation 钩子](../../docs/inspect.md) 按实际引用重新检查。

## 构建、启动、安装

在仓库根目录，先安装依赖；还需 Xcode 或包含 Swift 6 的开发工具：

```bash
pnpm install
./script/build_and_run.sh             # 构建 CLI + 原生程序，生成 .app 后打开
./script/build_and_run.sh --verify    # 同上，并检查进程已启动
./script/build_and_run.sh --install   # 安装到 ~/Applications/YunBox.app 并打开
./script/build_and_run.sh --build     # 只生成 dist/YunBox.app
```

Codex 的 Run 按钮也调用此脚本。`--logs` / `--telemetry` 打开应用并查看进程日志；`--debug` 用 LLDB 调试 bundle 内的二进制。

构建脚本把 CLI 组件复制进 `.app`，记录构建时的 Node.js 路径，不打包整个 Node.js 运行时；路径失效时查找 PATH / Homebrew，或在设置中选择新的 node 可执行文件。Finder 启动无需交互式 shell 配置。更新 CLI 代码后需要重新构建客户端。

当前是供本机使用的 ad-hoc 签名构建，尚未完成 Developer ID 签名、公证及跨机器分发。`dist/`、Swift 构建缓存及本机运行路径均不提交。

## 验证

```bash
swift build --package-path apps/macos
YUNBOX_TEST_NODE="$(node -p 'process.execPath')" \
YUNBOX_TEST_CLI="$PWD/packages/cli/dist/cli.mjs" \
swift test --package-path apps/macos
```

测试覆盖退出码与 JSON 一致性、LFS 未知上传量、历史路径、取消和超时、输出限制、参数传递，以及真实 Git 仓库通过 CLI 返回超限报告。真实 CLI 测试需要上面的两个环境变量。CI 在 macOS 上构建 CLI、运行 Swift 测试并检查 `.app` 打包。

## 结构

- `YunBoxKit`：JSON 模型、进程执行与 CLI 调用，可独立测试。
- `YunBoxDesktop/App`：窗口、菜单、启动行为。
- `YunBoxDesktop/Stores`：仓库选择、检查状态及最近列表。
- `YunBoxDesktop/Views`：列表、预算概览、文件明细及设置。
