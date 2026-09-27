import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type MediaSource = 'bilibili' | 'youtube';
export type Track = { source: MediaSource; id: string; title: string; duration: number | null; url: string; requestedBy?: string };
export type StreamInfo = { url: string; headers: Record<string, string>; proxy?: string };
const BV = /^BV[0-9A-Za-z]{10}$/i;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
type MediaData = { title?: string; duration?: number; url?: string; http_headers?: Record<string, string>; requested_formats?: { url?: string; http_headers?: Record<string, string> }[] };

export function parseBilibili(input: string): string {
  const value = input.trim();
  if (BV.test(value)) return `BV${value.slice(2)}`;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入 BV 号或 bilibili.com/video 链接。'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅支持 HTTP(S) Bilibili 链接。');
  if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname.toLowerCase())) throw new Error('仅支持 bilibili.com/video 链接。');
  const match = /^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i.exec(url.pathname);
  if (!match) throw new Error('链接中找不到有效 BV 号。');
  return `BV${match[1].slice(2)}`;
}

export function videoUrl(bvid: string): string { return `https://www.bilibili.com/video/${bvid}`; }

export function mediaUrl(source: MediaSource, id: string): string {
  return source === 'bilibili' ? videoUrl(id) : `https://www.youtube.com/watch?v=${id}`;
}

