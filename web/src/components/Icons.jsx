// Small inline icon set (24px grid, stroke-based) so the app has no icon-font dependency.
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

const make = (paths, filled = false) =>
  function Icon({ size = 22, ...props }) {
    return (
      <svg {...base} width={size} height={size} {...(filled ? { fill: 'currentColor', stroke: 'none' } : {})} {...props}>
        {paths}
      </svg>
    );
  };

export const IconPlay = make(<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l12-7.2a1 1 0 0 0 0-1.72l-12-7.2A1 1 0 0 0 7 4.8z" />, true);
export const IconPause = make(
  <>
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </>,
  true
);
export const IconBack10 = make(
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4v4.5h4.5" />
    <text x="12" y="15.6" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="sans-serif">10</text>
  </>
);
export const IconFwd10 = make(
  <>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
    <path d="M21 4v4.5h-4.5" />
    <text x="12" y="15.6" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="sans-serif">10</text>
  </>
);
export const IconVolume = make(
  <>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </>
);
export const IconMute = make(
  <>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </>
);
export const IconFullscreen = make(<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />);
export const IconExitFullscreen = make(<path d="M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4" />);
export const IconSubtitles = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 13h4M13 13h4M7 16h7" />
  </>
);
export const IconAudio = make(
  <>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </>
);
export const IconGauge = make(
  <>
    <path d="M4.5 17a8.5 8.5 0 1 1 15 0" />
    <path d="m12 13 4-5" />
    <circle cx="12" cy="13" r="1.3" fill="currentColor" />
  </>
);
export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </>
);
export const IconPip = make(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <rect x="12" y="11.5" width="6.5" height="5" rx="1" fill="currentColor" stroke="none" />
  </>
);
export const IconArrowLeft = make(<path d="M15 5 8 12l7 7" />);
export const IconChevronLeft = make(<path d="m14.5 6-6 6 6 6" />);
export const IconChevronRight = make(<path d="m9.5 6 6 6-6 6" />);
export const IconChevronDown = make(<path d="m6 9.5 6 6 6-6" />);
export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </>
);
export const IconCheck = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconClose = make(<path d="M6 6l12 12M18 6 6 18" />);
export const IconRefresh = make(
  <>
    <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
    <path d="M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16" />
    <path d="M20 20v-4h-4" />
  </>
);
export const IconFolder = make(<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" />);
export const IconTrash = make(<path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5" />);
export const IconUser = make(
  <>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </>
);
export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </>
);
export const IconNext = make(
  <>
    <path d="M5 5.5v13a.8.8 0 0 0 1.2.7l10-6.5a.8.8 0 0 0 0-1.4l-10-6.5A.8.8 0 0 0 5 5.5z" fill="currentColor" stroke="none" />
    <path d="M19 5v14" strokeWidth="2.2" />
  </>
);
export const IconBookmark = make(<path d="M6.5 4.5h11v15.5L12 16l-5.5 4z" />);
export const IconBookmarkFilled = make(<path d="M6.5 4.5h11v15.5L12 16l-5.5 4z" fill="currentColor" />);
export const IconEye = make(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </>
);
export const IconLogout = make(<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 16.5 5.5 12 10 7.5M5.5 12H15" />);
export const IconPulse = make(<path d="M3 12h4l2.5-6 5 12 2.5-6h4" />);
