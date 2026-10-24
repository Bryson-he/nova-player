// Builds a Jellyfin DeviceProfile from what this machine can actually decode,
// so the server direct-plays whenever possible and only transcodes what it must.

let cached = null;

function probe() {
  const v = document.createElement('video');
  const can = (type) => {
    try {
      return v.canPlayType(type).replace('no', '') !== '' || (window.MediaSource?.isTypeSupported(type) ?? false);
    } catch {
      return false;
    }
  };

  const video = ['h264'];
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) video.push('hevc');
  if (can('video/mp4; codecs="av01.0.08M.08"')) video.push('av1');
  if (can('video/webm; codecs="vp9"') || can('video/mp4; codecs="vp09.00.10.08"')) video.push('vp9');
  if (can('video/webm; codecs="vp8"')) video.push('vp8');

  const audio = ['aac', 'mp3'];
  if (can('audio/webm; codecs="opus"') || can('audio/ogg; codecs="opus"')) audio.push('opus');
  if (can('audio/flac') || can('audio/mp4; codecs="flac"')) audio.push('flac');
  if (can('audio/ogg; codecs="vorbis"') || can('audio/webm; codecs="vorbis"')) audio.push('vorbis');
  if (can('audio/mp4; codecs="ac-3"')) audio.push('ac3');
  if (can('audio/mp4; codecs="ec-3"')) audio.push('eac3');

  const mkv = can('video/x-matroska') || can('video/mkv') || can('video/x-matroska; codecs="avc1.640029"');
  const mseHls = !!window.MediaSource;
  return { video, audio, mkv, mseHls };
}

export function capabilities() {
  if (!cached) cached = probe();
  return cached;
}

export function buildDeviceProfile(maxBitrate) {
  const caps = capabilities();
  const v = caps.video.join(',');
  const a = caps.audio.join(',');
  const hlsVideo = caps.video.filter((c) => ['h264', 'hevc', 'av1'].includes(c)).join(',');
  const hlsAudio = caps.audio.filter((c) => ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'].includes(c)).join(',');

  const directPlay = [
    { Container: 'mp4,m4v', Type: 'Video', VideoCodec: v, AudioCodec: a },
    { Container: 'mov', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: a },
    { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' },
  ];
  if (caps.mkv) directPlay.push({ Container: 'mkv', Type: 'Video', VideoCodec: v, AudioCodec: a });

  return {
    Name: 'Nova Player',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: 1_000_000_000,
    MusicStreamingTranscodingBitrate: 384000,
    DirectPlayProfiles: directPlay,
    TranscodingProfiles: [
      {
        Container: 'mp4',
        Type: 'Video',
        AudioCodec: hlsAudio || 'aac',
        VideoCodec: hlsVideo || 'h264',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '6',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
      {
        Container: 'ts',
        Type: 'Video',
        AudioCodec: 'aac,mp3',
        VideoCodec: 'h264',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '6',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        // Chromium cannot decode 10-bit ("Hi10P") H.264, common in anime releases.
        Type: 'Video',
        Codec: 'h264',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
          { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false },
          { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false },
        ],
      },
      {
        Type: 'Video',
        Codec: 'hevc',
        Conditions: [
          { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false },
        ],
      },
      {
        Type: 'VideoAudio',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '8', IsRequired: false },
        ],
      },
    ],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'pgssub', Method: 'Encode' },
      { Format: 'pgs', Method: 'Encode' },
      { Format: 'dvdsub', Method: 'Encode' },
      { Format: 'dvbsub', Method: 'Encode' },
      { Format: 'vobsub', Method: 'Encode' },
    ],
    ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
  };
}
