// Audio/subtitle selection and per-series memory.
//
// Jellyfin's own clients remember tracks by stream *index*, which breaks the
// moment the next episode has its streams in a different order. Here we
// remember what the track *is* (language, title, forced/SDH, commentary,
// codec) and score every stream in the next episode against that.
import { store } from './store.js';

const LANG_2_TO_3 = {
  en: 'eng', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', ja: 'jpn', ko: 'kor', zh: 'chi', pt: 'por', ru: 'rus',
  nl: 'dut', sv: 'swe', no: 'nor', nb: 'nor', da: 'dan', fi: 'fin', pl: 'pol', tr: 'tur', ar: 'ara', hi: 'hin',
  he: 'heb', cs: 'cze', hu: 'hun', el: 'gre', th: 'tha', vi: 'vie', id: 'ind', uk: 'ukr', ro: 'rum', ms: 'may',
  tl: 'fil', fa: 'per', bg: 'bul', hr: 'hrv', sr: 'srp', sk: 'slo', sl: 'slv', ca: 'cat', et: 'est', lv: 'lav', lt: 'lit',
};
const LANG_ALIASES = {
  fra: 'fre', deu: 'ger', zho: 'chi', nld: 'dut', ces: 'cze', ell: 'gre', ron: 'rum', nob: 'nor', nno: 'nor',
  slk: 'slo', fas: 'per', msa: 'may', tgl: 'fil', cmn: 'chi', yue: 'chi',
};

export const LANGUAGES = [
  ['', 'No preference'], ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'],
  ['ita', 'Italian'], ['por', 'Portuguese'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'],
  ['rus', 'Russian'], ['dut', 'Dutch'], ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'],
  ['fin', 'Finnish'], ['pol', 'Polish'], ['tur', 'Turkish'], ['ara', 'Arabic'], ['hin', 'Hindi'],
  ['heb', 'Hebrew'], ['cze', 'Czech'], ['hun', 'Hungarian'], ['gre', 'Greek'], ['tha', 'Thai'],
  ['vie', 'Vietnamese'], ['ind', 'Indonesian'], ['ukr', 'Ukrainian'], ['rum', 'Romanian'], ['fil', 'Filipino'],
];

export function normLang(lang) {
  if (!lang) return '';
  let l = String(lang).toLowerCase().trim().split(/[-_]/)[0];
  if (LANG_2_TO_3[l]) l = LANG_2_TO_3[l];
  l = LANG_ALIASES[l] || l;
  return l === 'und' ? '' : l;
}

export function langName(code) {
  const n = normLang(code);
  return LANGUAGES.find(([c]) => c === n)?.[1] || (code ? code.toUpperCase() : 'Unknown');
}

const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'text', 'microdvd', 'smi', 'sami', 'ttml', 'subviewer', 'mpl2']);

export function isTextSub(s) {
  if (!s) return false;
  if (typeof s.IsTextSubtitleStream === 'boolean') return s.IsTextSubtitleStream;
  return TEXT_CODECS.has((s.Codec || '').toLowerCase());
}

const norm = (t) => (t || '').toLowerCase().trim();
const isCommentary = (s) => /comment/i.test(`${s.Title || ''} ${s.DisplayTitle || ''}`);
const isSdh = (s) => !!s.IsHearingImpaired || /\b(sdh|cc|hearing)\b/i.test(s.Title || '');

export const audioStreams = (ms) => (ms?.MediaStreams || []).filter((s) => s.Type === 'Audio');
export const subStreams = (ms) => (ms?.MediaStreams || []).filter((s) => s.Type === 'Subtitle');

export function describeAudio(s) {
  return {
    language: normLang(s.Language),
    title: norm(s.Title),
    codec: norm(s.Codec),
    channels: s.Channels || 0,
    commentary: isCommentary(s),
    label: streamLabel(s),
  };
}

export function describeSub(s) {
  if (!s) return { off: true, label: 'Off' };
  return {
    off: false,
    language: normLang(s.Language),
    title: norm(s.Title),
    codec: norm(s.Codec),
    forced: !!s.IsForced,
    sdh: isSdh(s),
    text: isTextSub(s),
    label: streamLabel(s),
  };
}

export function streamLabel(s) {
  if (!s) return 'Off';
  if (s.DisplayTitle) {
    if (s.Title && !s.DisplayTitle.toLowerCase().includes(s.Title.toLowerCase())) return `${s.Title} — ${s.DisplayTitle}`;
    return s.DisplayTitle;
  }
  const bits = [langName(s.Language), (s.Codec || '').toUpperCase()];
  if (s.Type === 'Audio' && s.Channels) bits.push(`${s.Channels}ch`);
  if (s.IsForced) bits.push('Forced');
  return bits.filter(Boolean).join(' · ');
}

