import { backupChats, restoreChats } from '../src/chat/backup.js';
const [operation, source, output, ...rest] = process.argv.slice(2);
if (!['backup','restore'].includes(operation ?? '') || !source || !output || rest.length) {
  throw new Error('用法：node --import tsx scripts/chat-backup.ts backup|restore 来源目录 新目标目录');
}
const result = operation === 'backup' ? backupChats(source, output) : restoreChats(source, output);
console.log(JSON.stringify({ operation, output, chats: Array.isArray(result) ? result.length : result.chatIds.length, files: Array.isArray(result) ? undefined : result.files.length, autoReplay: false }));
