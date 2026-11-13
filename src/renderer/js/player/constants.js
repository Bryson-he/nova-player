// Constants shared by the player modules.

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const QUALITIES = [
  [0, 'Auto (from settings)'], [120000000, 'Maximum'], [40000000, '40 Mbps'], [20000000, '20 Mbps'],
  [10000000, '10 Mbps'], [6000000, '6 Mbps'], [3000000, '3 Mbps'], [1500000, '1.5 Mbps'],
];
export const BOOSTS = [[1, '100% (normal)'], [1.5, '150%'], [2, '200%'], [3, '300%']];
export const BUFFERS = {
  normal: { maxBufferLength: 60, maxMaxBufferLength: 300, backBufferLength: 90, maxBufferSize: 60 * 1000 * 1000 },
  large: { maxBufferLength: 180, maxMaxBufferLength: 600, backBufferLength: 120, maxBufferSize: 300 * 1000 * 1000 },
  max: { maxBufferLength: 600, maxMaxBufferLength: 1200, backBufferLength: 180, maxBufferSize: 800 * 1000 * 1000 },
};
export const JASSUB_DIR = new URL('../../vendor/jassub/', import.meta.url).href;
export const FONT_RE = /font|\.(ttf|otf|ttc|woff2?)$/i;
export const SKIP_LABELS = { Intro: 'Skip intro', Recap: 'Skip recap', Preview: 'Skip preview', Commercial: 'Skip ad', Outro: 'Skip credits' };

export const PLAYBACK_ERRORS = {
  NotAllowed: 'Your account is not allowed to play this.',
  NoCompatibleStream: 'The server could not find a way to stream this file.',
  RateLimitExceeded: 'The server is busy (too many streams). Try again shortly.',
};

export const REASON_LABELS = {
  DirectPlayError: 'Direct play turned off (setting, quality or track choice)',
  ContainerNotSupported: 'File container not supported here (remuxing, no quality loss)',
  VideoCodecNotSupported: 'Video codec not supported on this PC',
  AudioCodecNotSupported: 'Audio codec not supported on this PC',
  SubtitleCodecNotSupported: 'Subtitles must be burned in',
  ContainerBitrateExceedsLimit: 'File bitrate is above your quality limit',
};
export const humanize = (s) => REASON_LABELS[s] || s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());

// "14 minutes of 1 hour 30" for the seek slider's screen reader text.
export function spokenTime(sec) {
  const m = Math.floor((sec || 0) / 60);
  const hrs = Math.floor(m / 60);
  const mins = m % 60;
  if (!hrs) return `${mins} minute${mins === 1 ? '' : 's'}`;
  return `${hrs} hour${hrs === 1 ? '' : 's'}${mins ? ` ${mins}` : ''}`;
}
