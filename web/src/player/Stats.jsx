import { useEffect, useState } from 'react';
import { formatBitrate } from '../api.js';
import { IconClose } from '../components/Icons.jsx';

const MODE = {
  direct: ['Direct play', 'The original file, untouched. Zero server load, best possible quality.'],
  remux: ['Direct stream', 'Original video, repackaged on the fly. Quality is identical to the file.'],
  transcode: ['Adaptive streaming', 'Converted to an adaptive ladder; quality follows your connection so playback doesn\'t stall.'],
};

export default function Stats({ data, pb, server, level, onClose }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const v = data.source.video;
  const q = pb?.video?.getVideoPlaybackQuality?.();
  const buffer = pb?.bufferedAhead() || 0;
  const bw = pb?.hls?.bandwidthEstimate || pb?.bandwidth;
  const t = server?.transcode;
  const [title, desc] =
    data.mode === 'transcode' && data.fixedQuality
      ? ['Converted', `Converted to the fixed ${data.renditions[0].id} quality you picked. Quality won't change on its own.`]
      : data.mode === 'transcode' && data.renditions.length === 1
        ? ['Converted', `Converted at ${data.renditions[0].id}, the best quality for your connection. Steps down automatically only if the server can't keep up.`]
        : MODE[data.mode];

  const rows = [
    ['Source', `${data.source.container?.toUpperCase()} · ${v.codec} ${v.width}×${v.height}${v.hdr ? ` ${v.hdr.toUpperCase()}` : ''} · ${formatBitrate(data.source.bitrate)}`],
    ['Video out', data.mode === 'transcode' ? (level || data.fixedQuality ? `H.264 ${(level || data.renditions[0]).width}×${(level || data.renditions[0]).height} · ${formatBitrate((level || data.renditions[0]).bitrate)}` : 'Selecting…') : `${v.codec} (original)`],
    ['Audio out', data.source.audio ? (data.mode === 'direct' || data.source.audio.copy && data.mode === 'remux' ? `${data.source.audio.codec} ${data.source.audio.channels}ch (original)` : `AAC (converted from ${data.source.audio.codec})`) : 'None'],
    ['Connection', bw ? `${formatBitrate(bw)} estimated` : 'Measuring…'],
    ['Buffer ahead', `${buffer.toFixed(0)} s`],
    ['Stalls', String(pb?.stalls ?? 0)],
    ['Dropped frames', q ? `${q.droppedVideoFrames} of ${q.totalVideoFrames}` : '—'],
  ];
  if (t) {
    rows.push(['Encoder', `${t.level === 'software' ? 'CPU (libx264)' : t.level === 'hw' ? 'GPU' : 'GPU + CPU filters'} · ${t.speed ? `${t.speed.toFixed(1)}× real time` : 'starting'}`]);
    rows.push(['Encoded ahead', `${Math.round(t.aheadSeconds)} s${t.throttled ? ' (paused – far enough ahead)' : ''}`]);
  }

  return (
    <aside className="stats" aria-label="Playback info">
      <header>
        <strong>{title}</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close playback info">
          <IconClose size={18} />
        </button>
      </header>
      <p className="stats-desc">{desc}</p>
      {data.reasons.length > 0 && (
        <ul className="stats-reasons">
          {data.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <dl>
        {rows.map(([k, val]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
