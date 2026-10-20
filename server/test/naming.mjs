// Mixed-folder (torrent downloads) classification test:  node server/test/naming.mjs
import { parseMixed } from '../src/util/naming.js';

const root = '/downloads';
// [path under root, expected: null = movie, or [show title, season, episode, episode title?]]
const cases = [
  ['The.Bear.S03E01.1080p.WEB.h264-ETHEL.mkv', ['The Bear', 3, 1, null]],
  ['The.Bear.S03E04.1080p.WEB.h264-ETHEL/abc123def.mkv', ['The Bear', 3, 4, null]],
  ['The.Bear.S03.1080p.WEB.h264-ETHEL/The.Bear.S03E02.1080p.WEB.h264-ETHEL.mkv', ['The Bear', 3, 2, null]],
  ['Shogun (2024) Season 1/01 - Anjin.mkv', ['Shogun', 1, 1, 'Anjin']],
  ['Shogun.2024.S01E03.Tomorrow.Is.Tomorrow.2160p.DSNP.WEB-DL.DDP5.1.H.265-NTb.mkv', ['Shogun', 1, 3, 'Tomorrow Is Tomorrow']],
  ['Breaking Bad Complete Series/Season 2/Breaking Bad 2x03.mkv', ['Breaking Bad', 2, 3, null]],
  ['Breaking Bad Complete Series/Season 5/05 - Dead Freight.mkv', ['Breaking Bad', 5, 5, 'Dead Freight']],
  ['[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv', ['Sousou no Frieren', 1, 5, null]],
  ['[Erai-raws] One Piece - 1100 [1080p][Multiple Subtitle].mkv', ['One Piece', 1, 1100, null]],
  ['Friends.S01-S10.Complete.1080p.BluRay/Season 5/Friends.S05E14.The.One.Where.Everybody.Finds.Out.mkv', ['Friends', 5, 14, 'The One Where Everybody Finds Out']],
  ['Some.Show.S02.1080p.WEB/E05.mkv', ['Some Show', 2, 5, null]],
  ['Planet.Earth.II.S01E01.Islands.2160p.UHD.BluRay.x265.mkv', ['Planet Earth II', 1, 1, 'Islands']],
  ['1923.S01E01.1080p.WEB.H264.mkv', ['1923', 1, 1, null]],
  ['Doctor.Who.2005.S01E01.Rose.mkv', ['Doctor Who', 1, 1, 'Rose']],
  ["Marvel's Daredevil - S01E02 - Cut Man.mkv", ["Marvel's Daredevil", 1, 2, 'Cut Man']],
  ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv', null],
  ['Oppenheimer (2023) [1080p] [BluRay] [5.1] [YTS.MX]/Oppenheimer.2023.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4', null],
  ['Blade Runner 2049 (2017)/Blade.Runner.2049.2017.2160p.mkv', null],
  ['The Matrix (1999).mkv', null],
  ['Avatar.The.Way.of.Water.2022.1080p.WEB.mkv', null],
  ['[YTS.MX] Past Lives - 2023 (1080p).mp4', null],
  ['2001.A.Space.Odyssey.1968.1080p.mkv', null],
];

let failed = 0;
for (const [rel, want] of cases) {
  const got = parseMixed(`${root}/${rel}`, root);
  const shown = got ? [got.showTitle, got.season, got.episode, got.episodeTitle] : null;
  const ok = JSON.stringify(shown) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${rel}\n       → ${got ? `${got.showTitle} (${got.showYear ?? '-'}) S${got.season}E${got.episode}${got.episodeTitle ? ` "${got.episodeTitle}"` : ''} [${got.showKey}]` : 'movie'}${ok ? '' : `   expected ${JSON.stringify(want)}`}`);
}
const keys = new Set(['Marvels.Daredevil.S01E01.mkv', "Marvel's Daredevil - S01E02 - Cut Man.mkv"].map((f) => parseMixed(`${root}/${f}`, root).showKey));
if (keys.size !== 1) {
  failed++;
  console.log('FAIL spelling variants of one show got different keys', [...keys]);
} else console.log('ok   spelling variants share one show key');
if (failed) {
  console.error(`${failed} naming case(s) failed`);
  process.exit(1);
}
