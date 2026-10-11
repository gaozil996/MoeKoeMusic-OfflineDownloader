# 兼容性清单

这几个插件都是在 **MoeKoe Music 自己的 DOM、设置键和原生接口上**动手做的。
应用一升级，下面这些东西随时可能变。这份文件把耦合点全部列出来 ——
出问题的时候，先照着这里查一遍，能分清是「插件坏了」还是「应用变了」。

最后核对的应用版本见文末。

---

## 一、我们依赖的应用 DOM

### word-lyric

| 选择器 | 用来做什么 | 变了会怎样 |
|---|---|---|
| `#lyrics` | 逐字填充的根容器 | 逐字填充整个失效 |
| `#lyrics .char` | 单字元素，写 `--lyc-p` | 填充不精确，退化成整行变色 |
| `.line-group` | 一行歌词的容器 | 无法把 DOM 行映射到歌词数组 |
| `.lyrics-screen` | 全屏歌词页根节点（给字体用） | 歌词字体不跟随应用设置 |
| `.fullscreen-lyrics-settings .settings-panel` | 插件设置区挂载点 | 歌词增强面板整个不出现 |
| `.player-controls` | 全屏歌词页控制条 | 浅色背景下按钮看不清（衬底没了） |
| `.controls-overlay` | 桌面歌词窗口控制条 | 同上 |
| `.lock-button` | 桌面歌词窗口锁定按钮 | 衬底覆盖不到它 |
| `.lyrics-content` / `.lyrics-layer` / `.lyrics-text` / `.nolyrics` | 桌面歌词窗口的歌词面 | 桌面歌词字体不跟随 |
| `.player-menu` / `.quality-menu` / `.speed-menu` / `.playback-mode-menu` | 浮层配色自适应 | 浅色浮层里文字看不清 |
| `.player-container .duration` | 播放总时长 | 时长算不出来，逐字进度会偏 |
| `.player-container .progress-bar .progress` | 播放进度 | 同上 |
| `#app` | 应用根节点 | 界面字号失效 |

**特异性注意**：应用自己的歌词字体规则是
`.lyrics-content[data-v-...]`，特异性 (0,2,0) 且带 `!important`。
我们的 `.lyrics-content` 只有 (0,1,0)，同为 `!important` 时比不过 ——
所以类名连写三遍提到 (0,3,0)。**不要图好看改回单写。**

`[data-v-...]` 是构建哈希，我们**不引用**它，换版本就对不上。

### audio-viz

挂在 `.lyrics-screen` 的直接子元素、排在歌词栏之前。
容器被 Vue 重建时 canvas 会消失，插件定期补回。

### offline-dl

| 选择器 | 用来做什么 | 变了会怎样 |
|---|---|---|
| `.vue-recycle-scroller__item-view` | 歌单列表的行容器 | 「已下载」徽章挂不上 |
| `.track-title[title]` | 行内歌名（`title` 属性是干净的） | 同上 |
| `.track-artist[title]` | 行内歌手 | 同上 |
| `.track-title-tags` | VIP/SQ/MV 徽章区，标记插在它之后 | 徽章位置不对 |
| `.batch-action-btn` | 「离线下载本歌单」按钮的插入锚点 | 按钮跑位 |
| `.player-container` | 判断主播放器页面 | 单曲模式可能不出现 |
| `.extra-controls` / `.playback-speed` | 面板按钮的插入锚点 | 同上 |
| `.setting-card` / `.setting-card-title` / `.setting-card-header` / `.setting-card-value` | 设置页界面字号那一行 | 字号滑块插不进去 |

**`.track-*` 这一组有坑**：列表是虚拟滚动的，可视区之外的行不在 DOM 里，
滚回去时是新节点。所以标记必须能自愈，不能只在加载时打一次。

**歌单页的行里没有 hash**，只有 `title` 属性里的歌名和歌手，靠这两个匹配磁盘文件。
而且两边的标点不一致（接口的 `name` 自带歌手前缀、行上是裸歌名，
括号还一个全角一个半角），比较前必须先归一化。

## 二、我们依赖的应用设置

全在 `localStorage` 的 `settings` 里（一个 JSON）。

| 键 | 用来做什么 | 谁在用 |
|---|---|---|
| `font` | 界面字体（「字体设置」） | word-lyric（歌词字体回退用它） |
| `desktopLyricsFont` | 歌词字体（「歌词字体」） | word-lyric |
| `apiBaseUrl` | 接口地址 | offline-dl |

**应用只注入字体族，没有字号。** 源码里那段是：

```js
body, html, button, input, textarea, select { font-family: "...", ... !important }
```

所以「字体设置」改完之后字体变了、大小没变。界面字号是插件补的。

`lyrics-font-size`（桌面歌词字号，12~72 默认 32）和 `settings.desktopLyrics`
是应用自己用的，**插件一个字都不改**。

## 三、我们依赖的应用路由

| 路由 | 判断方式 | 用在哪 |
|---|---|---|
| `#/lyrics` | `location.hash.indexOf('lyrics') >= 0` | 桌面歌词窗口，界面字号要跳过 |
| `#/PlaylistDetail?...` | `detectRoute()` | offline-dl 认歌单 |
| `#/settings` | `location.hash.indexOf('settings')` | word-lyric 插字号行 |

