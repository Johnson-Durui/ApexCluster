// Globals for demo code only (web/src never reads them).

/** Defined as true by web/demo/vite.config.ts. */
declare const __DEMO__: boolean;

/** Exposed by chrome/pill.ts for the other demo modules. */
interface MawbDemoApi {
  /** Shows a short message in the demo pill for a few seconds. */
  toast(text: string): void;
  /** Sets the playback speed (1, 2 or 4; other values are ignored) through mock/clock.ts. */
  setSpeed(speed: number): void;
}

/** Detail of the 'mawb-demo:gate' window event the chat engine dispatches. gate null means no gate of that chat waits. */
interface MawbDemoGateDetail {
  /** The chat whose gate this is; the pill shows only the gate of the chat on screen. */
  chatId: string;
  gate: 'A' | 'B' | null;
  /** Wall-clock time (Date.now() scale) at which the engine confirms by itself. Dispatch again after a speed change. */
  autoAt?: number;
}

interface Window {
  __mawbDemo?: MawbDemoApi;
}

interface WindowEventMap {
  'mawb-demo:gate': CustomEvent<MawbDemoGateDetail>;
}
