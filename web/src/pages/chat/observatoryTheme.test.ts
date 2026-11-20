import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_FILL, INK, SEAT_INKS, STAGE_BOTTOM } from './observatoryTheme';

// observatoryTheme stays the canvas source of truth; its hex values must equal the design tokens (BUILD-SPEC-B §2).
// Read from disk: Vitest serves CSS imports (even ?raw) as empty strings.
const tokensCss = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
const root = tokensCss.slice(tokensCss.indexOf(':root{'), tokensCss.indexOf('}', tokensCss.indexOf(':root{')));
function token(name: string) {
  const match = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})\\s*;').exec(root);
  if (!match) throw new Error('token --' + name + ' missing or not a hex colour');
  return match[1].toLowerCase();
}

describe('observatory theme ↔ design tokens', () => {
  it('uses the token value for every seat ink', () => {
    for (const [seat, ink] of Object.entries(SEAT_INKS)) expect(ink.toLowerCase(), seat).toBe(token('s-' + seat));
  });

  it('uses the token value for every canvas state ink that has a token', () => {
    const pairs: Array<[keyof typeof INK, string]> = [
      ['ink', 'ink'], ['ink2', 'ink-2'], ['muted', 'muted'], ['faint', 'faint'], ['ghost', 'ghost'],
      ['active', 'run'], ['done', 'ok'], ['wait', 'wait'], ['waitBar', 'wait-bar'],
      ['gate', 'gate'], ['gateInk', 'gate-ink'], ['error', 'err'], ['idle', 'idle'],
    ];
    for (const [key, name] of pairs) expect(INK[key].toLowerCase(), key).toBe(token(name));
  });

  it('keeps the stage bottom and the card paper equal to their tokens', () => {
    expect(STAGE_BOTTOM).toBe(token('mist-1'));
    expect(CARD_FILL).toBe(token('paper'));
  });
});
