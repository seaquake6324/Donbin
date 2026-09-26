import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MusicEngine } from './engine.js';
import { parseMediaInput, type MediaResolver } from './media.js';
import type { PlaylistStore } from './playlists.js';

const page = readFileSync(new URL('../public/index.html', import.meta.url));
type WebIdentity = { id: string; username: string; avatarUrl?: string };
type WebOptions = { engine: MusicEngine; media: MediaResolver; store: PlaylistStore; host: string; port: number;
  clientId: string; clientSecret?: string; publicUrl: string; sessionSecret: string; adminId: string;
  isGuildMember: (userId: string) => Promise<boolean>; joinMe: (userId: string) => Promise<string>; playTarget: (userId: string) => Promise<string>;
  discordFetch?: typeof fetch };

export function startWeb(options: WebOptions) {
  const { engine, media, store, host, port } = options;
  if (options.sessionSecret.length < 32) throw new Error('WEB_SESSION_SECRET 至少需要 32 个字符。');
  const publicUrl = new URL(options.publicUrl);
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(publicUrl.hostname))) throw new Error('WEB_PUBLIC_URL 必须是 HTTPS 地址；本机可用 HTTP localhost。');
  const redirectUri = new URL('/auth/discord/callback', publicUrl).toString();
  const secure = publicUrl.protocol === 'https:' ? '; Secure' : '';
  const httpFetch = options.discordFetch ?? fetch;
  const sessionName = 'music_session';
  const stateName = 'music_oauth_state';
  const pending = new Map<string, { code: string; at: number }>();
  const registrationFailures = new Map<string, { count: number; at: number }>();
  const cookie = (req: IncomingMessage, name: string): string | null => {
    const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
    return item ? item.slice(name.length + 1) : null;
  };
  const sign = (payload: string): string => createHmac('sha256', options.sessionSecret).update(payload).digest('base64url');
  const sessionCookie = (identity: WebIdentity): string => {
    const payload = Buffer.from(JSON.stringify({ ...identity, version: 2, exp: Date.now() + 7 * 86400_000 })).toString('base64url');
    return `${sessionName}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`;
  };
  const clearCookie = (name: string, path = '/'): string => `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const identityFrom = (req: IncomingMessage): WebIdentity | null => {
    const value = cookie(req, sessionName);
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 2) return null;
    const actual = Buffer.from(parts[1]); const expected = Buffer.from(sign(parts[0]));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as WebIdentity & { version: number; exp: number };
      return data.version === 2 && /^\d{17,22}$/.test(data.id) && typeof data.username === 'string' && data.username.length <= 100 && Number.isFinite(data.exp) && data.exp > Date.now() ? { id: data.id, username: data.username, avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : undefined } : null;
    } catch { return null; }
  };
  const memberCache = new Map<string, { value: boolean; at: number }>();
  const isMember = async (id: string): Promise<boolean> => {
    const cached = memberCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = await options.isGuildMember(id);
    memberCache.set(id, { value, at: Date.now() });
    return value;
  };
  const respond = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(data));
  };
  const redirect = (res: ServerResponse, location: string, cookies?: string | string[]): void => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...(cookies ? { 'Set-Cookie': cookies } : {}) }); res.end();
  };
  const authError = (res: ServerResponse, message: string): void => redirect(res, `/?authError=${encodeURIComponent(message)}`, clearCookie(stateName, '/auth/discord/callback'));
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      const path = requestUrl.pathname;
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
        res.end(page); return;
      }
      if ((req.method === 'GET' && path === '/auth/discord') || (req.method === 'POST' && path === '/auth/discord/start')) {
        if (!options.clientSecret || !options.clientId) { authError(res, '请先在 .env 配置 DISCORD_CLIENT_ID 和 DISCORD_CLIENT_SECRET 并重启 Bot。'); return; }
        let inviteCode = '';
        if (req.method === 'POST') {
          if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host && new URL(req.headers.origin).host !== publicUrl.host) { respond(res,403,{ error:'Origin 不匹配。' }); return; }
          if (!req.headers['content-type']?.startsWith('application/json')) { respond(res,415,{ error:'需要 JSON。' }); return; }
          let body = ''; for await (const chunk of req) { body += chunk.toString(); if (body.length > 2048) { respond(res,413,{ error:'请求过大。' }); return; } }
          inviteCode = String((JSON.parse(body) as { inviteCode?: string }).inviteCode || '').trim();
        }
        const state = randomBytes(24).toString('base64url');
        for (const [key, value] of pending) if (Date.now() - value.at > 600_000) pending.delete(key);
        if (pending.size >= 1000) { respond(res,429,{ error:'登录请求太多，请稍后重试。' }); return; }
        pending.set(state, { code: inviteCode, at: Date.now() });
        const target = new URL('https://discord.com/oauth2/authorize');
        target.search = new URLSearchParams({ response_type: 'code', client_id: options.clientId, scope: 'identify', state, redirect_uri: redirectUri }).toString();
        const stateCookie = `${stateName}=${state}; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
        if (req.method === 'POST') { res.setHeader('Set-Cookie', stateCookie); respond(res,200,{ url:target.toString() }); }
        else redirect(res,target.toString(),stateCookie);
        return;
      }
      if (req.method === 'GET' && path === '/auth/discord/callback') {
        const state = requestUrl.searchParams.get('state'); const expectedState = cookie(req, stateName);
        if (!state || !expectedState || state.length !== expectedState.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) { authError(res, 'Discord 登录状态已过期，请重试。'); return; }
        const registration = pending.get(state); pending.delete(state);
        if (!registration || Date.now() - registration.at > 600_000) { authError(res,'Discord 登录状态已过期，请重试。'); return; }
        if (requestUrl.searchParams.has('error')) { authError(res, '你取消了 Discord 授权。'); return; }
        const code = requestUrl.searchParams.get('code');
        if (!code || !options.clientSecret) { authError(res, 'Discord 未返回授权码，请重试。'); return; }
        try {
          const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: options.clientId, client_secret: options.clientSecret });
          const tokenResponse = await httpFetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
          if (!tokenResponse.ok) { authError(res, 'Discord 授权码交换失败，请检查 Client Secret 和回调地址。'); return; }
          const token = await tokenResponse.json() as { access_token?: string };
          if (!token.access_token) { authError(res, 'Discord 未返回访问令牌，请重试。'); return; }
          const userResponse = await httpFetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15_000) });
          if (!userResponse.ok) { authError(res, 'Discord 用户信息获取失败，请重试。'); return; }
          const user = await userResponse.json() as { id?: string; username?: string; global_name?: string; avatar?: string | null; discriminator?: string };
          if (!user.id || !/^\d{17,22}$/.test(user.id) || !user.username) { authError(res, 'Discord 用户信息无效。'); return; }
          if (!await isMember(user.id)) { authError(res, '只有指定 Discord 服务器的成员可以使用此网页。'); return; }
          const failures=registrationFailures.get(user.id);
          if (failures && Date.now()-failures.at<900_000 && failures.count>=5) { authError(res,'邀请码尝试过多，请 15 分钟后再试。'); return; }
          try { store.registerWebUser(user.id,user.global_name || user.username,registration.code); registrationFailures.delete(user.id); }
          catch (error) { registrationFailures.set(user.id,{ count:(failures && Date.now()-failures.at<900_000 ? failures.count : 0)+1,at:Date.now() }); authError(res,error instanceof Error ? error.message : '注册失败。'); return; }
          const defaultIndex = user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number((BigInt(user.id) >> 22n) % 6n);
          const avatarUrl = user.avatar && /^[a-f0-9_]{8,64}$/.test(user.avatar) ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128` : `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
          redirect(res, '/', [sessionCookie({ id: user.id, username: user.global_name || user.username, avatarUrl }), clearCookie(stateName, '/auth/discord/callback')]); return;
        } catch { authError(res, 'Discord 登录暂时失败，请检查网络后重试。'); return; }
      }
      if (req.method === 'GET' && path === '/auth/logout') { redirect(res, '/', clearCookie(sessionName)); return; }
      const currentUser = identityFrom(req);
      if (!currentUser || !await isMember(currentUser.id) || !store.isWebRegistered(currentUser.id)) { respond(res, 401, { error: '请先使用 Discord 登录。' }); return; }
      if (req.method === 'GET' && path === '/api/state') {
        const voice = engine.voiceStatus();
        respond(res, 200, { currentUser: { ...currentUser, isAdmin: currentUser.id === options.adminId }, status: engine.status, voice, voiceConnected: voice === 'ready', voiceChannelId: engine.currentVoiceChannelId(), current: engine.queue.current, upcoming: engine.queue.upcoming, playlistName: engine.queue.playlistName, repeat: engine.queue.repeat, lastError: engine.lastError, playlists: store.list(currentUser.id), unreadCount: store.unreadCount(currentUser.id), positionSeconds: engine.positionSeconds(), durationSeconds: engine.queue.current?.duration == null ? null : Math.round(engine.queue.current.duration) }); return;
      }
      if (req.method === 'GET' && path === '/api/playlist') {
        const ref = requestUrl.searchParams.get('id') || requestUrl.searchParams.get('name') || '';
        const info = store.info(currentUser.id,ref.startsWith('#') ? ref : /^\d+$/.test(ref) ? `#${ref}` : ref);
        respond(res, 200, { info, songs: store.songs(currentUser.id,info.id), recipients: info.permission === 'owner' ? store.recipients(currentUser.id,info.id) : [] }); return;
      }
      if (req.method === 'GET' && path === '/api/members') { respond(res,200,{ members:store.members(currentUser.id) }); return; }
      if (req.method === 'GET' && path === '/api/notices') { respond(res,200,{ notices:store.notices(currentUser.id) }); return; }
      if (req.method === 'GET' && path === '/api/invites') { if (currentUser.id !== options.adminId) { respond(res,403,{ error:'只有管理员可查看邀请码。' }); return; } respond(res,200,{ invites:store.invites() }); return; }
      if (req.method !== 'POST' || path !== '/api/action') { respond(res, 404, { error: 'Not found' }); return; }
      const origin = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') { respond(res, 403, { error: '跨站请求已拒绝。' }); return; }
      if (!fetchSite && origin && new URL(origin).host !== publicUrl.host && new URL(origin).host !== req.headers.host && new URL(origin).host !== req.headers['x-forwarded-host']) { respond(res, 403, { error: 'Origin 不匹配。' }); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { respond(res, 415, { error: '需要 JSON。' }); return; }
      let body = '';
      for await (const chunk of req) { body += chunk.toString(); if (body.length > 64_000) { respond(res, 413, { error: '请求过大。' }); return; } }
      const input = JSON.parse(body) as { action?: string; name?: string; video?: string; position?: number; seconds?: number; playlistId?: number; recipientId?: string; permission?: string; visibility?: string; code?: string; maxUses?: number; days?: number; inviteId?: string };
      const playlistRef = input.playlistId && Number.isSafeInteger(input.playlistId) && input.playlistId > 0 ? input.playlistId : input.name || '';
      let message = '已完成。';
      switch (input.action) {
        case 'play': {
          const video = parseMediaInput(input.video || '');
          const [track] = await Promise.all([media.resolve(video.url), options.playTarget(currentUser.id)]);
          engine.enqueue(track);
          message = `已加入：${track.title}`;
          break;
        }
        case 'joinDefault': await engine.joinDefault(); message = '已加入默认语音频道。'; break;
        case 'joinMe': {
          const channelId = await options.joinMe(currentUser.id);
          message = `已加入语音频道 ${channelId}。`;
          break;
        }
        case 'seek': message = `已跳转到 ${engine.seek(input.seconds as number)} 秒。`; break;
        case 'pause': {
          const status = engine.togglePause();
          if (status !== 'paused' && status !== 'playing') throw new Error('当前没有可暂停或继续的歌曲。');
          message = status === 'paused' ? '已暂停。' : '已继续播放。'; break;
        }
        case 'skip': if (!engine.skip()) throw new Error('当前没有歌曲。'); message = '已跳到下一首。'; break;
        case 'previous': if (!engine.previous()) throw new Error('没有上一首。'); message = '已返回上一首。'; break;
        case 'stop': engine.stop(); message = '已停止播放并清空队列。'; break;
        case 'shuffle': engine.queue.shuffle(); message = '已打乱待播顺序。'; break;
        case 'repeat': {
          const mode = engine.queue.cycleRepeat();
          message = `循环模式：${mode === 'off' ? '关闭' : mode === 'one' ? '单曲循环' : '队列循环'}。`; break;
        }
        case 'playlistPlay': {
          const info = store.info(currentUser.id,playlistRef);
          const songs = store.songs(currentUser.id,info.id);
          if (!songs.length) throw new Error('歌单不存在或为空。');
          await options.playTarget(currentUser.id); engine.replace(songs, info.name); break;
        }
        case 'playlistCreate': store.create(currentUser.id,input.name || ''); message='已创建歌单。'; break;
        case 'playlistDelete': store.delete(currentUser.id,playlistRef); message='已删除歌单。'; break;
        case 'playlistAdd': {
          if (store.info(currentUser.id,playlistRef).permission === 'viewer') throw new Error('只有歌单创建者或共同编辑者能添加歌曲。');
          const track = await media.resolve(input.video || ''); store.add(currentUser.id,playlistRef,track); message='已添加歌曲。'; break;
        }
        case 'playlistRemove': if (!Number.isInteger(input.position) || input.position! < 1 || !store.remove(currentUser.id,playlistRef,input.position!)) throw new Error('歌曲序号不存在。'); message='已移除歌曲。'; break;
        case 'playlistVisibility': store.setVisibility(currentUser.id,playlistRef,input.visibility || ''); message=input.visibility === 'public' ? '歌单已公开。' : '歌单已隐藏。'; break;
        case 'playlistShare': store.share(currentUser.id,playlistRef,input.recipientId || '',input.permission || ''); message='分享设置已保存，并已通知对方。'; break;
        case 'playlistUnshare': if (!store.unshare(currentUser.id,playlistRef,input.recipientId || '')) throw new Error('没有找到该分享。'); message='已取消分享并通知对方。'; break;
        case 'noticesRead': store.markNoticesRead(currentUser.id); message='消息已标为已读。'; break;
        case 'inviteCreate': {
          if (currentUser.id !== options.adminId) throw new Error('只有管理员可创建邀请码。');
          const created=store.createInvite(input.code,input.maxUses ?? 1,input.days ?? 7);
          respond(res,200,{ message:'邀请码已创建。', code:created.code, invite:created.summary }); return;
        }
        case 'inviteRevoke': {
          if (currentUser.id !== options.adminId) throw new Error('只有管理员可撤销邀请码。');
          if (!store.revokeInvite(input.inviteId || '')) throw new Error('邀请码不存在或已撤销。');
          message='邀请码已撤销。'; break;
        }
        default: throw new Error('未知操作。');
      }
      respond(res, 200, { message });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(res, 400, { error: message.slice(0, 500) });
    }
  });
  server.listen(port, host);
  server.on('error', err => console.error('网页控制服务失败：', err));
  return server;
}