function bestMatch(streams, scoreFn, min) {
  let best = null;
  let bestScore = -Infinity;
  for (const s of streams) {
    const sc = scoreFn(s);
    if (sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }
  return bestScore >= min ? best : null;
}

function matchAudio(streams, pref) {
  const min = pref.language ? 100 : pref.title ? 30 : Infinity;
  return bestMatch(streams, (s) => {
    const d = describeAudio(s);
    let sc = 0;
    if (pref.language && d.language === pref.language) sc += 100;
    if (pref.title && d.title === pref.title) sc += 30;
    if (d.codec === pref.codec) sc += 8;
    if (d.channels === pref.channels) sc += 4;
    if (d.commentary !== !!pref.commentary) sc -= 60;
    return sc;
  }, min);
}

function matchSub(streams, pref) {
  const min = pref.language ? 100 : pref.title ? 15 : Infinity;
  return bestMatch(streams, (s) => {
    const d = describeSub(s);
    let sc = 0;
    if (pref.language && d.language === pref.language) sc += 100;
    sc += d.forced === !!pref.forced ? 40 : -40;
    sc += d.sdh === !!pref.sdh ? 20 : -20;
    if (pref.title && d.title === pref.title) sc += 15;
    if (d.codec === pref.codec) sc += 5;
    if (d.text === pref.text) sc += 3;
    return sc;
  }, min);
}

export function seriesPref(seriesId) {
  return seriesId ? store.get('seriesTracks')?.[seriesId] || null : null;
}

export function rememberTrack(item, kind, stream) {
  if (!store.setting('rememberTracks')) return;
  if (item?.Type !== 'Episode' || !item.SeriesId) return;
  const all = { ...(store.get('seriesTracks') || {}) };
  const cur = { ...(all[item.SeriesId] || {}), name: item.SeriesName, updated: Date.now() };
  cur[kind] = kind === 'audio' ? describeAudio(stream) : describeSub(stream);
  all[item.SeriesId] = cur;
  store.set('seriesTracks', all);
}

export function forgetSeries(seriesId) {
  const all = { ...(store.get('seriesTracks') || {}) };
  delete all[seriesId];
  store.set('seriesTracks', all);
}

// The track a browser plays by default when direct playing the file.
export function containerDefaultAudio(ms) {
  const embedded = audioStreams(ms).filter((s) => !s.IsExternal);
  return embedded.find((s) => s.IsDefault) || embedded[0] || null;
}

export function chooseAudio(item, ms) {
  const streams = audioStreams(ms);
  if (!streams.length) return null;

  const pref = seriesPref(item.SeriesId)?.audio;
  if (pref) {
    const m = matchAudio(streams, pref);
    if (m) return m.Index;
  }

  const lang = normLang(store.setting('audioLang'));
  if (lang) {
    const cands = streams.filter((s) => normLang(s.Language) === lang && !isCommentary(s));
    if (cands.length) return (cands.find((s) => s.IsDefault) || cands[0]).Index;
  }

  if (ms.DefaultAudioStreamIndex != null && streams.some((s) => s.Index === ms.DefaultAudioStreamIndex)) {
    return ms.DefaultAudioStreamIndex;
  }
  return (streams.find((s) => s.IsDefault) || streams[0]).Index;
}

export const isAssSub = (s) => ['ass', 'ssa'].includes((s?.Codec || '').toLowerCase());

// Secondary (top-of-screen) subtitle for dual subtitles. Off unless the user
// picked one for this series before.
export function chooseSecondarySubtitle(item, ms, primaryIndex) {
  const pref = seriesPref(item.SeriesId)?.subtitle2;
  if (!pref || pref.off) return -1;
  const subs = subStreams(ms).filter((s) => isTextSub(s) && s.Index !== primaryIndex);
  return matchSub(subs, pref)?.Index ?? -1;
}

export function chooseSubtitle(item, ms, audioIndex) {
  const subs = subStreams(ms);
  if (!subs.length) return -1;

  const prefs = seriesPref(item.SeriesId);
  if (prefs?.subtitle) {
    if (prefs.subtitle.off) return -1;
    const m = matchSub(subs, prefs.subtitle);
    return m ? m.Index : -1;
  }

  const mode = store.setting('subMode');
  const lang = normLang(store.setting('subLang'));
  const audio = (ms.MediaStreams || []).find((s) => s.Index === audioIndex);
  const audioLang = normLang(audio?.Language);
  const inLang = (l) => subs.filter((s) => normLang(s.Language) === l);
  const pickFull = (l) => {
    const c = inLang(l).filter((s) => !s.IsForced);
    return c.find((s) => !isSdh(s)) || c[0] || null;
  };
  const pickForced = (l) => inLang(l).find((s) => s.IsForced) || null;

  switch (mode) {
    case 'off':
      return -1;
    case 'always': {
      if (lang) return pickFull(lang)?.Index ?? -1;
      return (subs.find((s) => s.IsDefault) || subs[0]).Index;
    }
    case 'forced':
      return pickForced(lang || audioLang)?.Index ?? -1;
    case 'smart': {
      const target = lang || normLang(store.setting('audioLang'));
      if (!target) return ms.DefaultSubtitleStreamIndex ?? -1;
      if (audioLang && audioLang !== target) return pickFull(target)?.Index ?? -1;
      return pickForced(target)?.Index ?? -1;
    }
    default:
      return ms.DefaultSubtitleStreamIndex ?? -1;
  }
}
