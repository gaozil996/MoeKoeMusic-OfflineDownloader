# offline-dl

MoeKoe Music 插件：单曲下载 + **歌单批量下载**，下完不联网也能播。

## 两种模式

| 模式 | 入口 | 行为 |
|---|---|---|
| 单曲 | 播放条 `⤓` → 单曲 | 下载当前播放的这一首 |
| 歌单批量 | `⤓` → 歌单批量 | 识别当前歌单页或从「我的歌单」选，拉取全部歌曲，勾选后队列下载 |

打开歌单详情页时，页面右上角会出现「↓ 离线下载本歌单」按钮，一键识别。

同一页的歌曲列表里，**已经在磁盘上的曲目会直接挂一个绿色「已下载」徽章**，
就在应用自己的 VIP / SQ / MV 那一排右边，不需要打开面板。

## 保存方式

**native host 直接写盘**（`host/moekoe-saver.exe`），不走浏览器下载机制，
不弹任何保存框，文件名 `歌手 - 歌名.扩展名` 直接落到目标目录
（默认 `D:\MoeKoeMusic`，可在 MoeKoe 的下载设置里改）。

扩展名**从返回的 URL 里读真实后缀**，不靠猜。这样服务端给什么格式就存什么格式，
不会把 flac 存成 `.mp3`。

## 音质

四档：标准 / 高品 / 无损 / Hi-Res。

`/song/url` 的 `quality` 取值：`128` / `320` / `flac` / `high`
（`high` 是接口对 hi-res 的叫法，返回的 URL 带 `quhigh` 前缀）。

变体（variant）来自 `/privilege/lite`，实测形如：

```
["128","128","320","flac","high","viper_atmos","viper_tape","viper_clear","multitrack"]
```

**取流和匹配是两件事。** 接口本身很给力 —— 直接 `?quality=flac` 就能拿到
几十 MB 的真 flac，不需要切换 hash。切换 hash 的意义在于精确命中某个变体。

三个必须注意的地方：

- **`high` 会撞车。** 320kbps mp3 在接口里也叫 `high`。如果把 `high` 同时挂在
  320 和 Hi-Res 的标签上，选 Hi-Res 会解析到普通 mp3。现在 `high` 只属于 Hi-Res，
  320 靠 `320` / `mp3-320` / `hq` 匹配。

- **要往下降了。** 请求的档位不存在时按 `hires → flac → 320 → 128` 逐级降级，
  而不是直接失败。循环必须朝**低**音质方向走（写反了会往高音质找）。

- **杜比全景声不是 Hi-Res。** `viper_atmos` / `multitrack` 不参与匹配，
  否则会拿到杜比音轨当 Hi-Res 卖。

匹配前统一过一遍 `normQuality()`：接口混用码率（`"128"`、`128`）、
单词（`standard`、`high`）和产品名（`viper_tape`、`flac`），折叠成一套词表
才能让精确匹配可靠。

## 原生宿主（Host.cs）

### 报文是嵌套的，必须真正解析 JSON

native host 收到的报文包了一层：

```json
{"type":"message","payload":{"id":"dmuy9fweq_1","cmd":"download","url":"...","dest":"..."}}
```

早期版本用了一个手写的平铺解析器，只认顶层 key/value。它读到 `payload` 时
把整个嵌套对象当成一个不透明字符串吞了下去，于是 `id` / `cmd` / `url` / `dest`
**全部取不到**。日志里明明白白写着 `-> cmd=download id=<none>`：

exe 拿不到 id 就无法把回包关联到请求，前端 `pending[id]` 永远等不到匹配，
只能熬满 20 秒静默超时 —— 表现就是"完全下不了"。

现在换成一个能正确下钻嵌套对象/数组的实现，带 `\uXXXX` 转义还原。

### bridge 必须整体透传 payload

`bridge.js` 里的 `request()` 原本只往 exe 转发 `id` / `cmd` / `url` / `dir` / `dest`
五个字段。新加的 `check` 命令带 `names` 数组，被这层静默丢掉了 ——
exe 收到的是一个没有 `names` 的 `check`，回一个空的 `have`，前端等满 20 秒超时。
现在改成把 payload 里其余字段全部转发。

### 必须强制 UTF-8

```csharp
Console.InputEncoding  = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
```

不设的话按系统代码页（中文环境 GBK）读 stdin，中文歌名全部乱码，
`dest` 会在 `?` 处被提前截断。乱码文件名还会在磁盘上留下
`鏈ㄥ皬闆?-....flac` 这种 GBK/UTF-8 双重误解码的产物。

### 先写 `.part`，校验长度，再改名