export function parseMediaInput(input: string): Pick<Track, 'source' | 'id' | 'url'> {
  const value = input.trim();
  if (BV.test(value)) { const id = parseBilibili(value); return { source: 'bilibili', id, url: videoUrl(id) }; }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入 BV 号、Bilibili 视频链接或 YouTube 视频链接。'); }
  const host = url.hostname.toLowerCase();
  if (['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(host)) {
    const id = parseBilibili(value); return { source: 'bilibili', id, url: videoUrl(id) };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅支持 HTTP(S) 视频链接。');
  let id: string | null = null;
  if (host === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !YOUTUBE_ID.test(id)) throw new Error('仅支持单个 YouTube 视频链接（watch、youtu.be、shorts、live）。');
  return { source: 'youtube', id, url: mediaUrl('youtube', id) };
}

export async function runProcess(command: string, args: string[], timeoutMs = 30_000, maxOutput = 4_000_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '', error = '', done = false;
    const finish = (failure?: Error) => { if (done) return; done = true; clearTimeout(timer); failure ? reject(failure) : resolve(output); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} 超时`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > maxOutput) { child.kill(); finish(new Error(`${command} 输出过大`)); } });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-3000); });
    child.on('error', err => finish(err));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`${command} 退出 ${code}: ${error}`)));
  });
}

export class MediaResolver {
  private recent = new Map<string, { stream: StreamInfo; at: number }>();
  private readonly bilibiliProxy?: string;
  private readonly youtubeProxy?: string;
  constructor(private readonly binary: string, private readonly cookies?: string, private readonly bilibiliConfig?: string, private readonly youtubeConfig?: string) {
    if (bilibiliConfig) this.bilibiliProxy = this.proxyFromConfig(bilibiliConfig);
    if (youtubeConfig) {
      this.youtubeProxy = this.proxyFromConfig(youtubeConfig);
      if (!this.youtubeProxy) throw new Error('YouTube 备用 yt-dlp 配置需要单独一行 --proxy http://...');
    }
  }
  private proxyFromConfig(path: string): string | undefined {
    const match = /^\s*--proxy\s+(https?:\/\/\S+)\s*$/m.exec(readFileSync(path, 'utf8'));
    return match?.[1];
  }
  private args(): string[] { return this.cookies ? ['--cookies', this.cookies] : []; }
  private extractArgs(source: MediaSource, url: string, config?: string, proxyOverride?: string): string[] {
    return ['--no-playlist', '--skip-download', '--no-warnings', '--socket-timeout', '15', '--js-runtimes', `node:${process.execPath}`, '-f', 'bestaudio/best', '-J', ...this.args(), ...(config ? ['--config-locations', config] : []), ...(proxyOverride ? ['--proxy', proxyOverride] : []), url];
  }
  private async retryRotated(source: MediaSource, url: string, config: string, proxy: string, signal?: AbortSignal): Promise<{ raw: string; proxy: string }> {
    const rotated = proxy.replace(/_session-[A-Za-z0-9]{8}(?=_|@)/, `_session-${randomBytes(4).toString('hex')}`);
    if (rotated === proxy) throw new Error('代理请求失败，且当前代理配置不支持自动切换会话。');
    const raw = await runProcess(this.binary, this.extractArgs(source, url, config, rotated), 45_000, 4_000_000, signal);
    return { raw, proxy: rotated };
  }
  private shouldRotate(error: unknown): boolean { return /(?:ProxyError|504 Gateway Timeout|HTTP Error 412|超时)/i.test(String(error)); }
  private async extract(source: MediaSource, url: string, signal?: AbortSignal): Promise<{ data: MediaData; proxy?: string }> {
    const primaryConfig = source === 'bilibili' ? this.bilibiliConfig : undefined;
    let raw: string;
    let proxy: string | undefined;
    try {
      raw = await runProcess(this.binary, this.extractArgs(source, url, primaryConfig), 45_000, 4_000_000, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (source === 'bilibili' && primaryConfig && this.bilibiliProxy && this.shouldRotate(error)) {
        ({ raw } = await this.retryRotated(source, url, primaryConfig, this.bilibiliProxy, signal));
      } else if (source === 'youtube' && this.youtubeConfig && this.youtubeProxy && /Sign in to confirm you.re not a bot/i.test(String(error))) {
        try {
          raw = await runProcess(this.binary, this.extractArgs(source, url, this.youtubeConfig), 45_000, 4_000_000, signal);
          proxy = this.youtubeProxy;
        } catch (proxyError) {
          if (signal?.aborted || !this.shouldRotate(proxyError)) throw proxyError;
          ({ raw, proxy } = await this.retryRotated(source, url, this.youtubeConfig, this.youtubeProxy, signal));
        }
      } else throw error;
    }
    return { data: JSON.parse(raw) as MediaData, proxy };
  }
  private key(track: Pick<Track, 'source' | 'id'>): string { return `${track.source}:${track.id}`; }
  private remember(key: string, stream: StreamInfo): void {
    this.recent.set(key, { stream, at: Date.now() });
    if (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
  }
  private streamFrom(data: MediaData, proxy?: string): StreamInfo | null {
    const selected = data.requested_formats?.find(x => x.url) ?? data;
    if (!selected.url || !/^https?:\/\//.test(selected.url)) return null;
    return { url: selected.url, headers: selected.http_headers ?? {}, ...(proxy ? { proxy } : {}) };
  }
  async resolve(input: string, requestedBy?: string): Promise<Track> {
    const media = parseMediaInput(input);
    const { data, proxy } = await this.extract(media.source, media.url);
    if (!data.title) throw new Error('视频平台没有返回标题。');
    const stream = this.streamFrom(data, proxy);
    if (stream) this.remember(this.key(media), stream);
    const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) ? Math.round(data.duration) : null;
    return { ...media, title: data.title.slice(0, 250), duration, requestedBy };
  }
  async stream(track: Track): Promise<StreamInfo> {
    const key = this.key(track);
    const cached = this.recent.get(key);
    this.recent.delete(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.stream;
    const { data, proxy } = await this.extract(track.source, track.url);
    const info = this.streamFrom(data, proxy);
    if (!info) throw new Error('无法取得有效音频 URL。');
    return info;
  }
  async prefetch(track: Track, signal?: AbortSignal): Promise<void> {
    const key = this.key(track);
    const cached = this.recent.get(key);
    if (cached && Date.now() - cached.at < 45_000) return;
    const { data, proxy } = await this.extract(track.source, track.url, signal);
    if (signal?.aborted) return;
    const info = this.streamFrom(data, proxy);
    if (info) this.remember(key, info);
  }
  async check(): Promise<string> { return (await runProcess(this.binary, ['--version'], 5_000, 1000)).trim(); }
}
