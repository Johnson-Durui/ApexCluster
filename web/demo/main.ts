// Entry of the static online demo (README.md "Build layout").
// Order matters: the mock transport is installed before any product module runs; the demo pill comes next, before the
// chat mock, because rebuilding a saved chat that waits at a gate announces the gate countdown at once (the pill only
// listens to window events and waits for the status bar by itself); then the other mock routes, and finally the real
// product entry is imported. Each install step is isolated, so one failing package logs an error (which the verifier
// reports) instead of stopping the whole app from mounting.
import { installPill } from './chrome/pill';
import { install as installChats } from './mock/chats';
import { installNavigation } from './mock/navigation';
import { installTransport } from './mock/router';
import { install as installRuns } from './mock/runs';
import { install as installSystem } from './mock/system';

function step(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`[demo] ${name} failed to install`, error);
  }
}

installTransport();
step('demo pill', installPill);
step('system mock', installSystem);
step('chat mock', installChats);
step('run mock', installRuns);
step('link and preview interceptor', installNavigation);

await import('../src/main.tsx');
