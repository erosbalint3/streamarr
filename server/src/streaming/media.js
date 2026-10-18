import { get, json } from '../db.js';

export function parseMedia(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.item_id,
    path: row.path,
    size: row.size,
    mtime: row.mtime,
    container: row.container,
    duration: row.duration || 0,
    bitrate: row.bitrate || 0,
    video: json(row.video, null),
    audio: json(row.audio, []),
    subtitles: json(row.subtitles, []),
    chapters: json(row.chapters, []),
    trickplay: json(row.trickplay, null),
  };
}

export function mediaForItem(itemId) {
  return parseMedia(get('SELECT * FROM media_files WHERE item_id = ?', itemId));
}

const LANGS = {
  eng: 'English', en: 'English', hun: 'Hungarian', hu: 'Hungarian', ger: 'German', deu: 'German', de: 'German', fre: 'French', fra: 'French', fr: 'French',
  spa: 'Spanish', es: 'Spanish', ita: 'Italian', it: 'Italian', jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese',
  zh: 'Chinese', rus: 'Russian', ru: 'Russian', por: 'Portuguese', pt: 'Portuguese', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch', pol: 'Polish', pl: 'Polish',
  swe: 'Swedish', sv: 'Swedish', nor: 'Norwegian', no: 'Norwegian', dan: 'Danish', da: 'Danish', fin: 'Finnish', fi: 'Finnish', cze: 'Czech', ces: 'Czech',
  cs: 'Czech', slo: 'Slovak', slk: 'Slovak', sk: 'Slovak', rum: 'Romanian', ron: 'Romanian', ro: 'Romanian', tur: 'Turkish', tr: 'Turkish', gre: 'Greek',
  ell: 'Greek', el: 'Greek', ara: 'Arabic', ar: 'Arabic', heb: 'Hebrew', he: 'Hebrew', hin: 'Hindi', hi: 'Hindi', tha: 'Thai', th: 'Thai', ukr: 'Ukrainian',
  uk: 'Ukrainian', hrv: 'Croatian', hr: 'Croatian', srp: 'Serbian', sr: 'Serbian', bul: 'Bulgarian', bg: 'Bulgarian', vie: 'Vietnamese', vi: 'Vietnamese',
  ind: 'Indonesian', id: 'Indonesian',
};

export const languageName = (code) => (code ? LANGS[code.toLowerCase()] || code.toUpperCase() : null);

const AUDIO_NAMES = { aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'Dolby TrueHD', dts: 'DTS', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM' };
const CHANNELS = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 7: '6.1', 8: '7.1' };

export function audioLabel(a) {
  const parts = [languageName(a.language) || 'Unknown', AUDIO_NAMES[a.codec] || a.codec?.toUpperCase(), CHANNELS[a.channels] || `${a.channels}ch`];
  if (a.title && !/^(stereo|surround|5\.1|2\.0)$/i.test(a.title)) parts.push(`(${a.title})`);
  return parts.filter(Boolean).join(' · ');
}

export function subtitleLabel(s) {
  const parts = [languageName(s.language) || 'Unknown'];
  if (s.forced) parts.push('Forced');
  if (s.title && !/^(forced|full)$/i.test(s.title)) parts.push(s.title);
  if (!s.text) parts.push('burn-in');
  return parts.join(' · ');
}
