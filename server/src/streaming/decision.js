import { expectedSpeed } from './encoderStats.js';
import { levelsFor } from './encoder.js';

// Decides HOW a file is delivered to a specific client. Order of preference:
//   1. direct    – the original file over HTTP range requests (zero server CPU, perfect quality)
//   2. remux     – video copied bit-for-bit, audio converted if needed, streamed as fragmented MP4
//   3. transcode – adaptive-bitrate HLS ladder; the player switches renditions instead of stalling

const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac']);
const DIRECT_CONTAINERS = { mp4: 'mp4', mov: 'mp4', m4v: 'mp4', webm: 'webm' };

export const LADDER = [
  { id: '2160p', height: 2160, bitrate: 20_000_000 },
  { id: '1440p', height: 1440, bitrate: 12_000_000 },
  { id: '1080p', height: 1080, bitrate: 7_500_000 },
  { id: '720p', height: 720, bitrate: 3_800_000 },
  { id: '480p', height: 480, bitrate: 1_600_000 },
  { id: '360p', height: 360, bitrate: 800_000 },
];

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Resolution class: a 1920x800 scope movie is still "1080p". */
export function classHeight(video) {
  if (!video) return 0;
  return Math.max(video.height, Math.round((video.width * 9) / 16));
}

export function audioBitrateFor(channels) {
  return channels > 2 ? 384_000 : 192_000;
}

export function buildLadder(media, { hwaccel, maxSoftwareHeight, maxHeight }) {
  const v = media.video;
  const srcClass = classHeight(v);
  const ceiling = Math.min(srcClass, hwaccel === 'none' ? maxSoftwareHeight : 2160, maxHeight || 2160);
  const audioBr = media.audio.reduce((s, a) => s + (a.bitrate || 0), 0);
  const srcVideoBr = v.bitrate || Math.max(500_000, (media.bitrate || 0) - audioBr) || 20_000_000;
  const fpsBoost = (v.fps || 24) > 40 ? 1.4 : 1;

  let rungs = LADDER.filter((r) => r.height <= ceiling);
  if (!rungs.length) rungs = [LADDER[LADDER.length - 1]];
  // Avoid near-duplicate rungs: if the source sits between rungs (e.g. 900p), add a native one.
  return rungs.map((r) => {
    const f = Math.min(1, r.height / srcClass);
    const bitrate = Math.round(Math.min(r.bitrate * fpsBoost, srcVideoBr * 1.1) / 1000) * 1000;
    return {
      id: r.id,
      width: even(v.width * f),
      height: even(v.height * f),
      bitrate: Math.max(bitrate, 400_000),
    };
  });
}

function videoSupported(v, caps) {
  if (!v || !caps?.video?.[v.codec]) return [false, `${v?.codec || 'unknown'} video isn't supported by this device`];
  if (v.codec === 'h264' && v.bitDepth > 8) return [false, '10-bit H.264 isn\'t playable in browsers'];
  if (v.interlaced) return [false, 'interlaced video needs deinterlacing'];
  if (v.hdr && !caps.hdr) return [false, 'HDR video on an SDR display needs tone mapping'];
  if (v.hdr === 'dv' && !caps.dolbyVision && !caps.hdr) return [false, 'Dolby Vision needs tone mapping'];
  if (caps.maxHeight && classHeight(v) > caps.maxHeight * 1.05) return [false, 'resolution is higher than this device supports'];
  return [true];
}

export function pickDefaultTracks(media, prefs = {}) {
  const audio = media.audio;
  const langMatch = (t, lang) => lang && t.language && t.language.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2));
  const a = audio.find((t) => langMatch(t, prefs.audioLanguage)) || audio.find((t) => t.default) || audio[0] || null;
  let s = null;
  const mode = prefs.subtitleMode || 'forced';
  const subs = media.subtitles;
  if (mode === 'always') s = subs.find((t) => langMatch(t, prefs.subtitleLanguage) && !t.forced) || subs.find((t) => langMatch(t, prefs.subtitleLanguage));
  else if (mode === 'forced') s = subs.find((t) => t.forced && (langMatch(t, a?.language) || langMatch(t, prefs.subtitleLanguage)));
  return { audioIndex: a?.index ?? null, subtitleIndex: s?.index ?? null };
}

/**
 * @param media     parsed media_files row
 * @param opts      { caps, audioIndex, subtitleIndex, quality, maxBitrate, bandwidth, forceMode, settings }
 */
