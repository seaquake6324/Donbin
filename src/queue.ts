import type { Track } from './media.js';

export type RepeatMode = 'off' | 'one' | 'queue';
export class MusicQueue {
  current: Track | null = null;
  upcoming: Track[] = [];
  history: Track[] = [];
  repeat: RepeatMode = 'off';
  playlistName: string | null = null;

  enqueue(track: Track): boolean {
    if (!this.current) { this.current = track; return true; }
    this.upcoming.push(track); return false;
  }
  replace(tracks: Track[], name: string | null): Track | null {
    this.current = tracks[0] ?? null;
    this.upcoming = tracks.slice(1);
    this.history = [];
    this.playlistName = name;
    return this.current;
  }
  advance(reason: 'ended' | 'skip' | 'failed'): Track | null {
    const old = this.current;
    if (!old) return null;
    if (reason === 'ended' && this.repeat === 'one') return old;
    this.history.push(old);
    if (this.history.length > 100) this.history.shift();
    if (this.repeat === 'queue' && reason !== 'failed') this.upcoming.push(old);
    this.current = this.upcoming.shift() ?? null;
    return this.current;
  }
  previous(): Track | null {
    const prior = this.history.pop();
    if (!prior) return null;
    if (this.current) this.upcoming.unshift(this.current);
    this.current = prior;
    return prior;
  }
  shuffle(random = Math.random): void {
    for (let i = this.upcoming.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.upcoming[i], this.upcoming[j]] = [this.upcoming[j], this.upcoming[i]];
    }
  }
  cycleRepeat(): RepeatMode { this.repeat = this.repeat === 'off' ? 'one' : this.repeat === 'one' ? 'queue' : 'off'; return this.repeat; }
  clear(): void { this.current = null; this.upcoming = []; this.history = []; this.playlistName = null; }
}
