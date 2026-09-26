import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mediaUrl, type MediaSource, type Track } from './media.js';

type SongRow = { bvid: string; source: MediaSource; title: string; duration: number | null };
export type Permission = 'owner' | 'editor' | 'viewer';
export type PlaylistSummary = { id: number; name: string; ownerId: string; ownerName: string; visibility: 'public' | 'private'; permission: Permission };
export type Member = { id: string; username: string };
export type Share = Member & { permission: 'viewer' | 'editor' };
export type InviteSummary = { id: string; prefix: string; uses: number; maxUses: number; expiresAt: number; revoked: boolean };
export type Notice = { id: number; message: string; createdAt: number; read: boolean };

export class PlaylistStore {
  private db: DatabaseSync;
  constructor(path: string, private readonly adminId: string) {
    if (!/^\d{17,22}$/.test(adminId)) throw new Error('ADMIN_DISCORD_USER_ID 必须是 Discord 用户 ID。');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, web_registered INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS last_voice_channels (user_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL);');
    this.db.prepare('INSERT INTO users(id,username,web_registered) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET web_registered=1').run(adminId, '管理员');
    const exists = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='playlists'").get();
    if (!exists) this.createPlaylistTables();
    else {
      const columns = this.db.prepare('PRAGMA table_info(playlists)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'owner_id')) this.migrateLegacy();
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS playlist_shares (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, permission TEXT NOT NULL CHECK(permission IN ('viewer','editor')), PRIMARY KEY(playlist_id,user_id)); CREATE TABLE IF NOT EXISTS invite_codes (code_hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER); CREATE INDEX IF NOT EXISTS notices_by_user ON notices(user_id,id DESC);");
  }
  private createPlaylistTables(): void {
    this.db.exec("CREATE TABLE playlists (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL COLLATE NOCASE, visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')), UNIQUE(owner_id,name)); CREATE TABLE songs (id INTEGER PRIMARY KEY, playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, position INTEGER NOT NULL, bvid TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'bilibili', title TEXT NOT NULL, duration INTEGER); CREATE INDEX songs_by_playlist ON songs(playlist_id,position);");
  }
  private migrateLegacy(): void {
    const columns = this.db.prepare('PRAGMA table_info(songs)').all() as { name: string }[];
    const source = columns.some(column => column.name === 'source') ? 's.source' : "'bilibili'";
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      this.db.exec('ALTER TABLE playlists RENAME TO playlists_legacy; ALTER TABLE songs RENAME TO songs_legacy; DROP INDEX IF EXISTS songs_by_playlist;');
      this.createPlaylistTables();
      this.db.prepare('INSERT INTO playlists(owner_id,name) SELECT ?,name FROM playlists_legacy').run(this.adminId);
      this.db.prepare(`INSERT INTO songs(id,playlist_id,position,bvid,source,title,duration) SELECT s.id,p.id,s.position,s.bvid,${source},s.title,s.duration FROM songs_legacy s JOIN playlists p ON p.name=s.playlist_name COLLATE NOCASE AND p.owner_id=?`).run(this.adminId);
      this.db.exec('DROP TABLE songs_legacy; DROP TABLE playlists_legacy; COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
    finally { this.db.exec('PRAGMA foreign_keys=ON;'); }
  }
  close(): void { this.db.close(); }
  check(): boolean { return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1; }
  ensureUser(id: string, username: string): void {
    if (!/^\d{17,22}$/.test(id)) throw new Error('用户 ID 无效。');
    this.db.prepare('INSERT INTO users(id,username) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username').run(id, username.slice(0, 100));
  }
  isWebRegistered(id: string): boolean { return !!(this.db.prepare('SELECT web_registered FROM users WHERE id=?').get(id) as { web_registered: number } | undefined)?.web_registered; }
  registerWebUser(id: string, username: string, code: string): void {
    if (!/^\d{17,22}$/.test(id)) throw new Error('Discord 用户 ID 无效。');
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (id !== this.adminId && !this.isWebRegistered(id)) {
        const hash = this.hashCode(code);
        const changed = this.db.prepare('UPDATE invite_codes SET uses=uses+1 WHERE code_hash=? AND revoked=0 AND uses<max_uses AND expires_at>?').run(hash, Date.now()).changes;
        if (!changed) throw new Error('邀请码无效、已过期或已用完。');
      }
      this.db.prepare('INSERT INTO users(id,username,web_registered) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET username=excluded.username,web_registered=1').run(id, username.slice(0, 100));
      this.db.exec('COMMIT;');
    } catch (error) { this.db.exec('ROLLBACK;'); throw error; }
  }
  members(excludeId: string): Member[] { return this.db.prepare('SELECT id,username FROM users WHERE web_registered=1 AND id<>? ORDER BY username COLLATE NOCASE').all(excludeId) as Member[]; }
  private name(value: string): string {
    const name = value.trim();
    if (!name || name.length > 60 || /[\r\n]/.test(name)) throw new Error('歌单名称须为 1–60 个字符，不能包含换行。');
    return name;
  }
  private resolve(userId: string, ref: string | number, need: 'read' | 'edit' | 'owner' = 'read'): PlaylistSummary {
    const id = typeof ref === 'number' ? ref : /^#\d+$/.test(ref) ? Number(ref.slice(1)) : null;
    const where = id === null ? 'p.owner_id=? AND p.name=? COLLATE NOCASE' : 'p.id=?';
    const args = id === null ? [userId, ref] : [id];
    const row = this.db.prepare(`SELECT p.id,p.name,p.owner_id AS ownerId,u.username AS ownerName,p.visibility,sh.permission AS sharedPermission FROM playlists p JOIN users u ON u.id=p.owner_id LEFT JOIN playlist_shares sh ON sh.playlist_id=p.id AND sh.user_id=? WHERE ${where}`).get(userId, ...args) as (Omit<PlaylistSummary,'permission'> & { sharedPermission: 'viewer' | 'editor' | null }) | undefined;
    if (!row) throw new Error('歌单不存在或没有权限。');
    const permission: Permission | null = row.ownerId === userId ? 'owner' : row.sharedPermission ?? (row.visibility === 'public' ? 'viewer' : null);
    if (!permission || (need === 'owner' && permission !== 'owner') || (need === 'edit' && permission === 'viewer')) throw new Error('歌单不存在或没有权限。');
    return { id: row.id, name: row.name, ownerId: row.ownerId, ownerName: row.ownerName, visibility: row.visibility, permission };
  }
  list(userId: string): PlaylistSummary[] {
    const rows = this.db.prepare("SELECT p.id,p.name,p.owner_id AS ownerId,u.username AS ownerName,p.visibility,sh.permission AS sharedPermission FROM playlists p JOIN users u ON u.id=p.owner_id LEFT JOIN playlist_shares sh ON sh.playlist_id=p.id AND sh.user_id=? WHERE p.owner_id=? OR p.visibility='public' OR sh.user_id=? ORDER BY (p.owner_id=?) DESC,p.name COLLATE NOCASE,u.username COLLATE NOCASE").all(userId,userId,userId,userId) as (Omit<PlaylistSummary,'permission'> & { sharedPermission: 'viewer' | 'editor' | null })[];
    return rows.map(row => ({ id: row.id,name: row.name,ownerId: row.ownerId,ownerName: row.ownerName,visibility: row.visibility,permission: row.ownerId === userId ? 'owner' : row.sharedPermission ?? 'viewer' }));
  }
  info(userId: string, ref: string | number): PlaylistSummary { return this.resolve(userId, ref); }
  create(userId: string, name: string): PlaylistSummary {
    const valid=this.name(name);
    if (this.db.prepare('SELECT 1 FROM playlists WHERE owner_id=? AND name=? COLLATE NOCASE').get(userId,valid)) throw new Error('你已有同名歌单。');
    const result = this.db.prepare('INSERT INTO playlists(owner_id,name) VALUES (?,?)').run(userId,valid);
    return this.resolve(userId,Number(result.lastInsertRowid));
  }
  delete(userId: string, ref: string | number): boolean {
    const p = this.resolve(userId,ref,'owner');
    const recipients=this.recipients(userId,p.id);
    const changed=this.db.prepare('DELETE FROM playlists WHERE id=?').run(p.id).changes>0;
    if (changed) for (const recipient of recipients) this.notify(recipient.id,`歌单「${p.name}」已被创建者删除。`);
    return changed;
  }
  setVisibility(userId: string, ref: string | number, visibility: string): void {
    if (visibility !== 'public' && visibility !== 'private') throw new Error('公开状态无效。');
    const p = this.resolve(userId,ref,'owner');
    if (p.visibility === visibility) return;
    this.db.prepare('UPDATE playlists SET visibility=? WHERE id=?').run(visibility,p.id);
    const recipients = this.recipients(userId,p.id);
    for (const recipient of recipients) this.notify(recipient.id,`歌单「${p.name}」现在${visibility === 'public' ? '公开' : '隐藏'}。`);
  }
  add(userId: string, ref: string | number, track: Track): void {
    const p = this.resolve(userId,ref,'edit');
    this.db.prepare('INSERT INTO songs(playlist_id,position,bvid,source,title,duration) VALUES (?,(SELECT COALESCE(MAX(position),0)+1 FROM songs WHERE playlist_id=?),?,?,?,?)').run(p.id,p.id,track.id,track.source,track.title,track.duration);
  }
  remove(userId: string, ref: string | number, position: number): boolean {
    const p = this.resolve(userId,ref,'edit');
    const row = this.db.prepare('SELECT id FROM songs WHERE playlist_id=? ORDER BY position,id LIMIT 1 OFFSET ?').get(p.id,position-1) as { id: number } | undefined;
    return row ? this.db.prepare('DELETE FROM songs WHERE id=?').run(row.id).changes > 0 : false;
  }
  songs(userId: string, ref: string | number): Track[] {
    const p = this.resolve(userId,ref);
    return (this.db.prepare('SELECT bvid,source,title,duration FROM songs WHERE playlist_id=? ORDER BY position,id').all(p.id) as SongRow[]).map(x => ({ source:x.source,id:x.bvid,title:x.title,duration:x.duration,url:mediaUrl(x.source,x.bvid) }));
  }
  recipients(userId: string, ref: string | number): Share[] {
    const p = this.resolve(userId,ref,'owner');
    return this.db.prepare('SELECT u.id,u.username,sh.permission FROM playlist_shares sh JOIN users u ON u.id=sh.user_id WHERE sh.playlist_id=? ORDER BY u.username COLLATE NOCASE').all(p.id) as Share[];
  }
  share(userId: string, ref: string | number, recipientId: string, permission: string): void {
    const p = this.resolve(userId,ref,'owner');
    if (permission !== 'viewer' && permission !== 'editor') throw new Error('分享权限无效。');
    if (recipientId === userId || !this.isWebRegistered(recipientId)) throw new Error('只能分享给其他已注册的用户。');
    const old = this.db.prepare('SELECT permission FROM playlist_shares WHERE playlist_id=? AND user_id=?').get(p.id,recipientId) as { permission: string } | undefined;
    if (old?.permission === permission) return;
    this.db.prepare('INSERT INTO playlist_shares(playlist_id,user_id,permission) VALUES (?,?,?) ON CONFLICT(playlist_id,user_id) DO UPDATE SET permission=excluded.permission').run(p.id,recipientId,permission);
    this.notify(recipientId,`${p.ownerName} ${old ? '更改了' : '分享了'}歌单「${p.name}」：${permission === 'editor' ? '可共同编辑' : '仅查看'}。`);
  }
  unshare(userId: string, ref: string | number, recipientId: string): boolean {
    const p = this.resolve(userId,ref,'owner');
    const changed = this.db.prepare('DELETE FROM playlist_shares WHERE playlist_id=? AND user_id=?').run(p.id,recipientId).changes > 0;
    if (changed) this.notify(recipientId,`歌单「${p.name}」已取消对你的单独分享。`);
    return changed;
  }
  private notify(userId: string, message: string): void { this.db.prepare('INSERT INTO notices(user_id,message,created_at) VALUES (?,?,?)').run(userId,message,Date.now()); }
  notices(userId: string): Notice[] { return (this.db.prepare('SELECT id,message,created_at AS createdAt,read_at AS readAt FROM notices WHERE user_id=? ORDER BY id DESC LIMIT 50').all(userId) as (Omit<Notice,'read'> & { readAt: number | null })[]).map(row => ({ id:row.id,message:row.message,createdAt:row.createdAt,read:row.readAt !== null })); }
  unreadCount(userId: string): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM notices WHERE user_id=? AND read_at IS NULL').get(userId) as { count:number }).count; }
  markNoticesRead(userId: string): void { this.db.prepare('UPDATE notices SET read_at=? WHERE user_id=? AND read_at IS NULL').run(Date.now(),userId); }
  private hashCode(code: string): string { return createHash('sha256').update(code.trim().toUpperCase()).digest('hex'); }
  createInvite(code?: string, maxUses=1, days=7): { code:string; summary:InviteSummary } {
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw=code?.trim().toUpperCase() || Array.from(randomBytes(12),byte=>alphabet[byte%alphabet.length]).join('');
    const value=code ? raw : `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8)}`;
    if (!/^[A-Z0-9-]{8,32}$/.test(value) || !/[A-Z0-9]$/.test(value)) throw new Error('邀请码须为 8–32 位英文字母、数字或连字符。');
    if (!Number.isInteger(maxUses) || maxUses<1 || maxUses>50) throw new Error('使用次数须为 1–50。');
    if (!Number.isInteger(days) || days<1 || days>30) throw new Error('有效天数须为 1–30。');
    const id=this.hashCode(value), expiresAt=Date.now()+days*86400_000;
    if (this.db.prepare('SELECT 1 FROM invite_codes WHERE code_hash=?').get(id)) throw new Error('邀请码已存在，请换一个。');
    this.db.prepare('INSERT INTO invite_codes(code_hash,prefix,max_uses,expires_at) VALUES (?,?,?,?)').run(id,value.slice(0,4),maxUses,expiresAt);
    return { code:value,summary:{ id,prefix:value.slice(0,4),uses:0,maxUses,expiresAt,revoked:false } };
  }
  invites(): InviteSummary[] { return (this.db.prepare('SELECT code_hash AS id,prefix,uses,max_uses AS maxUses,expires_at AS expiresAt,revoked FROM invite_codes ORDER BY rowid DESC LIMIT 100').all() as (Omit<InviteSummary,'revoked'> & { revoked:number })[]).map(row=>({...row,revoked:!!row.revoked})); }
  revokeInvite(id:string): boolean { return this.db.prepare('UPDATE invite_codes SET revoked=1 WHERE code_hash=? AND revoked=0').run(id).changes>0; }
  setting(key:string):string|null { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value??null; }
  setSetting(key:string,value:string):void { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  rememberVoice(userId:string,channelId:string):void { this.db.prepare('INSERT INTO last_voice_channels(user_id,channel_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET channel_id=excluded.channel_id').run(userId,channelId); }
  lastVoice(userId:string):string|null { return (this.db.prepare('SELECT channel_id FROM last_voice_channels WHERE user_id=?').get(userId) as {channel_id:string}|undefined)?.channel_id??null; }
  voiceTarget(userId:string,currentChannelId:string|null):string|null { return currentChannelId??this.lastVoice(userId); }
}