直接开目标文件写的话，中途崩溃会留下一个**截断但看起来完整**的文件，
下一次重跑还会理直气壮地"跳过"它。

现在的流程：写 `xxx.flac.part` → 拿 `Content-Length` 校验实际收到的字节数
→ 短读就当失败 → `File.Move` 原子改名 → 失败则删 `.part`。

### 重试与超时

网络抖一下就永久失败，在批量下 100 首时是致命的。3 次重试，指数退避，
每次重试前补发一次进度消息（避免前端 20 秒静默 watchdog 误判为失联）。

`ReadWriteTimeout` 用 **15 秒**，不是常见的 2 分钟。卡住时必须快速失败好进重试循环；
挂两分钟只会让 UI 先超时，然后留下一堆半截文件。

### 错误要说人话

`WebException` 翻成具体原因：

| 原始 | 实际显示 |
|---|---|
| `远程服务器返回错误: (403) 已禁止。` | `HTTP 403 无访问权限（该曲目需要会员或受地区限制）` |
| `无法解析名称或服务未知` | `域名解析失败` |
| `操作超时` | `连接超时` |

## 接口

全部走 MoeKoe 自己的本地 API `http://127.0.0.1:6521`，鉴权头从
`localStorage.MoeData` 拼（`token` / `userid` / `dfid` / `t1` / `mid` / `guid` 等）。

| 用途 | 接口 |
|---|---|
| 歌单全部歌曲 | `GET /playlist/track/all?id=<listid>&pagesize=300&page=N` |
| 我的歌单列表 | `GET /user/playlist?pagesize=100&t=<t>` → `data.info[]` |
| 音质与真实 hash | `GET /privilege/lite?hash=` → `data[].quality` + `relate_goods[].hash` |
| 播放地址 | `GET /song/url?hash=&quality=&ppage_id=356753938` |

这些接口和参数是从 `app.asar` 里 MoeKoe 自己的实现里抠出来的，不是猜的。

**`ppage_id` 不能省。** MoeKoe 自己请求 `/song/url` 时永远带这个参数，
不带的话有一批曲目会回 HTTP 200 但 `url` 为空。实测一个 195 首的歌单：
不带时成功 189 首，带上后 194 首。

**取流要走完整条音质链。** `relate_goods` 里每首通常有 2~4 个变体，
各自的 hash 不同（`/song/url` 要的是**该音质对应那个 hash**，不是主 hash）。
从请求的档位开始往下逐个试，任一档返回地址就停。全试完还没有才是真拿不到。

## 歌单页上的「已下载」徽章

徽章挂在应用自己的列表里，结构（探针实测）：

```
.vue-recycle-scroller__item-view
  .track-title[title=歌名]   > .track-title-text / .track-title-tags
  .track-artist[title=歌手]
```

三个绕不开的点：

**行里没有 hash。** 只有 `title` 属性里的歌名和歌手，所以要靠
「歌手 + 歌名」去匹配磁盘上的文件。

**两边的歌名对不上。** 接口的 `name` 自带歌手前缀（`金志文 - 远走高飞（独唱版）`），
行上的 `title` 只有裸歌名，而且括号是全角 `（）`、磁盘上是半角 `()`。
所以比较前统一过一遍 `plNorm()`：只保留字母、数字、下划线和 CJK，
其余（标点、空格、全半角括号）全部丢掉，歌手前缀用 `plStripArtist()` 剥掉。

**列表是虚拟滚动的。** `.vue-recycle-scroller__item-view` 可视区之外的行不在 DOM 里，
滚回去时又是新的节点。所以每 3 秒 + 每次 DOM 变化都重扫一遍当前存在的行，
缺哪个补哪个，而不是只在加载时打一次标记。

## 批量核对：为什么不是「一次列全目录」

最早想的是让宿主返回整个目录的文件名清单，插件本地比对。**这条路走不通**：
几百个中文文件名编码后约 17 KB，回包直接被吞掉，前端只能等满 20 秒静默超时。
`exists` 小包 10ms 就回，`list` 大包永不到达 —— 上限在传输层，不在代码里。

现在的做法是反过来：插件把候选文件名分批（每批 24 个，约 1.4 KB）发给宿主的
`check` 命令，宿主做比对、只回命中的下标（约 90 字节）。195 首的歌单是 9 次往返、
合计 100 毫秒，比原来 195 次串行 `exists` 快一个数量级。

`check` 的比对**忽略标点和空格**。酷狗对同一首歌的标点并不稳定：
下载时返回 `远走高飞 (独唱版)`，后来返回 `远走高飞（独唱版）`，
精确比对会把 26 首已下载的曲目报成没有。`check` 保留的字符集
（字母、数字、下划线、CJK）与前端 `plNorm()` 完全一致。
`exists` 保持精确比对 —— 它管的是「跳过不跳过」，宁可漏跳也不能错跳。