**桌面歌词窗口是独立 BrowserWindow**（`transparent:true`、无边框、
`alwaysOnTop`、`skipTaskbar`），加载同一个 `index.html`。插件在两个窗口里
**各跑一份 content script**，所以任何跨窗口共享的状态都必须走
`localStorage` 再同步一次 —— 内存里的那份各是各的。

## 四、我们依赖的应用原生接口

两个宿主都走 MoeKoe 的 native host 机制
（`session.defaultSession.loadExtension` + `allowFileAccess`）。

- **offline-dl** 读 MoeKoe 的本地 API `http://127.0.0.1:6521`，
  鉴权头从 `localStorage.MoeData` 拼。
- **audio-viz** 走 Windows WASAPI 环回捕获，不碰播放链路。

宿主 exe 与前端之间是 stdin/stdout 的行 JSON。**大包会被传输层丢掉**：
几百个中文文件名编码后约 17 KB 的回包永不到达，前端只能等满 20 秒静默超时。
所以 `offline-dl` 的批量核对是**分批发候选名、宿主只回命中下标**，
不是「一次列全目录」。

## 五、和其它插件的冲突

`%APPDATA%\moekoemusic\extensions\` 下装了别的插件时：

- **字体/字号类插件**（主题、自定义、UI 美化）会和 word-lyric 的界面字号
  抢同一个位置 —— 两个都在 `html` 上挂 `zoom`，后写的赢。
- **歌词类插件**都会往歌词设置面板里插东西，顺序不确定，
  但只要是 `appendChild` 就不会互相破坏。
- **audio-viz 和 offline-dl 都带原生宿主**，两者互不干扰：
  一个只监听输出设备，一个只写磁盘，stdin/stdout 各连各的 exe。

## 六、权限模型

内容脚本的 `matches` 一律是 `file:///*`，不是 `<all_urls>`。

应用是用 `file://` 加载的（`session.defaultSession` 走扩展），主窗口、
桌面歌词窗口、全屏歌词页全都是同一个 `index.html`，所以 `file:///*` 就是
精确范围 —— 它能覆盖且仅覆盖本插件需要注入的那些页面。`<all_urls>` 在这里
没有任何额外收益，只是把「能进所有网站」这句话写进了清单。

`host_permissions` 按实际网络行为给：

| 插件 | host_permissions | 为什么 |
|---|---|---|
| word-lyric | `http://127.0.0.1/*`、`http://localhost/*` | 取 KRC 歌词要打本地 API |
| offline-dl | 同上 | 取流要打本地 API |
| audio-viz | **不申请** | 全程不联网，走 WASAPI loopback + 原生宿主 |

**一个已知的取舍**：应用的「设置 → 声音 → RPC 地址」允许把 API 指向自定义
主机（`settings.apiBaseUrl`）。word-lyric 和 offline-dl 读这个值，
但如果它不是回环地址，收窄后的 `host_permissions` 会拦下请求，
逐字歌词 / 下载取流会失败。默认配置（`apiBaseUrl` 为空、回落到
`http://127.0.0.1:6521`）完全不受影响。用自建 RPC 的话，
把 manifest 里的 `host_permissions` 补上你的主机即可。

## 七、依赖点挂掉时的降级行为

所有 DOM 读取都判空，没有一处是「拿到就往里写」。具体到每个依赖点：

| 依赖点没了 | 表现 | 会不会报错 |
|---|---|---|
| `#lyrics` | 逐字填充整个停摆，主循环空转 | 不报错，每帧一次 `querySelector` 返回 null 后直接 return |
| `#lyrics .char` | 填充退化成整行变色 | 不报错，`spans.length` 为 0 时跳过该行 |
| `.line-group` | 无法映射 DOM 行 ↔ 歌词数组 | 不报错，`groups.length` 为 0 时返回 |
| `.fullscreen-lyrics-settings .settings-panel` | 设置面板不出现 | 不报错，`mount()` 返回 false，40 帧后重试 |
| `.player-container .progress-bar .progress` | 时间轴读不到，进度停在 0 | 不报错，逐字填充退化为不动 |
| `.player-container .duration` | 时长算不出来 | 不报错，进度按 0 处理 |
| `.vue-recycle-scroller__item-view`（offline-dl） | 「已下载」徽章挂不上 | 不报错，标记每次滚动重新打 |
| `.fullscreen-lyrics-settings`（audio-viz） | 画布不挂 | 不报错，定时补回 |

换句话说：**DOM 变了的后果是某个功能不生效，不是插件把应用搞崩、也不是
控制台刷屏。** 主循环和各个定时任务各自兜住了异常，抛错会指名道姓说是哪一步。

想加新依赖的话，请同时在第一节的表里加一行，写清楚「变了会怎样」。

## 八、版本与验证

最后核对的版本：

- MoeKoe Music **V1.7.0 - win32**（`D:\MoeKoe Music\resources\app.asar`）
- 应用是 `file://` 加载的，扩展走 `session.defaultSession`

验证过的运行环境：

- Windows，显示器 2560×1440
- Node v22（只用 `node --check` 做语法检查）
- 原生宿主用 `$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译

## 九、应用升级后怎么查

1. 打开开发者工具控制台，看四个插件的日志前缀
   （`[LyricW]` / `[OfflineDL]` 等）有没有报「某一步失败」。
   主循环和定时任务都各自兜住了异常，报错会指名道姓说是哪一步。
2. 对照上面第一、二、三、七节的表逐条看。
3. 改了应用的类名或设置键的话，**本文件要一起改** ——
   这是唯一能一眼看出「谁变了」的地方。
