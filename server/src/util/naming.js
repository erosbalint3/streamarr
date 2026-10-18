import path from 'node:path';

export const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.avi', '.webm', '.ts', '.m2ts', '.mts', '.wmv', '.flv', '.mpg', '.mpeg', '.ogv', '.3gp', '.divx']);

// Tokens that mark the end of a human title in scene-style release names.
const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?\+?|hdr|dv|dovi|sdr|bluray|blu-ray|bdrip|brrip|bdremux|remux|web[-. ]?dl|webrip|web|hdtv|dvdrip|dvd|hdrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|aac\d?(\.\d)?|ac3|eac3|ddp?\d?(\.\d)?|dts(-hd)?|truehd|atmos|flac|10bit|8bit|proper|repack|extended|unrated|remastered|imax|multi|dual[- ]audio|subbed|dubbed|nf|amzn|dsnp|hmax|atvp)\b/i;

function cleanSeparators(s) {
  // Release names use dots/underscores as spaces; keep dots in things like "Mr. Robot" when real spaces exist.
  if (!/\s/.test(s) || /[._]{1}\S+[._]\S+[._]/.test(s)) s = s.replace(/[._]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function stripJunk(s, allowEmpty = false) {
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ');
  const m = JUNK.exec(s);
  if (m && (m.index > 0 || allowEmpty)) s = s.slice(0, m.index);
  return s.replace(/[\s\-–(]+$/, '').trim();
}

export function sortTitle(title) {
  return title.replace(/^(the|a|an)\s+/i, '').toLowerCase();
}

/** "The.Matrix.1999.1080p.BluRay.x264" -> { title: 'The Matrix', year: 1999 } */
export function parseMovieName(name) {
  let s = cleanSeparators(name);
  let year = null;
  const yearRe = /[([]?\b(19[0-9]{2}|20[0-9]{2})\b[)\]]?/g;
  let match;
  let last = null;
  while ((match = yearRe.exec(s))) {
    if (match.index > 0) last = match;
  }
  if (last) {
    year = Number(last[1]);
    s = s.slice(0, last.index).replace(/\[[^\]]*\]/g, ' ').replace(/[\s\-–(]+$/, '').trim();
  } else s = stripJunk(s);
  return { title: s || name, year };
}

const EP_PATTERNS = [
  /\bS(\d{1,3})[ ._-]?E(\d{1,4})(?:-?E(\d{1,4})|-(\d{1,3})\b)?/i, // S01E02, S01E02E03, S01E02-03
  /\b(\d{1,2})x(\d{2,3})\b/i, // 1x02
  /\bSeason[ ._-]?(\d{1,3})[ ._-]*Episode[ ._-]?(\d{1,4})/i,
];

export function parseEpisode(file, libraryRoot) {
  const base = path.basename(file, path.extname(file));
  const rel = path.relative(libraryRoot, file);
  const parts = rel.split(path.sep);
  const showFolder = parts.length > 1 ? parts[0] : null;

  let season = null;
  let episode = null;
  let episodeEnd = null;
  let titleAfter = '';
  let showFromFile = '';

  for (const re of EP_PATTERNS) {
    const m = re.exec(base);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      episodeEnd = m[3] || m[4] ? Number(m[3] || m[4]) : null;
      showFromFile = base.slice(0, m.index);
      titleAfter = base.slice(m.index + m[0].length);
      break;
    }
  }

  // Season from folder name ("Season 2", "S02", "Specials")
  if (season == null && parts.length > 2) {
    const folder = parts[parts.length - 2];
    const sm = /(?:season|series|s)[ ._-]?(\d{1,3})/i.exec(folder);
    if (sm) season = Number(sm[1]);
    else if (/specials?/i.test(folder)) season = 0;
  }
  if (episode == null) {
    const em = /(?:\bE|\bEp|\bEpisode|^)[ ._-]?(\d{1,4})\b/i.exec(base);
    if (em) {
      episode = Number(em[1]);
      titleAfter = base.slice(em.index + em[0].length);
    }
  }
  if (season == null) season = 1;

  const showTitleRaw = showFolder || showFromFile || base;
  const show = parseMovieName(showTitleRaw);
  let epTitle = stripJunk(cleanSeparators(titleAfter), true).replace(/^[\s\-–:]+/, '');
  if (!epTitle) epTitle = null;

  return {
    showKey: showFolder ? path.join(libraryRoot, showFolder) : path.join(libraryRoot, `__${show.title.toLowerCase()}`),
    showTitle: show.title,
    showYear: show.year,
    season,
    episode: episode ?? 0,
    episodeEnd,
    episodeTitle: epTitle,
  };
}

export function isSample(file) {
  return /(^|[\\/._ -])sample([\\/._ -]|$)/i.test(path.basename(file)) || /[\\/]samples?[\\/]/i.test(file);
}
