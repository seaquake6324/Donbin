# Donbin 同频

A Discord Music Bot connecting with YouTube and BiliBili.

在 Discord 的任意文字频道用 `/play BV...` 或 `/play <YouTube 视频链接>` 点歌，Bot 会优先加入你当前所在的语音频道。暂停、切歌、查看队列和管理歌单，也可以在浏览器控制。浏览器页面默认只对本机开放；想从外网打开，可用 HTTPS 隧道，不需要在路由器上开放端口。

## 需要准备什么

- Node.js **22.13+**（推荐 24），以及 npm 或 pnpm。
- [FFmpeg](https://ffmpeg.org/download.html) 和 [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation)。在终端运行 `ffmpeg -version`、`yt-dlp --version` 验证；不在 PATH 时，在 `.env` 里填写可执行文件的绝对路径。
- YouTube 解析还需要 yt-dlp 的 EJS 组件。官方 `yt-dlp.exe` 已内置；用 pip 安装时请用 `python -m pip install -U 'yt-dlp[default]'`。Bot 会使用正在运行自己的 Node.js 作为 yt-dlp 的 JavaScript 运行时。Docker 镜像也已包含 EJS。
- 一个 Discord 服务器、一个默认音乐语音频道，以及你能管理的 Discord Application。

Windows 上**不必安装 Docker**。本机运行方式见下文。如果 Docker Desktop 因虚拟化或 WSL 无法启动，直接使用本机方案即可。

## 创建 Bot，填 `.env`

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)，新建 Application。在 **Bot** 页面复制 Token；在 **General Information** 复制 Application ID。
2. 在 **OAuth2 → URL Generator** 勾选 `bot` 和 `applications.commands`；Bot 权限至少勾选 **View Channels、Connect、Speak**。用生成的链接邀请到服务器。
3. 在 Discord 桌面版打开 **用户设置 → 高级 → 开发者模式**，右键左侧服务器图标复制服务器 ID，右键默认音乐语音频道复制频道 ID。

Guild 就是 Discord 的「服务器」。把值放在 `.env` 中对应等号的右边：

| 变量 | 填什么 |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → Bot → Token。不要公开。 |
| `DISCORD_CLIENT_ID` | Developer Portal → General Information → Application ID。 |
| `DISCORD_GUILD_ID` | 服务器图标右键 → 复制服务器 ID。 |
| `ADMIN_DISCORD_USER_ID` | 管理员本人的 Discord 用户 ID。首次升级时旧歌单会归到此账号。 |
| `MUSIC_VOICE_CHANNEL_ID` | 默认音乐语音频道右键 → 复制频道 ID。 |
| `DISCORD_CLIENT_SECRET` | Developer Portal → **OAuth2** → Client Secret。保密，不是 Bot Token。 |
| `WEB_PUBLIC_URL` | 打开网页用的地址。本机先填 `http://127.0.0.1:3000`；云服填固定的 HTTPS 域名。 |
| `WEB_SESSION_SECRET` | 自己生成至少 32 字符的随机字符串，用来签名登录 Cookie；重启后不要换。 |

```powershell
pnpm install
Copy-Item .env.example .env
```

编辑 `.env`，只改等号右侧。ID 是数字，不填频道名称或整个链接。`WEB_HOST=127.0.0.1` 和 `WEB_PORT=3000` 通常保持默认。`DATABASE_PATH` 保存歌单、账号、邀请码、消息和用户上次语音频道；不要把 `.env` 或数据库放到公开的网页目录。管理员 ID 必须填你自己的 Discord 用户 ID，不能填 Bot ID。

在 Developer Portal → **OAuth2 → Redirects** 中添加**完全一致**的回调地址：本机是 `http://127.0.0.1:3000/auth/discord/callback`。将来改用域名，例如 `https://music.example.com` 时，先在 Redirects 添加 `https://music.example.com/auth/discord/callback`，再将 `.env` 的 `WEB_PUBLIC_URL` 改成 `https://music.example.com` 并重启。网页只请求 `identify` 权限；不需要 Presence Intent、Server Members Intent 或 Message Content Intent。首次注册需 Discord 授权和邀请码；管理员账号不需要邀请码。之后直接用 Discord 登录，登录状态保持 7 天。只有指定服务器的成员可使用网页。

新部署时可用 `openssl rand -hex 32` 生成 `WEB_SESSION_SECRET`；Windows PowerShell 可用 `[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`，把输出填到 `.env`，不要发给别人。

**Intents：** Developer Portal → Bot → Privileged Gateway Intents 中的 Presence、Server Members、Message Content 都不需要打开。Bot 只使用 Guilds、Guild Voice States 和 Slash Commands。