export function decide(media, opts) {
  const { caps = {}, settings } = opts;
  const reasons = [];
  const audio = media.audio.find((a) => a.index === opts.audioIndex) || media.audio[0] || null;
  const sub = media.subtitles.find((s) => String(s.index) === String(opts.subtitleIndex)) || null;
  const burn = !!(sub && !sub.text);

  const [vOk, vWhy] = videoSupported(media.video, caps);
  if (!vOk) reasons.push(vWhy);
  if (burn) reasons.push('picture-based subtitles must be burned in');

  const audioOk = !audio || !!caps.audio?.[audio.codec];
  const audioIsFirst = !audio || media.audio[0]?.index === audio.index;
  const containerKind = DIRECT_CONTAINERS[media.container];
  const containerOk = !!containerKind && !!caps.containers?.[containerKind];

  // Bandwidth budget. "original" quality means: never reduce quality, even if it may buffer.
  // Every quality this server can offer for this file (also feeds the player's quality menu).
  const maxHeight = Math.min(caps.maxHeight || 2160, opts.capHeight || 2160);
  const fullLadder = buildLadder(media, { hwaccel: settings.hwaccel, maxSoftwareHeight: settings.maxSoftwareHeight, maxHeight });

  // A fixed quality ("720p") picked by the user: one rendition, no adaptive switching.
  const explicitQuality = !!opts.quality && !['auto', 'original'].includes(opts.quality);
  const wantHeight = explicitQuality ? parseInt(opts.quality, 10) || 1080 : null;
  const fixedRung = explicitQuality ? fullLadder.find((r) => parseInt(r.id, 10) <= wantHeight) || fullLadder[fullLadder.length - 1] : null;
  // Already at or below the chosen quality? Then the original is the better stream.
  const needsDownscale = !!fixedRung && (classHeight(media.video) > parseInt(fixedRung.id, 10) * 1.05 || (media.bitrate || 0) > fixedRung.bitrate * 1.5);
  if (needsDownscale) reasons.push(`${fixedRung.id} selected`);

  // Bandwidth budget. A user-picked quality ("original" or fixed) overrides the connection estimate.
  const userCap = opts.maxBitrate > 0 ? opts.maxBitrate : Infinity;
  const netCap = opts.quality === 'original' || explicitQuality || !(opts.bandwidth > 0) ? Infinity : opts.bandwidth * 0.85;
  const budget = Math.min(userCap, netCap);
  // Files have peaks well above their average bitrate; leave headroom.
  const fits = (media.bitrate || 0) * 1.2 <= budget;
  if (!fits) reasons.push(`file peaks (~${((media.bitrate * 1.2) / 1e6).toFixed(1)} Mbps) are too high for the ${(budget / 1e6).toFixed(1)} Mbps available`);

  let mode;
  if (opts.forceMode === 'transcode' || burn || !vOk || !fits || needsDownscale) mode = 'transcode';
  else if (opts.forceMode === 'remux') mode = 'remux';
  else if (containerOk && audioOk && audioIsFirst) mode = 'direct';
  else mode = 'remux';

  if (mode === 'remux' && !caps.progressiveRemux) {
    // Safari can't play an unbounded progressive stream; give it HLS instead.
    mode = 'transcode';
    reasons.push('this browser needs HLS for converted streams');
  }

  if (mode === 'remux') {
    if (!containerOk) reasons.push(`${media.container.toUpperCase()} container isn't playable directly – repackaging`);
    if (!audioOk) reasons.push(`${audio.codec} audio isn't supported – converting audio only`);
    else if (!audioIsFirst) reasons.push('alternate audio track selected');
  }

  // Which renditions to offer when converting: the fixed one, the best one for "original"
  // (when the file itself can't be played), or the whole adaptive ladder.
  let ladder = null;
  const lock = mode === 'transcode' ? fixedRung || (opts.quality === 'original' ? fullLadder[0] : null) : null;
  if (lock) ladder = [lock];
  else if (mode === 'transcode') {
    // Only the renditions this connection can actually carry…
    const fit = fullLadder.filter((r) => r.bitrate * 1.3 <= budget);
    // …and that this server has been able to convert comfortably faster than real time.
    const enc = `${settings.hwaccel}/${levelsFor(settings.hwaccel)[0]}`;
    const fast = fit.filter((r) => {
      const sp = expectedSpeed(media, r.height, enc);
      return sp == null || sp >= 1.3;
    });
    if (fit.length && fast.length < fit.length) {
      const slow = fit.find((r) => !fast.includes(r));
      reasons.push(`this server converts ${slow.id} at only ${expectedSpeed(media, slow.height, enc).toFixed(1)}× real time`);
    }
    const usable = fast.length ? fast : fit.length ? [fit[fit.length - 1]] : [fullLadder[fullLadder.length - 1]];
    // Lots of headroom (home network): a single rendition. Adaptive switching only helps on
    // constrained links; with an on-the-fly encoder every switch costs a fresh encoder start.
    ladder = usable[0].bitrate * 2.5 <= budget ? [usable[0]] : usable;
    if (opts.capHeight) reasons.push(`limited to ${usable[0].id} so the server keeps up`);
  }

  const audioCopy = !!audio && audioOk && MP4_AUDIO.has(audio.codec);
  return {
    mode,
    reasons,
    audio,
    subtitle: sub,
    burnSubtitle: burn ? sub : null,
    audioCopy,
    budget: Number.isFinite(budget) ? budget : null,
    ladder,
    fixed: !!lock,
    qualities: fullLadder,
  };
}