## 歌单识别

`location.hash` 形如 `#/PlaylistDetail?listid=xxx&global_collection_id=yyy`，
取 `listid`，没有就取 `global_collection_id`。

歌单详情页打开面板会自动识别；「识别当前页」从页面 DOM 取歌单，
**不依赖 `/user/playlist`** —— 上游接口挂掉返回 502 时这条路径照样能用。

## 批量细节

- 串行下载，每首间隔 600ms，避免把接口打挂
- 进度条 + `已完成/总数 · 累计 MB · 跳过数 · 失败数`
- 失败的歌记进清单（歌名 + 原因），不中断整体队列
- 随时「停止」
- **已下载标记**：拉取歌单后向宿主批量核对「目录里有没有这些文件」（`check`
  命令，每批 24 个），有的挂一个绿色「已下载」徽章并把歌名灰掉。
  判定只看文件名、不看扩展名 —— 落成 flac 还是 mp3 取决于当时拿到哪个码率，
  而"下过了没有"是另一回事，不该跟着音质选择器变来变去。
  拉取后、下载完成后各刷新一次
- **跳过目录里已有的同名文件**（默认勾上）：判重问的是原生宿主，不是浏览器缓存 ——
  `localStorage` 索引会被清掉，而清掉之后重跑一次就是几个 G 的白下。
  想强制重下（比如换成 Hi-Res）就取消勾选
- **只重试失败的**：失败项的 hash 存 `localStorage`，重开 app 之后依然在

## 下不下来的两类

批量跑完一定会剩几首，分清是哪种，界面上也会直接写明：

| 现象 | 原因 |
|---|---|
| 面板提示「N 首已被酷狗屏蔽」 | 上游只回 `{"fileid": 91, "shield": 1}` —— 没有歌名、没有歌手、没有 hash，服务端就没有可下载的内容 |
| 「酷狗返回无播放权限（priv_status=0）」 | 服务端明确答复这个账号不能取这一首。已穷举过 4 个 hash × 7 档音质 × 带/不带 `ppage_id`，共 56 种组合全部回 `priv_status=0` |
| 「未返回播放地址」 | 走了 `ppage_id` + 全部音质变体仍然拿不到地址，且服务端没明说原因 |

服务端明说没权限的曲目**不进重试清单**（错误对象带 `noRetry`），
完成提示里单独算作「无权限 N 首」，和真正需要重试的失败分开显示 ——
重试改变不了权限，把这两类混在一起只会让人反复点一个不可能成功的按钮。

## 原生宿主命令

| 命令 | 作用 |
|---|---|
| `ping` / `ping_all` | 探活 |
| `download` | 下载到指定目录（`.part` 落盘 + 校验长度后改名） |
| `exists` | 目录里有没有这个文件（精确比对 stem，同名任意扩展名都算命中；手工比对而不是用通配符，避免歌名里的 `[` `?` 被当成 glob） |
| `check` | 一批候选名里哪些已存在，忽略标点差异；回包只给命中的下标，用于批量标「已下载」 |

## 安装

把 `offline-dl` 目录整个放进：

```
%APPDATA%\moekoemusic\extensions\offline-dl
```

重启 MoeKoe Music。播放条多一个 `⤓` 按钮。
首次下载时 native host 会自动拉起（`auto_start`），面板右下角显示状态。

## 排查

`_odl_host_debug.log`（在 `%APPDATA%\moekoemusic\`）是 exe 的运行日志。

| 日志 | 含义 |
|---|---|
| `-> cmd=download id=<none>` | JSON 解析坏了，`id` 没取到 |
| `dest` 是乱码 | UTF-8 没生效 |
| `attempt N failed` | 正在重试，看后面的原因 |
| 没有任何 `STDIN` | 请求根本没到 exe，查 `config.json` 的 `nativeHostPermissions` |
| 有 `-> cmd=` 但前端报「无响应」 | exe 回的包太大被传输层丢了。缩小批次，别改成一次列全目录 |
| 面板一直显示「本地程序待启动」 | `getStatus` 把字段放在 `host.running` / `host.platforms.win32.authorized` 里，直接读顶层永远是 undefined |

## 边界

- 取流依赖 hash，纯本地文件（`isLocal`）和云盘音乐没有 hash，跳过。
- 有些曲目（VIP / 地区限制）接口不返回可播地址，这类会如实报
  "未返回播放地址"，是服务端限制不是插件问题。
- 歌单超过 10 页（3000 首）会停在第 10 页 —— `fetchPlaylistSongs` 的循环上限。