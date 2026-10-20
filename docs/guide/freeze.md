# 禁推时段

在指定的时段里不允许推送，例如工作时间、联调、发版冻结或演示期间。处在禁推时段时，推送会在上传前被中断，Git 会显示原因和几点之后可以推：

```text
禁止推送：现在是周一 11:30，处于禁推时段 Mo-Fr 09:00-18:00（本仓库 .git/config），18:00 后可以推送。
工作时间禁止推送，请在 18:00 后推送
查看或修改禁推时段：yunbox freeze list
error: failed to push some refs to '…'
```

规则分三层，同时生效：

| 位置 | 写在哪里 | 影响谁 |
| --- | --- | --- |
| 本仓库 | 这份 clone 的 `.git/config` | 只有你自己的这份 clone |
| 团队 | 仓库里的 `.yunbox/config`，提交后共享 | 所有拉到这次提交的协作者 |
| 全局 | `~/.gitconfig` | 你这台电脑上的所有仓库 |

::: warning 先安装 pre-push 检查
拦截由 pre-push 包装层完成，每份 clone 都要装一次：`yunbox hook install`（见[推送体积检查](../inspect#在上传前执行)）。在 macOS 客户端里给项目选预设时会自动安装；`yunbox doctor` 发现设了时段却没装时会提示。
:::

## 三分钟上手

### 用 macOS 客户端

1. 点菜单栏的云匣图标，打开面板。当前仓库处在禁推时段时，图标右上角有一个圆点。
2. 在「项目」里展开要设置的仓库（不在列表里就点「添加项目…」），在「本仓库」或「团队」右边点「＋」，勾选一个预设，例如「工作时间」。
3. 想对所有仓库生效，在「全局规则」右边的「＋」里选。

面板会显示现在能否推送、今天的时间轴和未来 7 天的禁推分布。更复杂的规则用「编辑禁推时段…」。详见 [macOS 客户端](./macos)。

### 用命令行

```bash
yunbox hook install                                   # 每份 clone 一次
yunbox freeze set "Mo-Fr 09:00-18:00" --message "工作时间禁止推送，请在 18:00 后推送"
yunbox freeze list                                    # 查看所有生效的时段
yunbox freeze check --at "Fr 17:30"                   # 预览某个时间能否推送
```

### 交给 AI

告诉编程助手「工作日 9 点到 18 点不许推送」，它会运行 `yunbox freeze set "Mo-Fr 09:00-18:00"` 并用 `yunbox freeze check --json` 核对。命令都不交互、有 JSON 输出，见[用 AI 编程助手接入](./ai)。

## 常见场景

| 场景 | 命令 |
| --- | --- |
| 工作时间不推送 | `yunbox freeze set "Mo-Fr 09:00-18:00"` |
| 午休可以推送 | `yunbox freeze set "Mo-Fr 09:00-12:00,13:30-18:00"` |
| 团队周末冻结 | `yunbox freeze set "Fr 18:00-24:00; Sa,Su" --shared --timezone Asia/Shanghai`，然后提交 `.yunbox/config` |
| 夜里留给 CI | `yunbox freeze set "22:00-08:00" --global` |
| 工作日禁推，但周三不限 | `yunbox freeze set "Mo-Fr 09:00-18:00; We off"` |
| 紧急修复，临时放行 1 小时 | `yunbox freeze off --for 1h` |
| 删除本仓库的规则 | `yunbox freeze clear` |

## 时段写法

采用 OpenStreetMap [`opening_hours`](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification) 的写法（子集）。它是描述「每周固定时段」最通用的格式，地图、商家营业时间和许多开源库都用它，人和 AI 都容易读写：

| 写法 | 含义 |
| --- | --- |
| `Mo-Fr 09:00-18:00` | 工作日的工作时间 |
| `Mo-Fr 09:00-12:00,13:30-18:00` | 一天里多个时段用逗号分隔（午休可以推送） |
| `Sa,Su` | 只写星期表示这几天全天 |
| `24/7` | 每天全天 |
| `Fr 22:00-02:00` | 跨过午夜，算在开始那天：周五夜里到周六 02:00 |
| `Mo-Fr 09:00-18:00; We off` | 多条规则用 `;` 分隔，后面的规则**覆盖**前面同一天的设置（周三不限制） |
| `10:00-12:00` | 不写星期表示每天 |

- 时段左闭右开：`09:00-18:00` 从 09:00 起禁止，18:00 起允许；`24:00` 只能作为结束。
- 星期写 `Mo Tu We Th Fr Sa Su`，范围 `Mo-Fr`（可以跨周，如 `Fr-Mo`），列表 `Sa,Su`。另外接受 `mon`…`sun`、`周一`…`周日`，以及 `weekdays` / `weekends` / `工作日` / `周末`，保存时统一改写成 `opening_hours` 的形式。
- `--days Mo-Fr` 给没写星期的规则统一加上星期，例如 `yunbox freeze set 09:00-12:00,14:00-18:00 --days Mo-Fr`。
- 一个参数里的 `;` 规则按上面的覆盖规则计算；多个参数、多个保存位置的时段则**同时生效**（任一命中就禁止）。相邻或重叠的时段合并计算解禁时间，最多往后找 7 天。
- 「工作日」只按星期计算，**不认节假日和调休**：`opening_hours` 的 `PH`（公共假日）需要节假日日历，暂不支持，写了会报错。

没有选 cron：GitLab 的 Deploy freeze 和 Argo CD 的 sync window 用 cron 表达式，但 cron 描述的是时间点，表示一个时段要写开始、结束两条（GitLab）或开始加时长（Argo CD），工作时间要写成 `0 9 * * 1-5` 加 `0 18 * * 1-5`，不直观也容易写错。iCalendar 的 RRULE 能表达更复杂的重复规则，但对固定的每周时段来说过重。

## 快速关闭

紧急修复、发版补丁等临时需要推送时，不必删除规则，用 `yunbox freeze off` 关闭，到点自动恢复（类似 macOS 的勿扰模式）：

```bash
yunbox freeze off --for 1h             # 本仓库 1 小时内不拦截
yunbox freeze off --until 18:00        # 到今天 18:00（已过则为明天）
yunbox freeze off --global --until 24:00   # 本机所有仓库，到今天结束
yunbox freeze off                      # 一直关闭，直到 yunbox freeze on
yunbox freeze on                       # 提前恢复；--global 恢复全局
```

- 关闭期间所有时段（本仓库、团队和全局的）都不拦截，规则原样保留；推送时 pre-push 会提示「禁推时段已关闭（至今天 16:30），本次推送不受 Mo-Fr 09:00-18:00 限制」。
- 默认只关当前这份 clone（写进 `.git/config`），`--global` 关本机所有仓库（写进 `~/.gitconfig`）。关闭是个人操作，不能写进团队共享的 `.yunbox/config`，读到时报错。
- `--for` 接受 `30m`、`1h`、`1h30m`、`2d`（最长 30 天）；`--until` 接受本机时间 `HH:MM` 或 `"Mo 09:00"`，`24:00` 表示今天结束。底层配置是 `yunbox.pushFreezePausedUntil`（ISO 8601 时间或 `forever`），过期后自动失效；`clear` 也会删除它。
- `yunbox freeze check` 在关闭期间返回 `status: "paused"`、退出码 `0`，并给出 `pause: { scope, until }`；`list --json` 的 `pauses` 列出所有仍有效的关闭。

## 时区、保存位置和生效范围

- **时区**：默认按每台电脑自己的时区。团队成员分布在不同时区时，用 `--timezone Asia/Shanghai`（IANA 名称）让该位置的时段按同一时区计算，夏令时由 Node.js 处理；提示信息也按这个时区显示。`check --at` 的时间按本机时区解释。
- **保存位置**：默认写本仓库 `.git/config`，只影响这份 clone；`--shared` 写进仓库的 `.yunbox/config`，提交后对整个团队生效；`--global` 写进 `~/.gitconfig`，影响本机所有仓库。`set` 替换该位置的全部时段；`--message`、`--timezone` 只在给出时修改，传 `""` 删除。
- **底层配置**：多值 Git 配置 `yunbox.pushFreeze`（每个值一组规则），以及 `yunbox.pushFreezeMessage`、`yunbox.pushFreezeTimeZone`，也可以直接用 `git config --add yunbox.pushFreeze "Mo-Fr 09:00-18:00"` 修改。无效的值会让 pre-push 检查失败（退出码 2），同样阻止推送。
- **生效范围**：只有带 `--stdin` 的 `yunbox inspect`（即 pre-push 包装层）会拦截；手动运行 `yunbox inspect --push` 和 macOS 客户端照常检查体积。`--guard` 模式的包装层不调用 `yunbox inspect`，需要时让 guard 自己先运行 `yunbox freeze check`。每个协作者的 clone 都要安装包装层，`yunbox doctor` 在设置了时段却没有包装层时给出警告。`git push --no-verify` 会绕过 pre-push 检查。
- **JSON**：`yunbox freeze list --json` 输出 `{ schemaVersion: 1, windows: [{ window, scope, timeZone? }], messages, check, hook }`，`window` 是规范化后的 `opening_hours` 写法，`check` 是此刻的检查结果（格式同下），`week` 是从今天起 7 个本机日历日的禁推区间 `[{ weekday, date, spans: [{ start, end }] }]`，`hook` 为 `inspect`（包装层会拦截）、`guard`、`none`，不在仓库里时为 `null`。macOS 客户端的菜单栏用它显示状态。`yunbox freeze check --json` 输出 `{ schemaVersion: 1, status: "allowed" | "frozen" | "paused", weekday, time, timeZone?, window?, scope?, message?, until?, pause? }`，`until` 为 `{ weekday, time, daysAhead }`，7 天内都不能推送时为 `null`。处在禁推时段时，`yunbox inspect --push --stdin --json` 输出 `{ schemaVersion: 1, status: "frozen", freeze: {…} }`，退出码 `1`。`scope` 为 `shared`（`.yunbox/config`）、`local`、`global` 等，`weekday` 为 `mon`…`sun`。
