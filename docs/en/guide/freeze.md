# Push freeze

A push freeze blocks pushes during the windows you choose, such as working hours, integration testing, a release freeze or a demo. When a push freeze is in effect, the push stops before anything is uploaded, and Git shows the reason and when you can push again:

```text
禁止推送：现在是周一 11:30，处于禁推时段 Mo-Fr 09:00-18:00（本仓库 .git/config），18:00 后可以推送。
No pushes during working hours; push after 18:00
查看或修改禁推时段：yunbox freeze list
error: failed to push some refs to '…'
```

The first line says pushing is blocked because it is Monday 11:30, inside the window `Mo-Fr 09:00-18:00` set in this repository's `.git/config`, and that you can push after 18:00; the second line is your custom message, and the third points you to `yunbox freeze list` to view or change the windows.

Rules live in three places, and all of them apply at the same time:

| Scope | Where it is saved | Who it affects |
| --- | --- | --- |
| This repository | `.git/config` in this clone | Only your own clone |
| Team | `.yunbox/config` in the repository, shared once committed | Every collaborator who pulls that commit |
| Global | `~/.gitconfig` | Every repository on your computer |

::: warning Install the pre-push check first
The pre-push wrapper is what blocks the push, and you need to install it once in every clone: `yunbox hook install` (see [Push Size Check](../inspect#run-before-uploading)). The macOS app installs it automatically when you pick a preset for a project, and `yunbox doctor` warns you if windows are set but the wrapper is missing.
:::

## Get started in three minutes

### With the macOS app

1. Click the YunBox icon in the menu bar to open the panel. When the current repository is inside a push freeze, the icon shows a dot in its top-right corner.
2. Under "Projects", expand the repository you want to set up (if it is not listed, click "Add Project…"). Click "＋" next to "This repository" or "Team" and tick a preset, such as "Working hours".
3. To apply a rule to every repository, pick it from the "＋" next to "Global Rules".

The panel shows whether you can push right now, a timeline for today and the push freeze windows for the next 7 days. For more complex rules, use "Edit Push Freeze…". See [the macOS app](./macos) for details.

### From the command line

```bash
yunbox hook install                                   # once per clone
yunbox freeze set "Mo-Fr 09:00-18:00" --message "No pushes during working hours; push after 18:00"
yunbox freeze list                                    # list all active windows
yunbox freeze check --at "Fr 17:30"                   # preview whether you can push at a given time
```

### Hand it to AI

Tell your coding assistant "no pushes on weekdays from 9:00 to 18:00", and it runs `yunbox freeze set "Mo-Fr 09:00-18:00"` and confirms the result with `yunbox freeze check --json`. All the commands are non-interactive and have JSON output. See [Set up with an AI coding assistant](./ai).

## Common scenarios

| Scenario | Command |
| --- | --- |
| No pushes during working hours | `yunbox freeze set "Mo-Fr 09:00-18:00"` |
| Allow pushes over lunch | `yunbox freeze set "Mo-Fr 09:00-12:00,13:30-18:00"` |
| Team weekend freeze | `yunbox freeze set "Fr 18:00-24:00; Sa,Su" --shared --timezone Asia/Shanghai`, then commit `.yunbox/config` |
| Keep nights free for CI | `yunbox freeze set "22:00-08:00" --global` |
| Freeze on weekdays, but not on Wednesdays | `yunbox freeze set "Mo-Fr 09:00-18:00; We off"` |
| Let an urgent fix through for an hour | `yunbox freeze off --for 1h` |
| Remove this repository's rules | `yunbox freeze clear` |

## Window syntax

Windows use (a subset of) the OpenStreetMap [`opening_hours`](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification) syntax. It is the most widely used format for describing fixed weekly hours: maps, business opening hours and many open-source libraries use it, and it is easy for both people and AI to read and write.

| Syntax | Meaning |
| --- | --- |
| `Mo-Fr 09:00-18:00` | Working hours on weekdays |
| `Mo-Fr 09:00-12:00,13:30-18:00` | Separate several windows in one day with commas (pushes allowed over lunch) |
| `Sa,Su` | Days without times mean the whole day |
| `24/7` | All day, every day |
| `Fr 22:00-02:00` | Crosses midnight and counts as the day it starts: Friday night until 02:00 on Saturday |
| `Mo-Fr 09:00-18:00; We off` | Separate rules with `;`. A later rule **overrides** earlier ones for the same day (no freeze on Wednesday) |
| `10:00-12:00` | No days means every day |

- Windows include the start and exclude the end: `09:00-18:00` blocks pushes from 09:00 and allows them again from 18:00. `24:00` can only be used as an end time.
- Write days as `Mo Tu We Th Fr Sa Su`, ranges as `Mo-Fr` (ranges can wrap around the week, such as `Fr-Mo`) and lists as `Sa,Su`. The CLI also accepts `mon`…`sun` and `weekdays` / `weekends`, as well as the Chinese equivalents `周一`…`周日`, `工作日` (weekdays) and `周末` (weekends). Everything is rewritten in `opening_hours` form when saved.
- `--days Mo-Fr` adds the days to every rule that does not name any, for example `yunbox freeze set 09:00-12:00,14:00-18:00 --days Mo-Fr`.
- The `;`-separated rules within one argument follow the override rule above. Windows from separate arguments and from different scopes all **apply at the same time** (a match in any of them blocks the push). Adjacent or overlapping windows are merged when working out when pushing is allowed again, looking up to 7 days ahead.
- Weekdays are based on the day of the week only. Public holidays and swapped working days are **not** taken into account: `opening_hours`'s `PH` (public holiday) needs a holiday calendar and is not supported yet; using it is an error.

Why not cron: GitLab's Deploy freeze and Argo CD's sync windows use cron expressions, but cron describes points in time. A window then takes two expressions, one for the start and one for the end (GitLab), or a start plus a duration (Argo CD), so working hours become `0 9 * * 1-5` plus `0 18 * * 1-5`, which is hard to read and easy to get wrong. iCalendar's RRULE can express more complex recurrence, but it is overkill for fixed weekly windows.

## Quick off

When you need to push for an urgent fix or a release patch, you do not have to delete your rules. Turn the push freeze off with `yunbox freeze off`, and it comes back on automatically when the time is up (similar to Do Not Disturb on macOS):

```bash
yunbox freeze off --for 1h             # no blocking in this repository for 1 hour
yunbox freeze off --until 18:00        # until 18:00 today (tomorrow if already past)
yunbox freeze off --global --until 24:00   # every repository on this computer, until the end of today
yunbox freeze off                      # off until you run yunbox freeze on
yunbox freeze on                       # turn back on early; --global turns global back on
```

- While it is off, no window blocks a push (this repository, team or global), and all rules are kept as they are. When you push, pre-push shows 「禁推时段已关闭（至今天 16:30），本次推送不受 Mo-Fr 09:00-18:00 限制」, meaning the push freeze is off until 16:30 today and this push is not restricted by `Mo-Fr 09:00-18:00`.
- By default this only affects the current clone (written to `.git/config`). `--global` turns it off for every repository on this computer (written to `~/.gitconfig`). Turning it off is a personal action and cannot be saved in the team's shared `.yunbox/config`; if it is found there, it is reported as an error.
- `--for` accepts `30m`, `1h`, `1h30m` and `2d` (30 days at most). `--until` accepts a local time `HH:MM` or `"Mo 09:00"`, and `24:00` means the end of today. The underlying setting is `yunbox.pushFreezePausedUntil` (an ISO 8601 time or `forever`), which stops applying once it expires; `clear` also removes it.
- While it is off, `yunbox freeze check` returns `status: "paused"` with exit code `0` and includes `pause: { scope, until }`. `pauses` in `list --json` lists every pause that is still in effect.

## Time zones, where rules are saved, and what they apply to

- **Time zones**: By default each computer uses its own time zone. If your team spans several time zones, use `--timezone Asia/Shanghai` (an IANA name) so the windows in that scope are calculated in the same time zone; Node.js handles daylight saving time, and messages are shown in that time zone too. The time passed to `check --at` is read in your local time zone.
- **Where rules are saved**: By default rules are written to this repository's `.git/config` and only affect this clone. `--shared` writes them to the repository's `.yunbox/config`, which applies to the whole team once committed. `--global` writes them to `~/.gitconfig`, which affects every repository on this computer. `set` replaces all windows in that scope. `--message` and `--timezone` are only changed when you pass them; pass `""` to remove them.
- **Underlying settings**: The multi-valued Git setting `yunbox.pushFreeze` (one set of rules per value), plus `yunbox.pushFreezeMessage` and `yunbox.pushFreezeTimeZone`. You can also change them directly, for example with `git config --add yunbox.pushFreeze "Mo-Fr 09:00-18:00"`. An invalid value makes the pre-push check fail (exit code 2), which also blocks the push.
- **What blocks a push**: Only `yunbox inspect` with `--stdin` (that is, the pre-push wrapper) blocks pushes. Running `yunbox inspect --push` by hand and the macOS app still check the push size as usual. A wrapper in `--guard` mode does not call `yunbox inspect`; if you need a push freeze there, have your guard run `yunbox freeze check` first. Every collaborator needs the wrapper installed in their clone, and `yunbox doctor` warns when windows are set but no wrapper is installed. `git push --no-verify` skips the pre-push check.
- **JSON**: `yunbox freeze list --json` outputs `{ schemaVersion: 1, windows: [{ window, scope, timeZone? }], messages, check, hook }`. `window` is the normalized `opening_hours` form, `check` is the result of a check right now (same format as below), `week` lists the push freeze intervals for 7 local calendar days starting today as `[{ weekday, date, spans: [{ start, end }] }]`, and `hook` is `inspect` (the wrapper blocks pushes), `guard` or `none`, or `null` outside a repository. The macOS app's menu bar uses it to show the status. `yunbox freeze check --json` outputs `{ schemaVersion: 1, status: "allowed" | "frozen" | "paused", weekday, time, timeZone?, window?, scope?, message?, until?, pause? }`, where `until` is `{ weekday, time, daysAhead }`, or `null` if you cannot push at any point in the next 7 days. During a push freeze, `yunbox inspect --push --stdin --json` outputs `{ schemaVersion: 1, status: "frozen", freeze: {…} }` with exit code `1`. `scope` is `shared` (`.yunbox/config`), `local`, `global` and so on, and `weekday` is `mon`…`sun`.
