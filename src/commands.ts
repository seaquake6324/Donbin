import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('join').setDescription('加入你当前或上次所在的语音频道'),
  new SlashCommandBuilder().setName('play').setDescription('播放 Bilibili 或 YouTube 视频').addStringOption(o => o.setName('video').setDescription('BV 号、Bilibili 或 YouTube 链接').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('暂停播放'),
  new SlashCommandBuilder().setName('resume').setDescription('继续播放'),
  new SlashCommandBuilder().setName('skip').setDescription('下一首'),
  new SlashCommandBuilder().setName('previous').setDescription('上一首'),
  new SlashCommandBuilder().setName('stop').setDescription('停止并清空队列'),
  new SlashCommandBuilder().setName('shuffle').setDescription('打乱待播歌曲'),
  new SlashCommandBuilder().setName('repeat').setDescription('切换循环模式'),
  new SlashCommandBuilder().setName('queue').setDescription('查看播放队列'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('查看当前歌曲'),
  new SlashCommandBuilder().setName('diagnostics').setDescription('查看 Bot 运行状态'),
  new SlashCommandBuilder().setName('playlist').setDescription('管理持久歌单')
    .addSubcommand(s => s.setName('create').setDescription('创建歌单').addStringOption(o => o.setName('name').setDescription('歌单名称').setRequired(true)))
    .addSubcommand(s => s.setName('delete').setDescription('删除歌单').addStringOption(o => o.setName('name').setDescription('歌单名称').setRequired(true)))
    .addSubcommand(s => s.setName('add').setDescription('添加视频').addStringOption(o => o.setName('name').setDescription('自己的歌单名，或可编辑歌单的 #编号').setRequired(true)).addStringOption(o => o.setName('video').setDescription('BV 号、Bilibili 或 YouTube 链接').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('按序号删除歌曲').addStringOption(o => o.setName('name').setDescription('歌单名称').setRequired(true)).addIntegerOption(o => o.setName('position').setDescription('歌曲序号，从 1 开始').setMinValue(1).setRequired(true)))
    .addSubcommand(s => s.setName('show').setDescription('查看歌单').addStringOption(o => o.setName('name').setDescription('自己的歌单名，或可见歌单的 #编号').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('列出歌单'))
    .addSubcommand(s => s.setName('play').setDescription('切换并播放歌单').addStringOption(o => o.setName('name').setDescription('自己的歌单名，或可见歌单的 #编号').setRequired(true)))
].map(x => x.toJSON());