私密语音频道需要在**编辑频道 → 权限**中把 Bot 或它的身份组加入允许名单，给 **View Channel、Connect、Speak**。在其他文字频道使用指令的成员需要 **View Channel、Use Application Commands**；可在服务器设置的 Integrations 中管理此 Bot 的命令权限。

## 启动

```powershell
pnpm run build
pnpm run register
pnpm start
```

没有 pnpm 时，可以用 `npm install`，再把 `pnpm run` 换成 `npm run`。`register` 把命令注册到 `DISCORD_GUILD_ID` 指定的服务器；首次安装或命令定义变化后运行。正常启动后，在运行 Bot 的电脑打开 **http://127.0.0.1:3000**，点击 **使用 Discord 登录**。

网页可以点播 BV、Bilibili 和 YouTube 视频链接，调节播放进度、控制播放、查看队列、创建/删除歌单、增删歌曲和播放歌单。登录后点击「召唤到我的语音频道」，Bot 会进入该 Discord 账号**当前**所在的普通语音频道；若不在语音则尝试上次频道。网页点播和播放歌单也会优先使用登录者当前或上次频道，两者都没有时用 `.env` 中的默认语音频道。Discord 内的 `/play` 同样优先使用点歌者的语音频道。

### 账号、歌单与分享

管理员用自己的 Discord 账号登录后，点击账号旁的「邀请码」：可以随机生成，也可以输入自定义码；设置可用次数（1–50）和有效天数（1–30）。邀请码只在创建时完整显示，记得当场复制给新用户；列表里只显示前四位、使用情况和撤销按钮。首次注册者在登录页填写邀请码，再完成 Discord 授权。Bot 会确认其属于所配置的服务器。不要把邀请码发到公开频道。

每个 Discord 用户拥有自己的歌单，可以使用相同的歌单名称。歌单默认公开：已注册的同服务器用户可以浏览和播放。创建者可以将它设为隐藏；隐藏后只有创建者及被单独分享的人能看到。分享时选择已注册用户，授予「仅查看与播放」或「共同编辑」。共同编辑者可增删歌曲，但不能删歌单、改公开状态或管理分享。分享、权限变更、取消分享以及公开状态变更会在网站的「消息」中通知相关用户。Discord `/playlist list` 会列出可见歌单及编号，播放别人歌单时可在名称位置输入 `#编号`；创建、删除、增删歌曲仍按所属权限检查。

### 从外网浏览器打开

