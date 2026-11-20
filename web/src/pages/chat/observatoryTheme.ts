// Light "mist" theme for the architecture view: seat inks, state colours, densities and card sizes.
// Canvas painters and CSS read the same values from here so geometry and styling never disagree.

export type Density = 'regular' | 'compact' | 'tiny';
export type Size = { w: number; h: number };

/** Seat inks: mid-tone, outside the slate-indigo gate band, each ≥ 3.2:1 on the stage bottom #e6ebf2. */
export const SEAT_INKS: Record<string, string> = {
  claude: '#aa5131',
  astra: '#17677f',
  sol: '#927315',
  grok: '#68449c',
  opus: '#94344d',
  carbon: '#a05188',
  hydrogen: '#9572ae',
  deepseek: '#0b8274',
  mini: '#728a2f',
};
const INK_LIST = Object.values(SEAT_INKS);

/** Canvas-side state colours; mirrored by the --st-* custom properties in observatory.css. */
export const INK = {
  ink: '#293553',
  ink2: '#475674',
  muted: '#5d6883',
  faint: '#77819a',
  active: '#1f232b',
  done: '#1d7146',
  wait: '#975006',
  waitStroke: '#a35a08',
  waitBar: '#b7781f',
  gate: '#586b99',
  gateInk: '#40527f',
  error: '#b42318',
  idle: '#77819a',
  queued: '#b6bfd0',
  meterOff: '#cfd6e2',
  ghost: '#9aa5bb',
  deep: '#1b2233',
  casing: '#f3f5f9',
} as const;

export const EFFORT_SHORT = ['—', 'LOW', 'MED', 'HIGH', 'XH', 'MAX', 'ULT'];

const DENSITY_COMPACT = 600;
const DENSITY_REGULAR = 980;

export function densityFor(width: number): Density {
  if (width >= DENSITY_REGULAR) return 'regular';
  if (width >= DENSITY_COMPACT) return 'compact';
  return 'tiny';
}

export const CARD: Record<Density, { topology: Size; context: Size }> = {
  regular: { topology: { w: 152, h: 68 }, context: { w: 220, h: 92 } },
  compact: { topology: { w: 132, h: 62 }, context: { w: 188, h: 68 } },
  tiny: { topology: { w: 104, h: 28 }, context: { w: 150, h: 52 } },
};

/** Fibre-width scale: full size on wide stages, never thinner than 60%. */
export function bundleScale(width: number, density: Density) {
  if (density === 'tiny') return 0.6;
  return Math.min(1, Math.max(0.62, width / 1200));
}

/** Half-width of a fibre bundle for an effort level 0–6 (0 = unknown). */
export function bundleHalfWidth(level: number, scale: number) {
  return (level ? 2.6 + 1.9 * level : 2.4) * scale;
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255];
}

export function mix(from: string, to: string, amount: number) {
  const a = channels(from);
  const b = channels(to);
  return '#' + a.map((channel, index) => Math.round(channel + (b[index] - channel) * amount).toString(16).padStart(2, '0')).join('');
}

export function rgba(hex: string, alpha: number) {
  const [r, g, b] = channels(hex);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

/** Stable ink per seat id. Unknown seats get a darkened palette ink chosen by hash, never grey or the gate colour. */
export function seatInk(id: string) {
  return SEAT_INKS[id] ?? mix(INK_LIST[fnv1a(id) % INK_LIST.length], INK.deep, 0.22);
}

/** The darker fibre colour that carries the ≥ 3:1 stroke contrast. */
export function coreInk(seat: string) {
  return mix(seat, INK.deep, 0.18);
}

function luminance(hex: string) {
  const linear = channels(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio between two opaque hex colours. */
export function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

export const STAGE_BOTTOM = '#e6ebf2';
export const CARD_FILL = '#fcfbf8';
