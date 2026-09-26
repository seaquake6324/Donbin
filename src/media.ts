import { spawn } from 'node:child_process';

export type MediaSource = 'bilibili' | 'youtube';
export type Track = { source: MediaSource; id: string; title: string; duration: number | null; url: string; requestedBy?: string };
export type StreamInfo = { url: string; headers: Record<string, string> };
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
  constructor(private readonly binary: string, private readonly cookies?: string) {}
  private args(): string[] { return this.cookies ? ['--cookies', this.cookies] : []; }
  private extractArgs(url: string): string[] { return ['--no-playlist', '--skip-download', '--no-warnings', '--js-runtimes', `node:${process.execPath}`, '-f', 'bestaudio/best', '-J', ...this.args(), url]; }
  private key(track: Pick<Track, 'source' | 'id'>): string { return `${track.source}:${track.id}`; }
  private remember(key: string, stream: StreamInfo): void {
    this.recent.set(key, { stream, at: Date.now() });
    if (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
  }
  private streamFrom(data: MediaData): StreamInfo | null {
    const selected = data.requested_formats?.find(x => x.url) ?? data;
    if (!selected.url || !/^https?:\/\//.test(selected.url)) return null;
    return { url: selected.url, headers: selected.http_headers ?? {} };
  }
  async resolve(input: string, requestedBy?: string): Promise<Track> {
    const media = parseMediaInput(input);
    const raw = await runProcess(this.binary, this.extractArgs(media.url), 45_000);
    const data = JSON.parse(raw) as MediaData;
    if (!data.title) throw new Error('视频平台没有返回标题。');
    const stream = this.streamFrom(data);
    if (stream) this.remember(this.key(media), stream);
    const duration = typeof data.duration === 'number' && Number.isFinite(data.duration) ? Math.round(data.duration) : null;
    return { ...media, title: data.title.slice(0, 250), duration, requestedBy };
  }
  async stream(track: Track): Promise<StreamInfo> {
    const key = this.key(track);
    const cached = this.recent.get(key);
    this.recent.delete(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.stream;
    const raw = await runProcess(this.binary, this.extractArgs(track.url), 45_000);
    const info = this.streamFrom(JSON.parse(raw) as MediaData);
    if (!info) throw new Error('无法取得有效音频 URL。');
    return info;
  }
  async prefetch(track: Track, signal?: AbortSignal): Promise<void> {
    const key = this.key(track);
    const cached = this.recent.get(key);
    if (cached && Date.now() - cached.at < 45_000) return;
    const raw = await runProcess(this.binary, this.extractArgs(track.url), 45_000, 4_000_000, signal);
    if (signal?.aborted) return;
    const info = this.streamFrom(JSON.parse(raw) as MediaData);
    if (info) this.remember(key, info);
  }
  async check(): Promise<string> { return (await runProcess(this.binary, ['--version'], 5_000, 1000)).trim(); }
}