无需让手机或其他设备安装客户端。Discord 登录要求回调地址与 Developer Portal 完全一致，所以**推荐固定 HTTPS 域名**，例如云服务器上的反向代理或正式 Cloudflare Tunnel。临时 Quick Tunnel 的地址每次可能变化，变化后必须同步更新 `WEB_PUBLIC_URL` 和 Developer Portal → OAuth2 → Redirects，使用起来不方便。若只做一次临时测试，可在**同一台电脑**安装 [Cloudflare 的 cloudflared](https://developers.cloudflare.com/tunnel/downloads/)，在另一个终端运行：

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

如果这个项目的 `.tools` 目录已有 `cloudflared.exe`，也可在项目目录直接运行 `& '.\.tools\cloudflared.exe' tunnel --url http://127.0.0.1:3000`，无需加入 PATH。当前工作目录中的 `.tools` 是本机工具目录，不会提交到仓库。

终端会打印一个 `https://…trycloudflare.com` 地址。先把它写入 `WEB_PUBLIC_URL` 并在 Developer Portal 添加对应的 `/auth/discord/callback` 回调，再重启 Bot。Bot 和 `cloudflared` 两个进程都要持续运行。长期使用请配置固定域名。**不要**把 Bot 的 HTTP 端口直接映射到公网；控制请求应经 HTTPS 入口传输。

## Discord 指令

在该服务器内允许使用应用命令的任意文字频道：

```text
/join
/play video:BV1xx411c7mD
/play video:https://www.youtube.com/watch?v=jNQXAC9IVRw
/queue
/nowplaying
/pause
/resume
/skip
/previous
/shuffle
/repeat
/stop
/diagnostics
```

`/join`：加入你**当前**所在的普通语音频道；不在语音频道时，加入系统记录的**你上次进入**的频道。Bot 只记录它在线时收到的进频道事件；首次使用若没有记录，先进入一次语音频道。`/join` 不开始播放；如果已有歌曲，声音会随 Bot 移动。

`/play`：如果你当前在语音频道，就加入你的频道；否则尝试你上次的频道；两者都没有时才使用 `MUSIC_VOICE_CHANNEL_ID`。网页点播也按登录者的语音频道选择。支持 BV 号、Bilibili 视频链接，以及 YouTube 的 `watch`、`youtu.be`、`shorts`、`live` 单视频链接。带播放列表参数的视频链接只播放该视频。`/playlist play` 使用与 Discord `/play` 相同的频道选择逻辑。

循环模式依次为 `off → one → queue → off`。手动 Skip 会跳过 Repeat One；Shuffle 只打乱待播部分。`/stop` 清空当前队列并退出语音频道，不删除歌单。

歌单命令在 `/playlist` 下：`create`、`delete`、`add`、`remove`、`show`、`list`、`play`。`remove` 的序号从 1 开始。歌单保存在 SQLite，Bot 重启后仍在；正在播放的队列和进度不会在重启后自动恢复。所有文字频道和网页共用同一套队列和歌单。

## Docker（可选）

Docker 镜像包含 FFmpeg 和 yt-dlp，适用于已经能运行 Docker Desktop 的电脑。复制并填写 `.env`，保持 `WEB_PORT=3000`：

```powershell
docker compose build
docker compose run --rm music-bot node dist/register.js
docker compose up -d
docker compose logs -f music-bot
```

Compose 只把网页映射到宿主机的 `127.0.0.1:3000`。要从外网访问，在宿主机运行上面的 `cloudflared` 命令。`./data` 挂载到容器内，重建容器不会删除歌单。Linux 上需要确保容器的 `node` 用户能写入 `data` 目录。

## 搬到云服务器

一台持续在线的 Linux 云服务器适合同时运行 Bot 和网页，通常能避开家用网络断线及电脑休眠。选机房时重点看它到 **Discord 语音的 UDP 连接**和 **Bilibili、YouTube 的访问速度**；CPU/内存需求相对小。先在服务器运行 `node dist/media-check.js BV1xx411c7mD 60` 和 `node dist/media-check.js 'https://www.youtube.com/watch?v=jNQXAC9IVRw'`，确认都能输出 PCM，再启动 Bot 并用 `/diagnostics` 检查语音。网页只监听 `127.0.0.1:3000`，公网入口请通过有 HTTPS 的反向代理或正式 Cloudflare Tunnel 转发，并设置 `WEB_PUBLIC_URL` 与 Discord OAuth 回调。将 `data/music.sqlite` 和 `.env` 安全复制过去，前者是歌单与上次语音频道记录，后者含 Bot Token、Client Secret 和会话密钥。迁移期间别让本机和云端同时使用同一个 Bot Token 运行。

## 排错与更新

- **Discord 显示“应用程序未响应”**：看 Bot 终端是否仍在运行，再运行 `/diagnostics`。指令会先确认收到请求，然后再解析 Bilibili；如果是网络或语音连接问题，稍后会返回具体错误。首次解析可能较慢。
- **Bot 不进语音**：确认你当前频道或默认频道允许 Bot **View Channel、Connect、Speak**。`/diagnostics` 会显示 Voice 状态和最近错误。
- **声音卡顿**：播放器启动前预缓冲约 1 秒 PCM，FFmpeg 会尝试重连网络。仍卡顿时检查部署机器到 Bilibili 和 Discord 的连接，更新 yt-dlp，试其他视频。缓冲不能修复持续带宽不足。
- **YouTube 解析失败**：先运行下面的 YouTube `media-check`；检查 Node.js 22+、yt-dlp 是否含 EJS。详见 [yt-dlp 官方 EJS 安装说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)。部分视频会因地区、登录要求或平台限制无法解析。
- **起播等待**：首次点播需要向平台解析临时音频地址，无法保证瞬间开始。Bot 会复用刚解析出的地址，并在歌曲结束前约 30 秒预解析下一首。换云服务器是否更快取决于机房到视频平台的网络，请在目标服务器运行 `media-check` 实测。
- **网页打不开或登录失败**：检查 Bot 是否在运行、`WEB_PORT` 是否被占用、`DISCORD_CLIENT_SECRET` 是否已填写、`WEB_PUBLIC_URL` 与 Developer Portal OAuth2 Redirects 是否完全一致。外网地址还需要 HTTPS 入口在运行。
- **命令没出现**：检查 Client ID、Guild ID、邀请链接的 `applications.commands`，然后重新运行 `pnpm run register`。
- **歌单不见了**：检查 `DATABASE_PATH` 是否指向原来的持久目录。

本机媒体链路检查与工程检查：

```powershell
pnpm run build
pnpm run media-check BV1xx411c7mD
pnpm run media-check BV1xx411c7mD 60
pnpm run media-check 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
pnpm run test
pnpm run lint
```

`media-check` 会用 yt-dlp 解析公开视频，再让 FFmpeg 在线解码 3 秒。某些视频会因地区、登录、版权限制或下架而不可用。若你有合法访问权限，可用 `YTDLP_COOKIES_PATH` 指向本机 cookies 文件，注意保护它。

更新：拉取新代码后运行 `pnpm install`、`pnpm run build`、`pnpm run register`，然后重启 Bot。Docker 用 `docker compose build --pull`、重新注册命令、`docker compose up -d`。更新前建议停 Bot 并备份 `data/music.sqlite`。
