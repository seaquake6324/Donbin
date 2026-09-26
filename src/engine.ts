import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel, AudioPlayerStatus, VoiceConnectionStatus, StreamType, type AudioPlayer, type VoiceConnection } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import { MusicQueue } from './queue.js';
import { MediaResolver, type Track } from './media.js';

export type PlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';
export class MusicEngine {
  readonly queue = new MusicQueue();
  readonly player: AudioPlayer = createAudioPlayer();
  status: PlayStatus = 'idle';
  lastError: string | null = null;
  private connection: VoiceConnection | null = null;
  private ffmpeg: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private pcmBuffer: PassThrough | null = null;
  private activeResource: { playbackDuration: number } | null = null;
  private positionOffset = 0;
  private pauseAfterSeek = false;
  private generation = 0;
  private prefetchTimer: NodeJS.Timeout | null = null;
  private prefetched = new Set<string>();
  private prefetchAbort = new Set<AbortController>();
  private targetChannelId: string;
  private joinTail: Promise<void> = Promise.resolve();
  private onChange: () => void = () => {};
  constructor(private guild: Guild, private voiceChannelId: string, private resolver: MediaResolver, private ffmpegPath: string) {
    this.targetChannelId = voiceChannelId;
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && this.pauseAfterSeek && newState.resource.metadata === this.generation) {
        if (this.player.pause()) { this.pauseAfterSeek = false; this.status = 'paused'; this.notify(); }
      }
      if (newState.status !== AudioPlayerStatus.Idle || oldState.status === AudioPlayerStatus.Idle) return;
      const oldToken = (oldState as { resource?: { metadata?: number } }).resource?.metadata;
      if (oldToken === this.generation && this.queue.current) this.advance('ended');
    });
    this.player.on('error', err => { if (err.resource.metadata === this.generation) this.fail(err.message); });
  }
  changed(callback: () => void): void { this.onChange = callback; }
  private notify(): void { this.onChange(); }
  private stopTransport(): void {
    this.generation++;
    if (this.prefetchTimer) { clearInterval(this.prefetchTimer); this.prefetchTimer = null; }
    for (const controller of this.prefetchAbort) controller.abort();
    this.prefetchAbort.clear();
    this.prefetched.clear();
    this.player.stop(true);
    this.activeResource = null;
    this.positionOffset = 0;
    this.pauseAfterSeek = false;
    if (this.pcmBuffer) { this.pcmBuffer.destroy(); this.pcmBuffer = null; }
    if (this.ffmpeg) { this.ffmpeg.stdout.destroy(); this.ffmpeg.stderr.destroy(); this.ffmpeg.kill(); this.ffmpeg = null; }
  }
  private async connect(channelId: string): Promise<VoiceConnection> {
    const existing = getVoiceConnection(this.guild.id);
    const connection = existing ?? joinVoiceChannel({ channelId, guildId: this.guild.id, adapterCreator: this.guild.voiceAdapterCreator, selfDeaf: true });
    if (connection.joinConfig.channelId !== channelId) connection.rejoin({ channelId, selfDeaf: true, selfMute: false });
    if (this.connection !== connection) {
      connection.on('error', err => { this.lastError = `Voice: ${err.message}`; this.notify(); });
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (this.connection !== connection) return;
        try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]); }
        catch {
          if (this.connection === connection) { this.lastError = 'Voice 连接断开，播放已停止。'; this.stop(); }
        }
      });
    }
    this.connection = connection;
    connection.subscribe(this.player);
    if (connection.state.status !== VoiceConnectionStatus.Ready) await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    return connection;
  }
  join(channelId: string): Promise<void> {
    const task = this.joinTail.then(() => this.joinOnce(channelId));
    this.joinTail = task.catch(() => {});
    return task;
  }
  private async joinOnce(channelId: string): Promise<void> {
    const previous = this.targetChannelId;
    this.targetChannelId = channelId;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.connect(channelId); this.lastError = null; this.notify(); return; }
      catch (err) {
        if (this.connection?.joinConfig.channelId === channelId && this.connection.state.status !== VoiceConnectionStatus.Ready) {
          this.connection.destroy(); this.connection = null;
        }
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 700)); continue; }
        this.targetChannelId = previous;
        this.lastError = `Voice: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
        this.notify();
        throw err;
      }
    }
  }
  async joinDefault(): Promise<void> { await this.join(this.voiceChannelId); }
  enqueue(track: Track): number {
    const start = this.queue.enqueue(track);
    if (start) void this.startCurrent(); else this.notify();
    return this.queue.upcoming.length;
  }
  replace(tracks: Track[], name: string | null): void {
    this.stopTransport();
    this.queue.replace(tracks, name);
    if (this.queue.current) void this.startCurrent();
    else { this.status = 'idle'; this.notify(); }
  }
  private async startCurrent(seekSeconds = 0, remainPaused = false): Promise<void> {
    const track = this.queue.current;
    if (!track) { this.status = 'idle'; this.notify(); return; }
    this.stopTransport();
    const token = this.generation;
    this.positionOffset = seekSeconds;
    this.pauseAfterSeek = remainPaused;
    this.status = 'loading'; this.notify();
    try {
      await this.joinTail;
      if (token !== this.generation) return;
      const connection = await this.connect(this.targetChannelId);
      if (token !== this.generation) return;
      const stream = await this.resolver.stream(track);
      if (token !== this.generation) return;
      const headers = { 'User-Agent': 'Mozilla/5.0', ...(track.source === 'bilibili' ? { Referer: 'https://www.bilibili.com/' } : {}), ...stream.headers };
      const headerArg = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      const ffmpeg = spawn(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-headers', headerArg, ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []), '-i', stream.url, '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (token !== this.generation) { ffmpeg.kill(); return; }
      this.ffmpeg = ffmpeg;
      let stderr = '';
      ffmpeg.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1200); });
      ffmpeg.on('error', err => { if (token === this.generation) this.fail(err.message); });
      ffmpeg.on('close', code => { if (token === this.generation && code !== 0) this.fail(stderr || `FFmpeg 退出 ${code}`); });
      const pcmBuffer = new PassThrough({ highWaterMark: 768_000 });
      this.pcmBuffer = pcmBuffer;
      ffmpeg.stdout.pipe(pcmBuffer);
      await this.waitForPcm(pcmBuffer, ffmpeg, 192_000, 15_000);
      if (token !== this.generation) return;
      const resource = createAudioResource(pcmBuffer, { inputType: StreamType.Raw, metadata: token });
      this.activeResource = resource;
      connection.subscribe(this.player);
      this.player.play(resource);
      if (this.pauseAfterSeek && this.player.pause()) this.pauseAfterSeek = false;
      this.status = remainPaused ? (this.pauseAfterSeek ? 'loading' : 'paused') : 'playing';
      this.lastError = null; this.notify();
      this.prefetchTimer = setInterval(() => this.prefetchNext(token), 2_000);
      this.prefetchTimer.unref();
      this.prefetchNext(token);
    } catch (err) { if (token === this.generation) this.fail(err instanceof Error ? err.message : String(err)); }
  }
  private prefetchNext(token: number): void {
    if (token !== this.generation || this.status !== 'playing') return;
    const current = this.queue.current;
    if (!current || current.duration == null || current.duration - this.positionSeconds() > 30) return;
    const next = this.queue.repeat === 'one' ? current : this.queue.upcoming[0] ?? (this.queue.repeat === 'queue' ? current : null);
    if (!next) return;
    const key = `${next.source}:${next.id}`;
    if (this.prefetched.has(key)) return;
    this.prefetched.add(key);
    const controller = new AbortController();
    this.prefetchAbort.add(controller);
    void this.resolver.prefetch(next, controller.signal).catch(() => { /* Playback retries extraction with a fresh URL. */ }).finally(() => this.prefetchAbort.delete(controller));
  }
  private async waitForPcm(stream: PassThrough, ffmpeg: ChildProcessByStdio<null, Readable, Readable>, bytes: number, timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (stream.readableLength < bytes) {
      if (stream.destroyed) throw new Error('音频缓冲已取消。');
      if (ffmpeg.exitCode !== null || stream.readableEnded) {
        if (stream.readableLength > 0) return;
        throw new Error('FFmpeg 没有产生音频数据。');
      }
      if (Date.now() - started > timeoutMs) throw new Error('音频缓冲超时，请检查网络。');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  private fail(message: string): void {
    this.lastError = message.replace(/https?:\/\/\S+/gi, '[URL]').replace(/(?:Cookie|Authorization):[^\r\n]*/gi, '[redacted header]').slice(0, 500);
    this.advance('failed');
  }
  private advance(reason: 'ended' | 'skip' | 'failed'): void {
    this.stopTransport();
    const next = this.queue.advance(reason);
    if (next) void this.startCurrent();
    else { this.status = reason === 'failed' ? 'error' : 'idle'; this.notify(); }
  }
  skip(): boolean { if (!this.queue.current) return false; this.advance('skip'); return true; }
  seek(seconds: number): number {
    if (!this.queue.current) throw new Error('当前没有歌曲。');
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0) throw new Error('进度须为非负整数秒。');
    const duration = this.queue.current.duration;
    if (duration != null && seconds >= Math.ceil(duration)) throw new Error('进度超出了歌曲时长。');
    if (seconds > 12 * 60 * 60) throw new Error('进度不能超过 12 小时。');
    void this.startCurrent(seconds, this.status === 'paused');
    return seconds;
  }
  positionSeconds(): number {
    const value = this.positionOffset + Math.floor((this.activeResource?.playbackDuration ?? 0) / 1000);
    const duration = this.queue.current?.duration;
    return Math.max(0, duration == null ? value : Math.min(Math.round(duration), value));
  }
  previous(): boolean { if (!this.queue.history.length) return false; this.stopTransport(); this.queue.previous(); void this.startCurrent(); return true; }
  togglePause(): PlayStatus {
    if (this.status === 'playing' && this.player.pause()) this.status = 'paused';
    else if (this.status === 'paused' && this.player.unpause()) this.status = 'playing';
    this.notify(); return this.status;
  }
  stop(): void { this.stopTransport(); this.queue.clear(); this.status = 'idle'; this.targetChannelId = this.voiceChannelId; this.connection?.destroy(); this.connection = null; this.notify(); }
  voiceStatus(): string { return (this.connection ?? getVoiceConnection(this.guild.id))?.state.status ?? 'disconnected'; }
  currentVoiceChannelId(): string | null { return (this.connection ?? getVoiceConnection(this.guild.id))?.joinConfig.channelId ?? null; }
  async ffmpegVersion(): Promise<string> {
    const { runProcess } = await import('./media.js');
    return (await runProcess(this.ffmpegPath, ['-version'], 5_000, 3000)).split('\n')[0];
  }
}
