import 'dotenv/config';
import { ChannelType, Client, Events, GatewayIntentBits, type ChatInputCommandInteraction, type Guild } from 'discord.js';
import { MusicEngine } from './engine.js';
import { MediaResolver, parseMediaInput } from './media.js';
import { PlaylistStore } from './playlists.js';
import { startWeb } from './web.js';

const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'MUSIC_VOICE_CHANNEL_ID', 'ADMIN_DISCORD_USER_ID'] as const;
for (const key of required) if (!process.env[key]) throw new Error(`缺少环境变量 ${key}`);
const config = {
  token: process.env.DISCORD_TOKEN!, guild: process.env.DISCORD_GUILD_ID!, voice: process.env.MUSIC_VOICE_CHANNEL_ID!,
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ytdlp: process.env.YTDLP_PATH || 'yt-dlp', cookies: process.env.YTDLP_COOKIES_PATH,
  clientId: process.env.DISCORD_CLIENT_ID || '', clientSecret: process.env.DISCORD_CLIENT_SECRET,
  webPublicUrl: process.env.WEB_PUBLIC_URL, webSessionSecret: process.env.WEB_SESSION_SECRET,
  webHost: process.env.WEB_HOST || '127.0.0.1', webPort: Number(process.env.WEB_PORT || '3000'),
  adminId: process.env.ADMIN_DISCORD_USER_ID!,
};
if (!Number.isInteger(config.webPort) || config.webPort < 1 || config.webPort > 65535) throw new Error('WEB_PORT 必须是 1–65535。');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const store = new PlaylistStore(process.env.DATABASE_PATH || './data/music.sqlite', config.adminId);
const media = new MediaResolver(config.ytdlp, config.cookies);
let engine: MusicEngine;
let webServer: ReturnType<typeof startWeb> | undefined;

