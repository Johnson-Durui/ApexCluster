import { writeFileSync } from 'node:fs';
import { createApiChatBinding } from '../../src/chat/api-driver.js';
import { loadRoster } from '../../src/chat/roster.js';
import { ChatRuntime } from '../../src/chat/runtime.js';
import { ChatStore } from '../../src/chat/store.js';
import { loadModelRegistry } from '../../src/providers/registry.js';
import { ScriptedProvider } from '../../src/providers/scripted.js';

const [root, marker] = process.argv.slice(2);
if (!root || !marker) process.exit(64);

const registry = loadModelRegistry();
const roster = loadRoster('config/roster.json', registry);
const api = createApiChatBinding(roster, registry, null, {
  offline: true,
  providerFor: model => new ScriptedProvider(() => {
    writeFileSync(marker, chat.id, 'utf8');
    process.exit(73);
  }, model.protocol),
});
const runtime = new ChatRuntime({ store: new ChatStore(root), drivers: {}, api, handoffMs: 5 });
const chat = runtime.create({});
runtime.send(chat.id, { text: '模拟崩溃恢复', clientMessageId: 'crash-fixture' });
setTimeout(() => process.exit(74), 5_000).unref();
