import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startWeb } from '../dist/web.js';
import { PlaylistStore } from '../dist/playlists.js';

test('Discord OAuth signs a session, binds it to the guild, and protects controls', async () => {
  let paused = 0, seeked = null, joined = null, membershipChecks = 0;
  const engine = {
    status: 'idle', lastError: null, queue: { current: null, upcoming: [], playlistName: null, repeat: 'off' },
    voiceStatus: () => 'disconnected', currentVoiceChannelId: () => null, positionSeconds: () => 0,
    togglePause: () => { paused++; return 'paused'; }, seek: seconds => { seeked = seconds; return seconds; },
  };
  const userId = '123456789012345678';
  const store = new PlaylistStore(':memory:',userId);
  const discordFetch = async (url, init) => {
    if (url.endsWith('/oauth2/token')) {
      assert.equal(init.body.get('grant_type'), 'authorization_code');
      assert.equal(init.body.get('client_secret'), 'test-client-secret');
      return new Response(JSON.stringify({ access_token: 'private-test-token' }), { status: 200 });
    }
    assert.equal(init.headers.Authorization, 'Bearer private-test-token');
    return new Response(JSON.stringify({ id: userId, username: 'alice', avatar:'abc123def456' }), { status: 200 });
  };
  const server = startWeb({ engine, store, media: {}, clientId: '998877665544332211', clientSecret: 'test-client-secret',
    publicUrl: 'http://127.0.0.1:3000', sessionSecret: 'a-test-session-secret-longer-than-32-characters',
    host: '127.0.0.1', port: 0, discordFetch, adminId:userId,
    isGuildMember: async id => { membershipChecks++; return id === userId; },
    joinMe: async id => { joined = id; return 'voice1'; }, playTarget: async () => 'voice1' });
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base)).status, 200);
    const anonymous = await fetch(`${base}/api/state`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('www-authenticate'), null);
    const login = await fetch(`${base}/auth/discord`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const authorization = new URL(login.headers.get('location'));
    assert.equal(authorization.searchParams.get('scope'), 'identify');
    const state = authorization.searchParams.get('state');
    const stateCookie = login.headers.getSetCookie()[0].split(';')[0];
    const bad = await fetch(`${base}/auth/discord/callback?code=test-code&state=wrong`, { headers: { Cookie: stateCookie }, redirect: 'manual' });
    assert.match(bad.headers.get('location'), /authError=/);
    const callback = await fetch(`${base}/auth/discord/callback?code=test-code&state=${state}`, { headers: { Cookie: stateCookie }, redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/');
    const session = callback.headers.getSetCookie().find(x => x.startsWith('music_session=')).split(';')[0];
    const stateResponse = await fetch(`${base}/api/state`, { headers: { Cookie: session } });
    assert.equal(stateResponse.status, 200);
    assert.deepEqual((await stateResponse.json()).currentUser, { id: userId, username: 'alice', avatarUrl:`https://cdn.discordapp.com/avatars/${userId}/abc123def456.png?size=128`, isAdmin:true });
    assert.ok(membershipChecks >= 1);
    const forged = await fetch(`${base}/api/state`, { headers: { Cookie: session.slice(0, -1) + 'x' } });
    assert.equal(forged.status, 401);
    const headers = { Cookie: session, Origin: base, 'Content-Type': 'application/json' };
    const cross = await fetch(`${base}/api/action`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"action":"pause"}' });
    assert.equal(cross.status, 403); assert.equal(paused, 0);
    const pause = await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{"action":"pause"}' });
    assert.equal(pause.status, 200); assert.equal(paused, 1);
    const seek = await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{"action":"seek","seconds":42}' });
    assert.equal(seek.status, 200); assert.equal(seeked, 42);
    const join = await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{"action":"joinMe","userId":"999999999999999999"}' });
    assert.equal(join.status, 200); assert.equal(joined, userId);
    const logout = await fetch(`${base}/auth/logout`, { headers: { Cookie: session }, redirect: 'manual' });
    assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('web registration requires invite, and playlist and admin routes enforce ownership', async () => {
  const admin='1216979584575078522', guest='223456789012345678';
  const store=new PlaylistStore(':memory:',admin);
  const engine={ status:'idle',lastError:null,queue:{current:null,upcoming:[],playlistName:null,repeat:'off'},voiceStatus:()=> 'disconnected',currentVoiceChannelId:()=>null,positionSeconds:()=>0 };
  let loginAs=admin;
  const discordFetch=async url => url.endsWith('/oauth2/token') ? new Response(JSON.stringify({access_token:'test'})) : new Response(JSON.stringify({id:loginAs,username:loginAs===admin?'Admin':'Guest'}));
  const server=startWeb({ engine,store,media:{},clientId:admin,clientSecret:'test-secret',adminId:admin,publicUrl:'http://127.0.0.1:3000',sessionSecret:'test-session-secret-longer-than-32-characters',host:'127.0.0.1',port:0,discordFetch,isGuildMember:async()=>true,joinMe:async()=>'',playTarget:async()=>'' });
  try {
    await once(server,'listening'); const base=`http://127.0.0.1:${server.address().port}`;
    const login=async (who,inviteCode='') => {
      loginAs=who;
      const start=await fetch(`${base}/auth/discord/start`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({inviteCode})});
      const url=new URL((await start.json()).url), state=url.searchParams.get('state'), cookie=start.headers.getSetCookie()[0].split(';')[0];
      const callback=await fetch(`${base}/auth/discord/callback?code=test&state=${state}`,{headers:{Cookie:cookie},redirect:'manual'});
      return callback.headers.getSetCookie().find(x=>x.startsWith('music_session='))?.split(';')[0] || null;
    };
    assert.equal(await login(guest),null);
    const adminSession=await login(admin); assert.ok(adminSession);
    const post=async (cookie,data) => fetch(`${base}/api/action`,{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(data)});
    const inviteResponse=await post(adminSession,{action:'inviteCreate',maxUses:1,days:7});
    assert.equal(inviteResponse.status,200); const invite=(await inviteResponse.json()).code;
    const guestSession=await login(guest,invite); assert.ok(guestSession);
    assert.equal((await post(guestSession,{action:'inviteCreate'})).status,400);
    assert.equal((await fetch(`${base}/api/invites`,{headers:{Cookie:guestSession}})).status,403);
    assert.equal((await post(adminSession,{action:'playlistCreate',name:'Secret'})).status,200);
    const adminState=await (await fetch(`${base}/api/state`,{headers:{Cookie:adminSession}})).json();
    const playlist=adminState.playlists.find(x=>x.name==='Secret'); assert.ok(playlist);
    assert.equal(playlist.visibility,'public');
    assert.equal((await post(adminSession,{action:'playlistVisibility',playlistId:playlist.id,visibility:'private'})).status,200);
    assert.equal((await fetch(`${base}/api/playlist?id=${playlist.id}`,{headers:{Cookie:guestSession}})).status,400);
    assert.equal((await post(guestSession,{action:'playlistDelete',playlistId:playlist.id})).status,400);
    assert.equal((await post(adminSession,{action:'playlistShare',playlistId:playlist.id,recipientId:guest,permission:'editor'})).status,200);
    const guestState=await (await fetch(`${base}/api/state`,{headers:{Cookie:guestSession}})).json();
    assert.equal(guestState.playlists.find(x=>x.id===playlist.id).permission,'editor');
    assert.equal(guestState.unreadCount,1);
    assert.match(guestState.currentUser.avatarUrl,/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  } finally { await new Promise(resolve=>server.close(resolve)); store.close(); }
});
