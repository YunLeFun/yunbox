# 云匣 YunBox · macOS 推送检查

SwiftUI 原生小工具，调用应用内附带的 YunBox CLI，复用同一套 Git/LFS 检查和 JSON 接口。需要 macOS 14+ 和本机 Node.js（版本要求同根项目）。

## 使用

- 选择或拖入 Git 仓库，检查 HEAD 相对本地 upstream 的已提交内容；没有 upstream 时检查全部历史并提示。
- 分别显示 Git pack 估算、LFS 候选量、预算、文件类型及超限状态；按文件大小降序，支持搜索、类型筛选、仅显示超限。
- 选中文件查看推送前后的变化：图片可并排、拖动分隔线或切换对比，文本显示 `git diff`，可在统一视图和带行号的左右分栏视图间切换，其他类型显示大小并可用「快速查看」打开（推送前后两个版本，左右方向键切换）。内容按对象 ID 从 Git 或本地 LFS 存储（`.git/lfs/objects`）读取，不读工作区；导出到仅当前用户可读的临时目录，切换仓库或退出时删除。本地没有的 LFS 旧版本无法对比。也可以复制路径或在 Finder 中定位当前仍存在的文件。
- 一键复制完整 JSON；最近仓库、运行环境和可选预算覆盖保存在本机偏好设置中。
- 最近仓库最多 12 个，也可以从「文件 → 最近的仓库」菜单切换。再次打开已在列表里的仓库不会改变顺序，所以同一个快捷键始终对应同一个仓库；新仓库排在最前，超出 12 个时去掉最早加入的。
- CLI 在仓库里运行 `init`、`types`、`doctor`、`status`、`inspect`、`hook`、`freeze` 后，把仓库路径和时间记到 `~/.config/yunbox/repositories.json`（和 `blocked-pushes.json` 同目录，最多 30 个）。客户端启动和回到前台时读取上次导入之后的新条目，跳过已不存在的目录，合并到最近列表顶部；从列表移除的仓库，CLI 再次用到它时才重新出现。
- 右键「固定」把仓库放进侧边栏顶部的「已固定」分组（`pinnedRepositories`），不计入 12 个上限，不会被「清除最近列表」清掉，可以拖动排序。`⌘1`–`⌘9` 按「已固定 → 最近」的顺序分配。
- 每个仓库最近一次的检查结果缓存在 `~/Library/Application Support/YunBox/InspectionCache`（CLI 原始 JSON 加检查时间）。切换仓库时先显示缓存，顶部提示「正在重新检查，先显示上次的结果」，后台重新检查完成后替换；重新检查失败时保留缓存并显示原因。缓存用和实时结果相同的校验读取，CLI 接口版本不兼容的缓存会被忽略；从最近列表移除的仓库，缓存一并删除。
- 仓库标题右侧显示 COS 直连状态（「直连 COS · 正常」「需要处理」「未接入 COS」），点击打开检查面板：逐项列出 `yunbox doctor --json` 的结果和修复命令；未接入时可以在面板里选择已有 bucket 或新建私有 bucket（会再次确认）、填写目录前缀，一键运行 `git yunbox init`；本机没有密钥时可以在面板里保存子账号密钥（SecretKey 用安全输入框，只经标准输入交给 `yunbox login`，不出现在命令行参数里）。切换仓库会自动重新检查。面板右上角的「复制给 AI 的接入说明」复制一段提示词（仓库路径、当前检查结果、客户端自带 CLI 的路径和接入步骤），粘贴给编程助手即可接入；密钥仍由用户自己保存，见 [docs/guide/ai.md](../../docs/guide/ai.md)。
- 仓库标题右侧还有「素材类型」（「检查 → 素材类型…」也能打开），是 `git yunbox types` 的图形界面：读取 `types list --json`，列出每个类型是否走 LFS（全部 / 部分 / 未走）、每个扩展名的规则和文件数、LFS 指针数，手写或 `git lfs track` 的规则标成「来自其他规则」且不能在这里删除；预置组合和单个类型的「添加」调用 `types add`，「移除…」确认后调用 `types remove`；作为普通文件提交的素材按原因（大小写不同、未重新规范化、没有规则）分组，后两种可以确认后运行 `types add <类型> --renormalize`。add / remove 显示命令的原始输出和退出码，完成后重新读取；读取失败时显示 JSON 里的 `error.message`。切换仓库时自动重新读取。见 [docs/guide/macos.md#素材类型](../../docs/guide/macos.md#素材类型)。
- 菜单栏显示云匣标志（模板图，跟随浅色、深色和着色菜单栏），当前仓库（与主窗口同步）处在[禁推时段](../../docs/guide/freeze.md)时右上角多一个圆点。点开是仿照系统 Wi-Fi、蓝牙菜单的面板：
  - **快速关闭**：标题栏的开关一键关闭本机所有仓库的禁推时段（`yunbox freeze off --global`，规则保留），再打开即恢复；旁边的计时按钮可以关闭 30 分钟、1 小时、2 小时或到今天结束，到点自动恢复。每个项目展开后也有「暂时关闭」，只关这一个仓库。关闭期间状态卡片显示橙色暂停图标、自动恢复的时间和「恢复」按钮。
  - **当前仓库**：能否推送、解禁时间或下一次禁推开始的时间、命中的规则和团队说明，以及今天 24 小时的时间轴（红色为禁推，竖线为现在）。设置了时段但这份 clone 的 pre-push 不会拦截时给出提示，没装包装层时可以一键安装（`yunbox hook install`）。
  - **未来 7 天**：每天的禁推分布和总时长。
  - **全局规则**：`~/.gitconfig` 里对本机所有仓库生效的规则；右上角「＋」勾选预设即替换全局规则，取消勾选即清除。
  - **项目**：最近打开的每个仓库各占一行，显示状态和规则；展开后分别列出本仓库（`.git/config`）和团队（`.yunbox/config`）的规则，各自可以勾选预设；还可以「设为当前」（主窗口和菜单栏图标一起切换）、「暂时关闭」或「编辑…」。给项目勾选预设时，如果它还没有 pre-push 包装层，会顺带安装（`yunbox hook install`），一步就能生效。不在列表里的仓库用「添加项目…」选择。
  - 「编辑禁推时段…」打开原生表单窗口：选择项目和保存位置（本仓库、团队、全局），编辑 `opening_hours` 规则、拦截说明和时区。
  
  当前仓库每 30 秒、其他项目每 3 分钟、打开面板时全部调用一次 `yunbox freeze list --json` 刷新（最多同时 4 个）。设置里可以关掉菜单栏图标。
- 检查在后台执行，可取消；切换仓库会取消旧任务，旧结果不会覆盖新仓库。进程有 120 秒时限和 64 MiB 输出上限。

「帮助」菜单直接打开官网文档：使用说明、macOS 客户端、禁推时段、推送体积检查、用 AI 编程助手接入；菜单栏面板的「使用说明」、禁推时段编辑窗口的「查看时段写法和常见场景」、COS 面板的「接入说明」「AI 接入说明」也链接到对应页面，英文界面打开英文页面（`DocsPage` 里统一维护，测试会核对中英文页面和锚点都存在）。

「云匣 YunBox → 检查更新…」和「设置 → 软件更新」由 [Sparkle](https://sparkle-project.org) 驱动：默认每天在后台检查一次 `releases/latest/download/appcast.xml`，可以关闭自动检查或改为自动下载并安装（Sparkle 自己保存这两个偏好）。不是从构建脚本打包的 `.app`（例如 `swift run`）不启动更新器，设置里会说明。

界面有简体中文（源语言，直接写在代码里）和英文。「设置 → 语言」写入应用自己的 `AppleLanguages`，与「系统设置 → 通用 → 语言与地区 → 应用程序」是同一个设置，重新打开后生效，设置页提供「立即重新打开」。命令行输出的文字（`doctor` 的检查项、禁推时段的说明等）仍是中文。

快捷键：`⌘O` 选择仓库、`⌘1`–`⌘9` 切换已固定和最近的仓库、`⌘R` 重新检查、`⌘.` 取消、`⇧⌘C` 复制 JSON、`⌘,` 打开设置。

LFS 显示**候选上传量**，实际上传量保持未知；仓库直连 COS 且本机有密钥时，CLI 会查询哪些对象已在 COS，客户端改为显示需要上传的量，已有的文件标为「已在 COS」。文件原始大小与 Git 压缩上传量不同。窗口中的检查与实际 pre-push 时收到的引用范围可能不同，最终推送仍由 [CLI / Workstation 钩子](../../docs/inspect.md) 按实际引用重新检查。

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

应用图标源自 `assets/brand`，是 [YunLeFun/icons](https://github.com/YunLeFun/icons) 中 `assets/apps/yunbox/v1` 的固定副本，以 `manifest.json` 的 SHA-256 校验。Xcode 26+ 下，脚本用 `actool` 把分层的 `YunBox.icon` 编译进 `Assets.car` 并写入 `CFBundleIconName`，macOS 26 据此显示默认、深色、Clear 与着色外观；同时由 `yunbox-app-icon.svg` 渲染 `AppIcon.icns` 作为旧系统兜底。更新图标时先改中心仓库，再运行 `pnpm icons:sync --source /path/to/icons`；`pnpm icons:check` 只校验本地副本。

本地构建默认是 ad-hoc 签名。发布版本时，`Release` 工作流用 `YUNBOX_SWIFT_BUILD_ARGS="-c release --arch arm64 --arch x86_64"` 构建通用二进制，用 Developer ID 签名并公证（见下面「签名和公证」），打包成 `YunBox-macOS.zip`，连同签名的 `appcast.xml` 附在 GitHub release 上（先建草稿，两个文件都上传后才发布），官网的下载按钮指向 zip，客户端从 appcast 自动更新。`Info.plist` 的版本号（`CFBundleShortVersionString` 和 Sparkle 比较用的 `CFBundleVersion`）取自 `packages/cli/package.json`。`dist/`、Swift 构建缓存及本机运行路径均不提交。

### 签名和公证

设置了 `YUNBOX_CODESIGN_IDENTITY`（「Developer ID Application」证书的名称）时，`build_and_run.sh` 按 Sparkle 文档的顺序由内到外重新签名：`Installer.xpc`、`Downloader.xpc`（按 Sparkle 文档保留它的 entitlements；这个服务只给沙盒应用用，SwiftPM 版本里目前是空的）、`Autoupdate`、`Updater.app`、`Sparkle.framework`，最后是应用本身，全部打开 Hardened Runtime 并带安全时间戳。应用不需要额外的 entitlements。然后 `script/notarize.sh` 提交公证，等待结果，把公证票据钉进应用（staple），用 `spctl` 确认 Gatekeeper 放行。公证必须在 `sparkle_appcast.sh` 之前：Sparkle 签名的 zip 里要装已经 staple 的应用。

在本机签名并公证一次：

```bash
xcrun notarytool store-credentials yunbox-notary --apple-id <Apple ID> --team-id QT792GAY4C   # 只需一次，密码是 App 专用密码，存进钥匙串
YUNBOX_CODESIGN_IDENTITY="Developer ID Application: Lan Yang (QT792GAY4C)" ./script/build_and_run.sh --build
./script/notarize.sh dist/YunBox.app
```

发布工作流需要在仓库的 `sparkle` environment 里配置这些 secret，缺任何一个都会让发布失败，不会退回 ad-hoc 签名：

| secret | 内容 |
|---|---|
| `DEVELOPER_ID_P12_BASE64` | 「Developer ID Application」证书连同私钥导出的 `.p12`，base64 编码 |
| `DEVELOPER_ID_P12_PASSWORD` | 导出 `.p12` 时设的密码 |
| `APPLE_API_KEY_ID` | App Store Connect 团队 API 密钥的密钥 ID |
| `APPLE_API_ISSUER_ID` | 同一页面上的 Issuer ID |
| `APPLE_API_KEY` | 下载的 `AuthKey_<密钥 ID>.p8` 文件内容 |

证书在「钥匙串访问 → 我的证书」里选中「Developer ID Application」，右键导出为 `.p12`，然后 `base64 -i developer-id.p12 | gh secret set DEVELOPER_ID_P12_BASE64 --env sparkle`。API 密钥在 App Store Connect 的「用户和访问 → 集成 → 团队密钥」里创建，角色选「Developer」；`.p8` 只能下载一次，用 `gh secret set APPLE_API_KEY --env sparkle < AuthKey_<密钥 ID>.p8` 保存。导出的 `.p12` 和 `.p8` 用完从磁盘上删掉。工作流把证书导入一个临时钥匙串，任务结束时删除。

### 自动更新的签名

本地的 ad-hoc 签名每次构建都不同，发布版的 Developer ID 签名也和 0.1.4 及以前的 ad-hoc 版本不同，Sparkle 只靠 EdDSA 判断更新是否可信：`Info.plist` 里有 `SUPublicEDKey`、`SUVerifyUpdateBeforeExtraction`（解压前验签）和 `SURequireSignedFeed`（appcast 和更新说明也要签名）。发布时 `script/sparkle_appcast.sh` 打包 `YunBox-macOS.zip`，用 `generate_appcast` 生成并签名 `appcast.xml`（内嵌 release 说明），再用应用里的公钥核对 zip 的签名。

私钥保存在维护者的登录钥匙串（account `fun.yunle.yunbox`）和仓库 `sparkle` environment 的 secret `SPARKLE_ED_PRIVATE_KEY` 里，**不能丢**：丢失后已安装的客户端无法再自动更新。第一次配置或换一台机器时：

```bash
swift package --package-path apps/macos resolve   # 下载 Sparkle 工具
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account fun.yunle.yunbox -p   # 查看公钥，应与 build_and_run.sh 一致
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account fun.yunle.yunbox -x /dev/stdout | gh secret set SPARKLE_ED_PRIVATE_KEY --env sparkle
```

本地验证一次完整更新：把 `dist/YunBox.app` 复制两份，分别改低和改高版本号、把 `SUFeedURL` 指向本地 HTTP 服务后重新 ad-hoc 签名，对新版本运行 `SPARKLE_DOWNLOAD_URL_PREFIX=http://127.0.0.1:8765/ script/sparkle_appcast.sh <新版本.app> v<版本> <空目录>`，在该目录启动 `python3 -m http.server 8765`，打开旧版本选择「检查更新…」。

## 验证

```bash
swift build --package-path apps/macos
YUNBOX_TEST_NODE="$(node -p 'process.execPath')" \
YUNBOX_TEST_CLI="$PWD/packages/cli/dist/cli.mjs" \
swift test --package-path apps/macos
```

测试覆盖退出码与 JSON 一致性、LFS 未知上传量、历史路径、取消和超时、输出限制、参数传递、最近列表的顺序和上限、固定和合并 CLI 记录、缓存的读写和清理（包括忽略不兼容的缓存），以及真实 Git 仓库通过 CLI 返回超限报告。真实 CLI 测试需要上面的两个环境变量。CI 在 macOS 上构建 CLI、运行 Swift 测试并检查 `.app` 打包。

## 界面文字和翻译

界面文字直接用中文写在代码里：SwiftUI 的 `Text("…")`、`Button("…")` 等会自动本地化；传给 `String` 的文字要写成 `String(localized: "…")`，否则不会翻译。英文翻译在 [`Localization/Localizable.xcstrings`](Localization/Localizable.xcstrings)（Xcode 的字符串目录，可以用 Xcode 打开编辑）。改了界面文字后：

```bash
./script/sync_strings.sh   # 用编译器提取代码里的文字，合并进字符串目录，并检查每条都有英文
```

新增的文字在目录里没有英文时，脚本会列出来；在 Xcode 里或直接编辑 JSON 补上翻译（数量相关的文字用 plural 变体）。不再使用的文字会被标记出来，删掉即可。CI 运行 `./script/sync_strings.sh --check`，目录过期或缺翻译时失败。构建脚本用 `xcstringstool compile` 把目录编译成 `en.lproj`。

## 结构

- `YunBoxKit`：JSON 模型、进程执行与 CLI 调用、按对象 ID 读取推送版本（`ContentReader`）、最近仓库列表和检查结果缓存，可独立测试。
- `YunBoxDesktop/App`：窗口、菜单、启动行为。
- `YunBoxDesktop/Stores`：仓库选择、检查状态及最近列表。
- `YunBoxDesktop/Views`：列表、预算概览、文件明细及设置。