function formatDuration(seconds: number | null): string { if (seconds == null) return '未知'; const whole = Math.round(seconds); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`; }
const playerLabel: Record<string, string> = { idle: '空闲', loading: '加载中', playing: '播放中', paused: '已暂停', error: '出错' };
const repeatLabel: Record<string, string> = { off: '关闭', one: '单曲循环', queue: '队列循环' };
function queueText(): string {
  const q = engine.queue;
  const current = q.current ? `[${q.current.title}](${q.current.url}) (${formatDuration(q.current.duration)})` : '暂无';
  const upcoming = q.upcoming.slice(0, 12).map((t, i) => `${i + 1}. ${t.title}`).join('\n') || '空';
  return `**状态：**${playerLabel[engine.status]} · **语音：**${engine.voiceStatus() === 'ready' ? '已连接' : '未连接'}\n**当前：**${current}\n**歌单：**${q.playlistName ?? '手动队列'} · **循环：**${repeatLabel[q.repeat]}\n**待播 ${q.upcoming.length} 首：**\n${upcoming}${q.upcoming.length > 12 ? '\n…' : ''}`;
}
async function diagnostics(): Promise<string> {
  const checks = await Promise.allSettled([engine.ffmpegVersion(), media.check()]);
  const status = (i: number) => checks[i].status === 'fulfilled' ? (checks[i] as PromiseFulfilledResult<string>).value.slice(0, 100) : `不可用：${(checks[i] as PromiseRejectedResult).reason}`.slice(0, 180);
  let database = '失败';
  try { database = store.check() ? 'OK' : '失败'; } catch (err) { database = `失败：${err instanceof Error ? err.message : String(err)}`; }
  return `Discord: ${client.isReady() ? 'ready' : 'not ready'}\nVoice: ${engine.voiceStatus()} (${engine.currentVoiceChannelId() ?? '无'})\nPlayer: ${engine.status}\nCurrent: ${engine.queue.current?.title ?? '无'}\nQueue: ${engine.queue.upcoming.length} 待播 / ${engine.queue.history.length} 历史\nRepeat: ${engine.queue.repeat}\nFFmpeg: ${status(0)}\nyt-dlp: ${status(1)}\nDatabase: ${database}\nWeb: ${webServer?.listening ? `${config.webHost}:${config.webPort}` : '未启动'}\n最近错误: ${engine.lastError ?? '无'}`;
}
async function userVoiceChannel(i: ChatInputCommandInteraction, useDefault: boolean): Promise<string> {
  const guild = i.guild ?? await client.guilds.fetch(config.guild);
  const currentState = await guild.voiceStates.fetch(i.user.id).catch(() => guild.voiceStates.cache.get(i.user.id));
  const current = currentState?.channelId ?? null;
  const channelId = store.voiceTarget(i.user.id, current) ?? (useDefault ? config.voice : null);
  if (!channelId) throw new Error('你当前不在语音频道，也没有上次频道记录。先进入一个语音频道再用 /join。');
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('目标语音频道已不存在或不是普通语音频道。请进入一个有效频道再试。');
  if (current) store.rememberVoice(i.user.id, current);
  return channelId;
}
async function webUserVoiceChannel(guild: Guild, userId: string, useDefault = false): Promise<string> {
  const state = await guild.voiceStates.fetch(userId).catch(() => guild.voiceStates.cache.get(userId));
  const current = state?.channelId ?? null;
  const channelId = store.voiceTarget(userId, current) ?? (useDefault ? config.voice : null);
  if (!channelId) throw new Error('该用户尚无语音频道记录，请先进入语音频道。');
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('语音频道已不存在，请先进入一个普通语音频道。');
  if (current) store.rememberVoice(userId, current);
  await engine.join(channelId);
  return channelId;
}
async function isGuildMember(guild: Guild, userId: string): Promise<boolean> {
  try { await guild.members.fetch({ user: userId, force: true }); return true; }
  catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 10007) return false;
    throw err;
  }
}
async function playlistCommand(i: ChatInputCommandInteraction): Promise<string> {
  const userId = i.user.id;
  store.ensureUser(userId, i.user.username);
  const action = i.options.getSubcommand();
  if (action === 'list') return store.list(userId).map(p => `${p.permission === 'owner' ? '我的' : p.ownerName + ' 的'} #${p.id} ${p.name}${p.visibility === 'private' ? '（隐藏）' : ''}`).join('\n').slice(0,1900) || '暂无可见歌单。';
  const name = i.options.getString('name', true).trim();
  if (action === 'create') { store.create(userId,name); return `已创建歌单「${name}」。`; }
  if (action === 'delete') return store.delete(userId,name) ? `已删除「${name}」。` : '找不到歌单。';
  if (action === 'add') { const track = await media.resolve(i.options.getString('video', true), i.user.username); store.add(userId,name,track); return `已添加「${track.title}」到「${name}」。`; }
  if (action === 'remove') return store.remove(userId,name,i.options.getInteger('position', true)) ? '已删除歌曲。' : '序号不存在。';
  if (action === 'show') return store.songs(userId,name).map((t, idx) => `${idx + 1}. ${t.title} (${t.source === 'youtube' ? 'YouTube' : 'Bilibili'}: ${t.id})`).join('\n').slice(0, 1900) || '歌单是空的。';
  if (action === 'play') {
    const tracks = store.songs(userId,name);
    if (!tracks.length) return '歌单是空的。';
    await engine.join(await userVoiceChannel(i, true));
    const info = store.info(userId,name);
    engine.replace(tracks, info.name);
    return `开始播放「${info.name}」，共 ${tracks.length} 首。`;
  }
  return '未知操作。';
}
async function removeOldControlMessage(guild: Guild): Promise<void> {
  const channelId = process.env.MUSIC_TEXT_CHANNEL_ID;
  const messageId = store.setting('panel_message_id');
  if (!channelId || !messageId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message && message.author.id === client.user?.id) await message.delete();
    store.setSetting('panel_message_id', '');
    console.log('旧 Discord 控制消息已清理。');
  } catch (err) { console.warn('旧控制消息清理失败，可手动删除：', err); }
}

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(config.guild);
    const voice = await guild.channels.fetch(config.voice);
    if (!voice || voice.type !== ChannelType.GuildVoice) throw new Error('MUSIC_VOICE_CHANNEL_ID 必须是普通语音频道。');
    const administrator = await guild.members.fetch(config.adminId);
    store.ensureUser(administrator.id, administrator.user.username);
    engine = new MusicEngine(guild, config.voice, media, config.ffmpeg);
    for (const state of guild.voiceStates.cache.values()) {
      if (state.channelId && state.id !== client.user?.id) {
        store.rememberVoice(state.id, state.channelId);
      }
    }
    void removeOldControlMessage(guild);
    if (config.webSessionSecret) {
      webServer = startWeb({ engine, media, store, host: config.webHost, port: config.webPort,
        adminId: config.adminId,
        clientId: config.clientId, clientSecret: config.clientSecret,
        publicUrl: config.webPublicUrl || `http://127.0.0.1:${config.webPort}`, sessionSecret: config.webSessionSecret,
        isGuildMember: userId => isGuildMember(guild, userId),
        joinMe: userId => webUserVoiceChannel(guild, userId),
        playTarget: userId => webUserVoiceChannel(guild, userId, true) });
      console.log(`网页控制：http://${config.webHost}:${config.webPort}`);
      if (!config.clientSecret) console.warn('DISCORD_CLIENT_SECRET 未配置，网页暂不能使用 Discord 登录。');
    } else console.warn('WEB_SESSION_SECRET 未配置，网页控制未启动。');
    console.log(`Bot 已上线：${client.user?.tag}`);
  } catch (err) { console.error('启动配置失败：', err); process.exitCode = 1; client.destroy(); }
});
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (!engine) { await i.reply({ content: 'Bot 正在启动，请稍后重试。', ephemeral: true }).catch(console.error); return; }
  if (i.guildId !== config.guild) { await i.reply({ content: '请在已配置的服务器内使用此命令。', ephemeral: true }).catch(console.error); return; }
  try {
    await i.deferReply({ ephemeral: true });
    let response = '';
    switch (i.commandName) {
      case 'join': { const channelId = await userVoiceChannel(i, false); await engine.join(channelId); response = `已加入 <#${channelId}>。`; break; }
      case 'play': {
        const video = parseMediaInput(i.options.getString('video', true));
        const [track, channelId] = await Promise.all([
          media.resolve(video.url, i.user.username),
          userVoiceChannel(i, true).then(async id => { await engine.join(id); return id; }),
        ]);
        const count = engine.enqueue(track);
        response = `已加入：${track.title}${count ? `（前面还有 ${count} 首）` : ''} · <#${channelId}>`;
        break;
      }
      case 'pause': response = engine.status === 'playing' ? `状态：${engine.togglePause()}` : '当前无法暂停。'; break;
      case 'resume': response = engine.status === 'paused' ? `状态：${engine.togglePause()}` : '当前没有暂停。'; break;
      case 'skip': response = engine.skip() ? '已跳到下一首。' : '当前没有歌曲。'; break;
      case 'previous': response = engine.previous() ? '已返回上一首。' : '没有上一首。'; break;
      case 'stop': engine.stop(); response = '已停止并清空队列。'; break;
      case 'shuffle': engine.queue.shuffle(); response = '已打乱待播歌曲。'; break;
      case 'repeat': response = `循环模式：${repeatLabel[engine.queue.cycleRepeat()]}`; break;
      case 'queue': response = queueText().slice(0, 1900); break;
      case 'nowplaying': response = engine.queue.current ? `${engine.queue.current.title}\n${engine.queue.current.url}\n状态：${playerLabel[engine.status]}` : '当前没有歌曲。'; break;
      case 'diagnostics': response = await diagnostics(); break;
      case 'playlist': response = await playlistCommand(i); break;
    }
    await i.editReply(response || '已完成。');
  } catch (err) {
    console.error('交互失败：', err);
    const message = `操作失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 1800);
    if (i.deferred || i.replied) await i.followUp({ content: message, ephemeral: true }).catch(console.error);
    else await i.reply({ content: message, ephemeral: true }).catch(console.error);
  }
});
client.on('voiceStateUpdate', (_oldState, newState) => {
  if (newState.guild.id === config.guild && newState.channelId && newState.id !== client.user?.id) {
    try { store.rememberVoice(newState.id, newState.channelId); }
    catch (err) { console.error('保存用户上次语音频道失败：', err); }
  }
});
client.on('error', err => console.error('Discord 错误：', err));
const shutdown = () => { engine?.stop(); webServer?.close(); store.close(); client.destroy(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
await client.login(config.token);
