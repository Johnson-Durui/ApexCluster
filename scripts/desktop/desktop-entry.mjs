import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = pathToFileURL(realpathSync.native(fileURLToPath(new URL('./src/server/desktop.js', import.meta.url))));
const { runDesktopHost } = await import(host.href);
await runDesktopHost();
