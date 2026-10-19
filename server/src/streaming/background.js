import { all, getSettings } from '../db.js';
import { enqueue } from '../tasks.js';
import { parseMedia } from './media.js';
import { generateTrickplay } from './trickplay.js';
import { extractAll } from './subtitles.js';
import { resolveImage } from '../images.js';

/**
 * Make sure every movie/show/video has its poster and backdrop on disk (downloaded from TMDB,
 * or a frame grabbed from the video) before anyone opens the library.
 */
export function queueArtwork() {
  // Newest first: shows get updated_at bumped when episodes are added.
  const rows = all(`SELECT id, title FROM items WHERE type IN ('movie','show','video') ORDER BY updated_at DESC`);
  for (const r of rows) {
    enqueue(`art:${r.id}`, `Artwork: ${r.title}`, async () => {
      for (const kind of ['poster', 'backdrop']) await resolveImage(r.id, kind).catch(() => null);
    }, { priority: true });
  }
}

/** Queue low-priority prep work for newly scanned items (or everything missing it when ids is null). */
export function queueBackgroundWork(itemIds = null) {
  const settings = getSettings();
  const rows = itemIds
    ? itemIds.length
      ? all(`SELECT * FROM media_files WHERE item_id IN (${itemIds.map(() => '?').join(',')})`, ...itemIds)
      : []
    : all('SELECT * FROM media_files');
  for (const row of rows) {
    const media = parseMedia(row);
    if (settings.extractSubtitles && media.subtitles.some((s) => s.text && !s.external)) {
      enqueue(`subs:${media.id}:${media.mtime}`, `Extract subtitles (${media.id})`, () => extractAll(media));
    }
    if (settings.trickplay && !row.trickplay) {
      enqueue(`trick:${media.id}`, `Trickplay (${media.id})`, () => generateTrickplay(media));
    }
  }
}
