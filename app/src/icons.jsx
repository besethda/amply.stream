/**
 * The icon set. Line icons on a 24px grid, drawn in currentColor, so a button's
 * colour is its icon's colour. Every icon-only button still carries an
 * aria-label: the icon is for the eye, the label for everyone else.
 */
const S = ({ size = 20, sw = 2, fill = "none", children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={fill === "none" ? "currentColor" : "none"}
    stroke-width={sw} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const Icon = {
  home: (p) => <S sw={1.9} {...p}><path d="M4 11l8-7 8 7v8a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z" /></S>,
  library: (p) => <S sw={1.9} {...p}><path d="M5 5v14M10 5v14M15.5 6.5l3.5 12.2" /></S>,
  you: (p) => <S sw={1.9} {...p}><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20a7 7 0 0114 0" /></S>,
  plus: (p) => <S sw={2.2} {...p}><path d="M12 5v14M5 12h14" /></S>,
  back: (p) => <S sw={2.3} {...p}><path d="M15 6l-6 6 6 6" /></S>,
  down: (p) => <S sw={2.2} {...p}><path d="M6 10l6 6 6-6" /></S>,
  chevron: (p) => <S sw={2.2} {...p}><path d="M9 6l6 6-6 6" /></S>,
  close: (p) => <S sw={2.2} {...p}><path d="M6 6l12 12M18 6L6 18" /></S>,
  play: (p) => <S fill="currentColor" {...p}><path d="M7 4l13 8-13 8z" /></S>,
  pause: (p) => <S fill="currentColor" {...p}><rect x="6" y="4" width="4" height="16" rx="1.4" /><rect x="14" y="4" width="4" height="16" rx="1.4" /></S>,
  next: (p) => <S fill="currentColor" {...p}><path d="M5 4l11 8-11 8z" /><rect x="17" y="4" width="2.6" height="16" rx="1" /></S>,
  prev: (p) => <S fill="currentColor" {...p}><path d="M19 4L8 12l11 8z" /><rect x="4.4" y="4" width="2.6" height="16" rx="1" /></S>,
  shuffle: (p) => <S {...p}><path d="M16 4h5v5M21 4l-6.5 6.5M8 20H3v-5M3 20l6.5-6.5M16 20h5v-5M21 20L3 4" /></S>,
  repeat: (p) => <S {...p}><path d="M17 2l4 4-4 4" /><path d="M3 12V9a3 3 0 013-3h15M7 22l-4-4 4-4" /><path d="M21 12v3a3 3 0 01-3 3H3" /></S>,
  heart: (p) => <S sw={1.8} {...p}><path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z" /></S>,
  share: (p) => <S sw={1.9} {...p}><path d="M12 16V4M8 8l4-4 4 4M5 14v5h14v-5" /></S>,
  queue: (p) => <S sw={1.9} {...p}><path d="M4 7h11M4 12h11M4 17h7M19 10v8M15 14h8" /></S>,
  downSmall: (p) => <S sw={2.2} {...p}><path d="M6 10l6 6 6-6" /></S>,
  link: (p) => <S sw={2.1} {...p}><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" /></S>,
  globe: (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a16 16 0 010 18M12 3a16 16 0 000 18" /></S>,
  qr: (p) => <S {...p}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /><rect x="10" y="10" width="4" height="4" /></S>,
  check: (p) => <S sw={2.6} {...p}><path d="M4 12.5l5 5L20 6.5" /></S>,
  warn: (p) => <S {...p}><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></S>,
  key: (p) => <S sw={1.9} {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M18 5l2 2" /></S>,
  card: (p) => <S sw={1.9} {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></S>,
  send: (p) => <S sw={1.9} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></S>,
  sun: (p) => <S sw={1.9} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>,
  moon: (p) => <S sw={1.9} {...p}><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" /></S>,
  trash: (p) => <S sw={1.9} {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></S>,
  eye: (p) => <S sw={1.9} {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></S>,
  refresh: (p) => <S sw={2} {...p}><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" /></S>,
  copy: (p) => <S sw={1.9} {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></S>,
  external: (p) => <S sw={2} {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></S>,
  note: (p) => <S sw={1.6} {...p}><circle cx="12" cy="17" r="3.4" /><path d="M15.4 17V4l5 1.6" /></S>,
  heartOn: (p) => <S fill="currentColor" {...p}><path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z" /></S>,
  more: (p) => <S fill="currentColor" {...p}><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></S>,
  // A coin: tipping.
  tip: (p) => <S sw={1.8} {...p}><circle cx="12" cy="12" r="8.6" /><path d="M14.6 9.3c-.5-.9-1.5-1.4-2.6-1.4-1.5 0-2.6.8-2.6 2 0 2.7 5.3 1.5 5.3 4.3 0 1.2-1.2 2-2.7 2-1.2 0-2.3-.6-2.8-1.5M12 6.4v1.4M12 16.2v1.4" /></S>,
  folder: (p) => <S sw={1.9} {...p}><path d="M3.5 7.5a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z" /></S>,
  edit: (p) => <S sw={1.9} {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></S>,
  playNext: (p) => <S sw={1.9} {...p}><path d="M4 6h10M4 11h10M4 16h6" /><path d="M16 13l5 3-5 3z" fill="currentColor" /></S>,
  artist: (p) => <S sw={1.9} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0116 0" /></S>,
  // The waveform styles, each drawn as a small version of itself.
  ribbons: (p) => <S sw={1.9} {...p}><path d="M3 10c2-3.5 4-3.5 6 0s4 3.5 6 0 4-3.5 6 0" /><path d="M3 15c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0" /></S>,
  boxes: (p) => <S fill="currentColor" {...p}>
    <rect x="2" y="15" width="5.5" height="5.5" rx="1.2" /><rect x="2" y="8.5" width="5.5" height="5.5" rx="1.2" />
    <rect x="9.25" y="15" width="5.5" height="5.5" rx="1.2" /><rect x="9.25" y="8.5" width="5.5" height="5.5" rx="1.2" /><rect x="9.25" y="2" width="5.5" height="5.5" rx="1.2" />
    <rect x="16.5" y="15" width="5.5" height="5.5" rx="1.2" />
  </S>,
  hills: (p) => <S fill="currentColor" {...p}><path d="M2 19c2.5-6 4.5-9 7-9 2 0 3 3 4.5 3S16 8 18.5 8 21 13 22 19z" opacity=".9" /></S>,
  help: (p) => <S sw={1.9} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 .5c0 1.8-2.5 2-2.5 4M12 17h.01" /></S>,
};

/** Amply's mark: two notes and a waveform. */
export const Logo = ({ size = 22 }) => (
  <svg width={size} height={size} viewBox="0 0 500 500" aria-hidden="true">
    <g fill="#f6711e">
      <circle cx="117" cy="355" r="71" /><circle cx="357" cy="355" r="71" />
      <rect x="181" y="68" width="11" height="290" rx="5" /><rect x="421" y="128" width="11" height="230" rx="5" />
      <rect x="216" y="93" width="9" height="152" rx="4" /><rect x="253" y="119" width="9" height="102" rx="4" />
      <rect x="301" y="55" width="10" height="190" rx="5" /><rect x="338" y="99" width="9" height="130" rx="4" />
      <rect x="389" y="72" width="9" height="168" rx="4" />
    </g>
  </svg>
);
