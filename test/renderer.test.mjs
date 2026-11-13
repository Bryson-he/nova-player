// Renderer modules that run without a DOM: subtitle parsing, URL clean-up
// and per-series track memory.
import test from 'node:test';
import assert from 'node:assert/strict';

// store.js talks to the preload bridge; give it an in-memory one.
const saved = {};
globalThis.window = {
  nova: {
    getStore: async () => ({ settings: {} }),
    set: (k, v) => {
      saved[k] = v;
    },
  },
};
const { initStore, store } = await import('../src/renderer/js/store.js');
const { parseVtt, cueToLines } = await import('../src/renderer/js/subtitles.js');
const { stripKeyParams } = await import('../src/renderer/js/api.js');
const { chooseAudio, chooseSubtitle, rememberTrack } = await import('../src/renderer/js/tracks.js');
await initStore();

test('parseVtt reads cues, sorts them and skips empty ones', () => {
  const cues = parseVtt('WEBVTT\r\n\r\n2\r\n00:00:05.000 --> 00:00:06.500\r\nSecond\r\n\r\n00:01.000 --> 00:02.000 align:start\nFirst\nline two\n\n00:03.000 --> 00:04.000\n<c.x></c>\n');
  assert.equal(cues.length, 2);
  assert.deepEqual([cues[0].start, cues[0].end], [1, 2]);
  assert.deepEqual(cues[0].lines.map((l) => l.map((r) => r.text).join('')), ['First', 'line two']);
  assert.equal(cues[1].start, 5);
  assert.equal(cues[1].end, 6.5);
});

test('parseVtt handles hours and comma decimals', () => {
  const [cue] = parseVtt('1:02:03,250 --> 1:02:04,000\nHi');
  assert.equal(cue.start, 3723.25);
});

test('cue text keeps i/b/u, drops other tags and never yields markup', () => {
  assert.deepEqual(cueToLines('<i>Hello</i> <b>there</b>'), [[{ text: 'Hello', i: true }, { text: ' ' }, { text: 'there', b: true }]]);
  assert.deepEqual(cueToLines('<v Bob>Hi <font color="red">you</font>'), [[{ text: 'Hi ' }, { text: 'you' }]]);
  assert.deepEqual(cueToLines('{\\an8}Top\\Nnext'), [[{ text: 'Top' }], [{ text: 'next' }]]);
  assert.deepEqual(cueToLines('Tom &amp; Jerry &lt;3'), [[{ text: 'Tom & Jerry <3' }]]);
  assert.deepEqual(cueToLines('<img src=x onerror=alert(1)>x'), [[{ text: 'x' }]]);
  assert.deepEqual(cueToLines('a < b'), [[{ text: 'a < b' }]]);
});

test('stripKeyParams removes ApiKey and api_key only', () => {
  assert.equal(stripKeyParams('/videos/1/master.m3u8?DeviceId=d&ApiKey=secret&MediaSourceId=m'), '/videos/1/master.m3u8?DeviceId=d&MediaSourceId=m');
  assert.equal(stripKeyParams('/v/1/Subtitles/2/0/Stream.vtt?api_key=secret'), '/v/1/Subtitles/2/0/Stream.vtt');
  assert.equal(stripKeyParams('/a?apikey=1&API_KEY=2&x=3#t'), '/a?x=3#t');
  assert.equal(stripKeyParams('/a?MyApiKeyThing=1'), '/a?MyApiKeyThing=1');
  assert.equal(stripKeyParams('/a'), '/a');
});

const ms = (streams) => ({ MediaStreams: streams });
const audio = (Index, Language, extra = {}) => ({ Type: 'Audio', Index, Language, Codec: 'aac', Channels: 2, ...extra });
const sub = (Index, Language, extra = {}) => ({ Type: 'Subtitle', Index, Language, Codec: 'ass', ...extra });

test('series memory follows the track by what it is, not its index', () => {
  const ep1 = { Type: 'Episode', SeriesId: 's1', SeriesName: 'Show' };
  const src1 = ms([audio(1, 'eng'), audio(2, 'jpn'), sub(3, 'eng', { Title: 'Signs' }), sub(4, 'eng', { Title: 'Full' })]);
  rememberTrack(ep1, 'audio', src1.MediaStreams[1]);
  rememberTrack(ep1, 'subtitle', src1.MediaStreams[3]);
  assert.ok(saved.seriesTracks.s1.audio);

  // The next episode lists its streams in a different order.
  const src2 = ms([sub(2, 'eng', { Title: 'Full' }), audio(5, 'jpn'), audio(6, 'eng'), sub(7, 'eng', { Title: 'Signs' })]);
  const ep2 = { Type: 'Episode', SeriesId: 's1' };
  assert.equal(chooseAudio(ep2, src2), 5);
  assert.equal(chooseSubtitle(ep2, src2, 5), 2);
});

test('without memory, the language setting picks the audio', () => {
  store.setSetting('audioLang', 'jpn');
  assert.equal(chooseAudio({ Type: 'Movie' }, ms([audio(1, 'eng', { IsDefault: true }), audio(2, 'jpn')])), 2);
  store.setSetting('audioLang', '');
});
