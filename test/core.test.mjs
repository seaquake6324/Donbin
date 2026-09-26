import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicQueue } from '../dist/queue.js';
import { PlaylistStore } from '../dist/playlists.js';
import { parseBilibili, parseMediaInput } from '../dist/media.js';
import { MusicEngine } from '../dist/engine.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { PassThrough } from 'node:stream';
import { commands } from '../dist/commands.js';

const track = n => ({ source: 'bilibili', id: `BV${String(n).padStart(10, '0')}`, title: `Song ${n}`, duration: 60, url: `https://www.bilibili.com/video/BV${String(n).padStart(10, '0')}` });
const youtube = { source: 'youtube', id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: 19, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' };
const admin = '1216979584575078522', alice = '123456789012345678', bob = '223456789012345678', charlie = '323456789012345678';

test('BV and URL parsing rejects unrelated hosts and paths', () => {
  assert.equal(parseBilibili('BV1xx411c7mD'), 'BV1xx411c7mD');
  assert.equal(parseBilibili('https://www.bilibili.com/video/BV1xx411c7mD?p=2'), 'BV1xx411c7mD');
  for (const bad of ['BV123', 'https://evil.com/video/BV1xx411c7mD', 'https://bilibili.com.evil.com/video/BV1xx411c7mD', 'https://www.bilibili.com/read/BV1xx411c7mD']) assert.throws(() => parseBilibili(bad));
});

test('YouTube single-video input normalizes safe hosts and rejects playlists and lookalikes', () => {
  for (const input of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw?t=3', 'https://m.youtube.com/shorts/jNQXAC9IVRw', 'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=PL123']) {
    assert.deepEqual(parseMediaInput(input), { source: 'youtube', id: 'jNQXAC9IVRw', url: youtube.url });
  }
  assert.equal(parseMediaInput('BV1xx411c7mD').source, 'bilibili');
  for (const bad of ['https://youtube.com/playlist?list=PL123', 'https://youtube.com.evil.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVR', 'https://evil.com/watch?v=jNQXAC9IVRw']) assert.throws(() => parseMediaInput(bad));
});

test('queue order, previous, repeat one and repeat queue', () => {
  const q = new MusicQueue();
  assert.equal(q.enqueue(track(1)), true);
  assert.equal(q.enqueue(track(2)), false);
  assert.equal(q.advance('ended')?.title, 'Song 2');
  assert.equal(q.previous()?.title, 'Song 1');
  assert.equal(q.upcoming[0].title, 'Song 2');
  q.repeat = 'one';
  assert.equal(q.advance('ended')?.title, 'Song 1');
  assert.equal(q.advance('skip')?.title, 'Song 2');
  q.repeat = 'queue';
  assert.equal(q.advance('ended')?.title, 'Song 2');
  assert.equal(q.upcoming.length, 0);
  assert.equal(q.advance('failed'), null);
});

test('shuffle preserves every track exactly once and current track', () => {
  const q = new MusicQueue();
  for (let n = 1; n <= 100; n++) q.enqueue(track(n));
  q.shuffle(() => 0.25);
  assert.equal(q.current?.title, 'Song 1');
  assert.deepEqual(q.upcoming.map(x => x.id).sort(), Array.from({ length: 99 }, (_, i) => track(i + 2).id).sort());
});

test('playlist persists across reopen and delete cascades', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-bot-'));
  const path = join(dir, 'music.sqlite');
  let db;
  try {
    db = new PlaylistStore(path,admin);
    db.ensureUser(alice,'Alice'); db.ensureUser(bob,'Bob');
    const first=db.create(alice,'Favorites'), second=db.create(bob,'Favorites');
    assert.notEqual(first.id,second.id);
    db.add(alice,'Favorites',track(1)); db.add(alice,'Favorites',youtube); db.add(alice,'Favorites',track(2)); db.setSetting('panel_message_id', '123'); db.rememberVoice('user-1', 'voice-A'); db.rememberVoice('user-1', 'voice-B'); db.close();
    db = new PlaylistStore(path,admin);
    assert.deepEqual(db.songs(alice,'favorites').map(x => x.title), ['Song 1', 'Me at the zoo', 'Song 2']);
    assert.deepEqual(db.songs(alice,'favorites').map(x => x.source), ['bilibili', 'youtube', 'bilibili']);
    assert.equal(db.songs(alice,'favorites')[1].url, youtube.url);
    assert.equal(db.songs(bob,'Favorites').length,0);
    assert.equal(db.setting('panel_message_id'), '123');
    assert.equal(db.lastVoice('user-1'), 'voice-B');
    assert.equal(db.lastVoice('other-user'), null);
    assert.equal(db.voiceTarget('user-1', 'voice-C'), 'voice-C');
    assert.equal(db.voiceTarget('user-1', null), 'voice-B');
    assert.equal(db.voiceTarget('other-user', null), null);
    assert.equal(db.remove(alice,'Favorites',1), true);
    assert.deepEqual(db.songs(alice,'Favorites').map(x => x.title), ['Me at the zoo', 'Song 2']);
    assert.equal(db.delete(alice,'Favorites'), true);
    assert.throws(()=>db.songs(alice,'Favorites'));
    assert.equal(db.info(bob,'Favorites').id,second.id);
    db.close(); db = undefined;
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('existing Bilibili playlist database migrates without losing songs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-legacy-'));
  const path = join(dir, 'music.sqlite');
  let store;
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE playlists (name TEXT PRIMARY KEY COLLATE NOCASE); CREATE TABLE songs (id INTEGER PRIMARY KEY, playlist_name TEXT NOT NULL, position INTEGER NOT NULL, bvid TEXT NOT NULL, title TEXT NOT NULL, duration INTEGER); INSERT INTO playlists VALUES ('Old'); INSERT INTO songs(playlist_name,position,bvid,title,duration) VALUES ('Old',1,'BV1xx411c7mD','Old song',45);");
    legacy.close();
    store = new PlaylistStore(path,admin);
    assert.deepEqual(store.songs(admin,'Old').map(x => [x.source, x.id]), [['bilibili', 'BV1xx411c7mD']]);
    assert.equal(store.info(admin,'Old').visibility,'public');
    store.add(admin,'Old', youtube);
    store.close(); store = new PlaylistStore(path,admin);
    assert.deepEqual(store.songs(admin,'Old').map(x => x.source), ['bilibili', 'youtube']);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invite registration, public browsing, private sharing and editor rights persist', () => {
  const dir=mkdtempSync(join(tmpdir(),'music-accounts-')), path=join(dir,'db.sqlite'); let db;
  try {
    db=new PlaylistStore(path,admin);
    assert.equal(db.isWebRegistered(admin),true);
    assert.throws(()=>db.registerWebUser(alice,'Alice','WRONG-CODE'));
    const invite=db.createInvite('PRIVATE-ALICE',1,7);
    db.registerWebUser(alice,'Alice',invite.code);
    assert.throws(()=>db.registerWebUser(bob,'Bob',invite.code));
    db.registerWebUser(alice,'Alice new','');
    const bobInvite=db.createInvite(undefined,2,7);
    db.registerWebUser(bob,'Bob',bobInvite.code);
    db.registerWebUser(charlie,'Charlie',bobInvite.code);
    assert.equal(db.invites().find(x=>x.id===bobInvite.summary.id).uses,2);
    assert.equal(db.revokeInvite(invite.summary.id),true);
    const p=db.create(alice,'Mix'); db.add(alice,p.id,track(1));
    assert.equal(db.info(bob,p.id).permission,'viewer');
    assert.throws(()=>db.add(bob,p.id,track(2)));
    db.setVisibility(alice,p.id,'private');
    assert.throws(()=>db.info(bob,p.id));
    db.share(alice,p.id,bob,'viewer');
    assert.equal(db.info(bob,p.id).permission,'viewer');
    assert.throws(()=>db.remove(bob,p.id,1));
    db.share(alice,p.id,bob,'editor');
    db.add(bob,p.id,youtube);
    assert.deepEqual(db.songs(bob,p.id).map(x=>x.source),['bilibili','youtube']);
    assert.throws(()=>db.delete(bob,p.id));
    assert.throws(()=>db.share(bob,p.id,charlie,'editor'));
    assert.ok(db.unreadCount(bob)>=2);
    db.markNoticesRead(bob); assert.equal(db.unreadCount(bob),0);
    db.close(); db=new PlaylistStore(path,admin);
    assert.equal(db.info(bob,p.id).permission,'editor');
    assert.equal(db.info(bob,p.id).visibility,'private');
    assert.equal(db.list(charlie).some(x=>x.id===p.id),false);
    assert.equal(db.unshare(alice,p.id,bob),true);
    assert.throws(()=>db.info(bob,p.id));
    assert.equal(db.unreadCount(bob),1);
  } finally { db?.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('rapid sequential operations leave queue consistent', () => {
  const q = new MusicQueue();
  for (let n = 1; n <= 20; n++) q.enqueue(track(n));
  for (let n = 0; n < 10; n++) q.advance('skip');
  assert.equal(q.current?.title, 'Song 11');
  assert.equal(q.history.length, 10);
  assert.equal(q.upcoming.length, 9);
  q.replace([track(30), track(31)], 'New');
  assert.equal(q.current?.title, 'Song 30');
  assert.equal(q.history.length, 0);
  assert.equal(q.advance('ended')?.title, 'Song 31');
});

test('seek restarts current track at an integer position without altering queue', () => {
  const engine = new MusicEngine({ id: 'test-guild' }, 'voice', {}, 'ffmpeg');
  const starts = [];
  engine.startCurrent = (...args) => { starts.push(args); };
  engine.enqueue(track(1)); engine.enqueue(track(2));
  engine.status = 'paused';
  assert.equal(engine.seek(19), 19);
  assert.deepEqual(starts.at(-1), [19, true]);
  assert.equal(engine.queue.current.title, 'Song 1');
  assert.equal(engine.queue.upcoming.length, 1);
  assert.throws(() => engine.seek(60));
  assert.throws(() => engine.seek(1.5));
});

test('stale Idle event after skip cannot advance the next track', () => {
  const engine = new MusicEngine({ id: 'test-guild' }, 'voice', {}, 'ffmpeg');
  engine.startCurrent = () => {};
  engine.enqueue(track(1)); engine.enqueue(track(2)); engine.enqueue(track(3));
  const oldGeneration = engine.generation;
  engine.skip();
  assert.equal(engine.queue.current?.title, 'Song 2');
  engine.player.emit('stateChange', { status: AudioPlayerStatus.Playing, resource: { metadata: oldGeneration } }, { status: AudioPlayerStatus.Idle });
  assert.equal(engine.queue.current?.title, 'Song 2');
  engine.skip();
  assert.equal(engine.queue.current?.title, 'Song 3');
  engine.player.emit('stateChange', { status: AudioPlayerStatus.Playing, resource: { metadata: oldGeneration } }, { status: AudioPlayerStatus.Idle });
  assert.equal(engine.queue.current?.title, 'Song 3');
});

test('pre-resolves only the next track near the end without repeated work', async () => {
  const calls = [];
  const engine = new MusicEngine({ id: 'test-guild' }, 'voice', { prefetch: async song => { calls.push(song.id); } }, 'ffmpeg');
  engine.startCurrent = () => {};
  engine.enqueue(track(1)); engine.enqueue(youtube);
  engine.status = 'playing';
  engine.activeResource = { playbackDuration: 20_000 };
  engine.prefetchNext(engine.generation);
  assert.deepEqual(calls, []);
  engine.activeResource = { playbackDuration: 31_000 };
  engine.prefetchNext(engine.generation);
  engine.prefetchNext(engine.generation);
  assert.deepEqual(calls, [youtube.id]);
  engine.queue.repeat = 'one';
  engine.prefetchNext(engine.generation);
  assert.deepEqual(calls, [youtube.id, track(1).id]);
});

test('join targets chosen voice and default play target without starting playback', async () => {
  assert.ok(commands.some(command => command.name === 'join'));
  const engine = new MusicEngine({ id: 'test-guild' }, 'default-voice', {}, 'ffmpeg');
  const calls = [];
  engine.connect = async channelId => { calls.push(channelId); };
  await engine.join('user-voice');
  assert.equal(engine.targetChannelId, 'user-voice');
  await engine.joinDefault();
  assert.equal(engine.targetChannelId, 'default-voice');
  assert.deepEqual(calls, ['user-voice', 'default-voice']);
  assert.equal(engine.queue.current, null);
  assert.equal(engine.status, 'idle');
});

test('join retries a transient voice setup failure once', async () => {
  const engine = new MusicEngine({ id: 'test-guild' }, 'default-voice', {}, 'ffmpeg');
  let attempts = 0;
  engine.connect = async () => { if (++attempts === 1) throw new Error('temporary UDP failure'); };
  await engine.join('user-voice');
  assert.equal(attempts, 2);
  assert.equal(engine.targetChannelId, 'user-voice');
});

test('simultaneous joins serialize channel moves', async () => {
  const engine = new MusicEngine({ id: 'test-guild' }, 'default-voice', {}, 'ffmpeg');
  const calls = [];
  engine.connect = async channelId => { calls.push(channelId); await new Promise(resolve => setTimeout(resolve, 30)); };
  await Promise.all([engine.join('voice-A'), engine.join('voice-B')]);
  assert.deepEqual(calls, ['voice-A', 'voice-B']);
  assert.equal(engine.targetChannelId, 'voice-B');
});

test('audio waits for prebuffer and aborts when transport is cancelled', async () => {
  const engine = new MusicEngine({ id: 'test-guild' }, 'voice', {}, 'ffmpeg');
  const buffer = new PassThrough({ highWaterMark: 768_000 });
  const waiting = engine.waitForPcm(buffer, { exitCode: null }, 384_000, 1000);
  buffer.write(Buffer.alloc(100_000));
  setTimeout(() => buffer.write(Buffer.alloc(284_000)), 100);
  await waiting;
  assert.ok(buffer.readableLength >= 384_000);
  buffer.destroy();
  const cancelled = new PassThrough(); cancelled.destroy();
  await assert.rejects(engine.waitForPcm(cancelled, { exitCode: null }, 384_000, 100));
});
