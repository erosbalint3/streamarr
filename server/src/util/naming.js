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

// ------------------------------------------------------------------ mixed folders (e.g. torrent downloads)
//
// One folder holding movies and episodes side by side, in whatever layout the release used:
//   The.Bear.S03E01.1080p.WEB.h264-ETHEL.mkv                      loose episode
//   The.Bear.S03E01.1080p.WEB.h264-ETHEL/abc123.mkv               folder per episode, any file name
//   The.Bear.S03.1080p.WEB.h264-ETHEL/The.Bear.S03E02....mkv      season pack
//   Shogun (2024) Season 1/01 - Anjin.mkv                         season folder, numbered files
//   Breaking Bad Complete Series/Season 2/Breaking Bad 2x03.mkv   series pack
//   [SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv              anime, absolute numbering
//   Dune.Part.Two.2024.2160p.WEB-DL/Dune.Part.Two.2024....mkv     a movie

const SEASON_DIR = /^(?:season|series|staffel|saison|temporada|stagione)[ ._-]*(\d{1,3})\b|^s(\d{1,3})$/i;
const SPECIALS_DIR = /^specials?$/i;
// A pack folder name: "Show.S03.1080p", "Show Season 1", "Show Complete Series", "Show S01-S03".
const PACK_TOKEN = /(?:^|[ ._\-([])(?:S(\d{1,3})(?!\d|[ ._-]?E\d)|Season[ ._-]?(\d{1,3})|(?:the[ ._-])?complete(?:[ ._-](?:series|season|collection|show))?\b)/i;
const ANIME = /^\[[^\]]+\][ ._]*(.+?)[ ._]+-[ ._]+(\d{1,4})(?:v\d)?(?=[ ._]|\[|\(|$)/;
const EP_NUM = /(?:^|[ ._\-[])(?:E|EP|Episode|Folge|Episodio)[ ._-]?(\d{1,4})\b/i;
const LEADING_NUM = /^(\d{1,3})(?:[ ._-]|$)/;
const isYear = (n) => n >= 1900 && n <= 2099;

function matchEpisode(name) {
  for (const re of EP_PATTERNS) {
    const m = re.exec(name);
    if (m) return { m, season: Number(m[1]), episode: Number(m[2]), end: m[3] || m[4] ? Number(m[3] || m[4]) : null };
  }
  return null;
}

function matchAnime(name) {
  const m = ANIME.exec(name);
  if (!m || (m[2].length === 4 && isYear(Number(m[2])))) return null;
  return { title: m[1], episode: Number(m[2]), after: name.slice(m.index + m[0].length) };
}

function seasonOfDir(dir) {
  const s = SEASON_DIR.exec(dir);
  if (s) return Number(s[1] ?? s[2]);
  if (SPECIALS_DIR.test(dir)) return 0;
  const p = PACK_TOKEN.exec(dir);
  if (p && (p[1] || p[2])) return Number(p[1] || p[2]);
  return p ? -1 : null; // -1: a pack folder without one season number ("Complete Series")
}

function episodeNumberIn(base) {
  const e = EP_NUM.exec(base);
  if (e) return { episode: Number(e[1]), after: base.slice(e.index + e[0].length) };
  const l = LEADING_NUM.exec(base);
  if (l && !isYear(Number(l[1]))) return { episode: Number(l[1]), after: base.slice(l[0].length) };
  return null;
}

/** Key that groups releases of one show however they spell it ("Marvel's Daredevil" = "Marvels.Daredevil"). */
export function showKeyOf(title) {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Show title from a folder like "The.Bear.S03.1080p.WEB" or "Shogun (2024) Season 1". */
function titleFromPackDir(dir) {
  const ep = matchEpisode(dir);
  let s = ep ? dir.slice(0, ep.m.index) : dir;
  const p = PACK_TOKEN.exec(s);
  if (p && p.index > 0) s = s.slice(0, p.index);
  return parseMovieName(s);
}

/**
 * Classify a file in a mixed folder. Returns the episode fields for TV episodes, null for movies.
 * `root` is the library folder the file was found in.
 */
export function parseMixed(file, root) {
  const base = path.basename(file, path.extname(file));
  const dirs = path.relative(root, file).split(path.sep).slice(0, -1);
  const parent = dirs[dirs.length - 1] || '';

  let season = null;
  let episode = null;
  let episodeEnd = null;
  let titleRaw = '';
  let after = '';

  const inName = matchEpisode(base);
  const anime = !inName && matchAnime(base);
  const inParent = !inName && !anime && parent && matchEpisode(parent);
  if (inName) {
    ({ season, episode, end: episodeEnd } = inName);
    titleRaw = base.slice(0, inName.m.index);
    after = base.slice(inName.m.index + inName.m[0].length);
  } else if (anime) {
    season = 1;
    episode = anime.episode;
    titleRaw = anime.title;
    after = anime.after;
  } else if (inParent) {
    // Folder per episode with an unhelpful file name ("abc123.mkv").
    ({ season, episode, end: episodeEnd } = inParent);
    titleRaw = parent.slice(0, inParent.m.index);
  } else {
    // Inside a season or pack folder, with a numbered file name ("01 - Pilot.mkv", "E05.mkv").
    const packSeason = dirs.map(seasonOfDir).filter((s) => s != null);
    const num = packSeason.length ? episodeNumberIn(base) : null;
    if (!num) return null;
    const known = packSeason.filter((s) => s >= 0);
    season = known.length ? known[known.length - 1] : 1;
    episode = num.episode;
    after = num.after;
  }

  // Show title: the text before SxxEyy, else the nearest folder that names the show.
  let show = titleRaw && cleanSeparators(titleRaw).replace(/[\s\-–:]+$/, '').length >= 1 ? parseMovieName(titleRaw.replace(/^\[[^\]]*\][ ._]*/, '')) : null;
  if (show && !show.title.replace(/[\W_]+/g, '')) show = null;
  let showDir = null;
  for (let i = dirs.length - 1; i >= 0 && !show?.title; i--) {
    if (SEASON_DIR.test(dirs[i]) || SPECIALS_DIR.test(dirs[i])) continue;
    const t = titleFromPackDir(dirs[i]);
    if (t.title) {
      show = t;
      if (!matchEpisode(dirs[i])) showDir = path.join(root, ...dirs.slice(0, i + 1));
    }
  }
  if (!show?.title) show = parseMovieName(base);
  // A show folder ("Shogun (2024)/Season 1/...") may carry poster.jpg etc.
  if (!showDir && dirs.length > 1 && !matchEpisode(dirs[0]) && showKeyOf(titleFromPackDir(dirs[0]).title) === showKeyOf(show.title)) {
    showDir = path.join(root, dirs[0]);
  }

  let episodeTitle = stripJunk(cleanSeparators(after.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')), true).replace(/^[\s\-–:]+/, '') || null;
  if (episodeTitle && !/[a-z]/i.test(episodeTitle)) episodeTitle = null;

  return {
    showKey: `show:${showKeyOf(show.title)}`,
    showTitle: show.title,
    showYear: show.year,
    showDir,
    season,
    episode: episode ?? 0,
    episodeEnd,
    episodeTitle,
  };
}

export function isSample(file) {
  return /(^|[\\/._ -])sample([\\/._ -]|$)/i.test(path.basename(file)) || /[\\/]samples?[\\/]/i.test(file);
}
