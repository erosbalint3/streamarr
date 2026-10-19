// Builds ffmpeg argument lists for HLS transcodes and progressive remuxes.
//
// Hardware levels, tried in order when a job fails to produce output:
//   hw       – decode, scale and encode on the GPU (fastest)
//   hybrid   – CPU decode/filters (tone mapping, subtitle burn-in), GPU encode
//   software – libx264 everywhere (always works)

/** HDR -> SDR tone mapping on the CPU. Input colour params are explicit so untagged streams still work. */
export function tonemapFilter(hdr) {
  const tin = hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084';
  return `setparams=color_trc=${tin}:color_primaries=bt2020:colorspace=bt2020nc:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv`;
}

export function levelsFor(hwaccel) {
  if (hwaccel === 'vaapi' || hwaccel === 'nvenc') return ['hw', 'hybrid', 'software'];
  return ['software'];
}

function h264Level(height, fps) {
  if (height > 1440) return '5.1';
  if (height > 1080 || fps > 40) return '4.2';
  return '4.1';
}

/**
 * Video part of a transcode. Returns { input: [...], filter: '...', output: [...] }.
 * The filter graph always ends at label [vout].
 */
function videoArgs({ media, rendition, burn, level, settings, segmentSeconds }) {
  const v = media.video;
  const tonemap = !!v.hdr;
  const deint = !!v.interlaced;
  const { width: W, height: H, bitrate } = rendition;
  const rate = [`-b:v`, `${bitrate}`, `-maxrate`, `${Math.round(bitrate * 1.3)}`, `-bufsize`, `${Math.round(bitrate * 2)}`];
  const gop = ['-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`];
  const lvl = h264Level(H, v.fps || 24);
  const subIn = burn ? `[0:${burn.index}]` : null;

  const cpuChain = (outFmt) => {
    const steps = [];
    if (deint) steps.push('bwdif=mode=send_frame:parity=auto:deint=all');
    const pre = steps.length ? `[0:v:0]${steps.join(',')}[base];` : '';
    const baseLabel = steps.length ? '[base]' : '[0:v:0]';
    let g = pre;
    let cur = baseLabel;
    if (subIn) {
      g += `${cur}${subIn}overlay=eof_action=pass:repeatlast=0[ovl];`;
      cur = '[ovl]';
    }
    const post = [`scale=${W}:${H}:flags=bicubic`];
    if (tonemap) post.push(tonemapFilter(v.hdr));
    post.push(`format=${outFmt}`);
    return `${g}${cur}${post.join(',')}`;
  };

  if (settings.hwaccel === 'vaapi' && level !== 'software') {
    const dev = settings.vaapiDevice || '/dev/dri/renderD128';
    const enc = ['-c:v', 'h264_vaapi', '-profile:v', 'high', '-level', lvl, ...rate, ...gop, '-g', '600'];
    if (level === 'hw' && !burn) {
      const steps = [];
      if (deint) steps.push('deinterlace_vaapi');
      if (tonemap) steps.push('tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709');
      steps.push(`scale_vaapi=w=${W}:h=${H}:format=nv12`);
      return {
        input: ['-hwaccel', 'vaapi', '-hwaccel_device', dev, '-hwaccel_output_format', 'vaapi'],
        filter: `[0:v:0]${steps.join(',')}[vout]`,
        output: enc,
      };
    }
    // hw level with burn-in: GPU decode, CPU overlay, GPU encode. hybrid level: CPU decode, GPU encode.
    return {
      input: [...(level === 'hw' ? ['-hwaccel', 'vaapi', '-hwaccel_device', dev] : []), '-init_hw_device', `vaapi=va:${dev}`, '-filter_hw_device', 'va'],
      filter: `${cpuChain('nv12')},hwupload[vout]`,
      output: enc,
    };
  }

  if (settings.hwaccel === 'nvenc' && level !== 'software') {
    const enc = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-profile:v', 'high', '-level', lvl, ...rate, ...gop, '-forced-idr', '1', '-g', '600', '-bf', '2'];
    if (level === 'hw' && !burn && !tonemap && !deint) {
      return {
        input: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
        filter: `[0:v:0]scale_cuda=${W}:${H}:format=yuv420p[vout]`,
        output: enc,
      };
    }
    // GPU decode is still used in hybrid mode (frames are copied back for CPU filters).
    // hw level: GPU decode, frames copied back for CPU filters. hybrid level: CPU decode, GPU encode.
    return {
      input: level === 'hw' ? ['-hwaccel', 'cuda'] : [],
      filter: `${cpuChain('yuv420p')}[vout]`,
      output: enc,
    };
  }

  return {
    input: [],
    filter: `${cpuChain('yuv420p')}[vout]`,
    output: [
      '-c:v', 'libx264',
      '-preset', settings.transcodePreset || 'veryfast',
      '-profile:v', 'high',
      '-level:v', lvl,
      ...rate,
      ...gop,
      '-g', '600',
      '-x264-params', 'rc-lookahead=20:ref=3',
    ],
  };
}

function audioArgs(audio, { copy = false, stereo = true } = {}) {
  if (!audio) return ['-an'];
  const map = ['-map', `0:${audio.index}`];
  if (copy) return [...map, '-c:a', 'copy'];
  const channels = stereo ? 2 : Math.min(audio.channels || 2, 6);
  return [...map, '-c:a', 'aac', '-ac', String(channels), '-b:a', String(channels > 2 ? 384000 : 192000), '-ar', '48000'];
}

/** Arguments for an on-demand HLS job starting at segment `startSegment`. */
export function hlsArgs({ media, rendition, audio, burn, level, settings, startSegment, segmentSeconds, outDir }) {
  const start = startSegment * segmentSeconds;
  const v = videoArgs({ media, rendition, burn, level, settings, segmentSeconds });
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    ...v.input,
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    '-i', media.path,
    '-filter_complex', v.filter,
    '-map', '[vout]',
    ...v.output,
    ...audioArgs(audio, { stereo: settings.stereoDownmix !== false }),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    ...(start > 0 ? ['-output_ts_offset', start.toFixed(3)] : []),
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_list_size', '0',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', 'temp_file+independent_segments',
    '-start_number', String(startSegment),
    '-hls_segment_filename', `${outDir}/seg_%d.ts`,
    '-progress', 'pipe:1', '-stats_period', '1',
    `${outDir}/ffmpeg.m3u8`,
  ];
}

/** Progressive fragmented-MP4 remux: video is copied, so it runs at disk speed. */
export function remuxArgs({ media, audio, audioCopy, offset, stereo }) {
  const v = media.video;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...(offset > 0 ? ['-ss', (offset + 0.001).toFixed(3)] : []),
    '-i', media.path,
    '-map', `0:${v.index}`,
    '-c:v', 'copy',
    ...(v.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    // Blu-ray H.264 re-sends its picture parameter sets mid-stream with different values. The MP4
    // init segment only carries the first set, and strict hardware decoders (macOS VideoToolbox:
    // PIPELINE_ERROR_DECODE -12909) reject the stream when they change. This makes them consistent
    // without touching the picture (decoded frames are bit-identical).
    ...(v.codec === 'h264' ? ['-bsf:v', 'h264_redundant_pps'] : []),
    ...audioArgs(audio, { copy: audioCopy, stereo }),
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-max_muxing_queue_size', '4096',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '2000000',
    '-f', 'mp4', 'pipe:1',
  ];
}

export function codecString(rendition) {
  const lvl = rendition.height > 1440 ? '33' : rendition.height > 1080 ? '2a' : '29';
  return `avc1.6400${lvl},mp4a.40.2`;
}
