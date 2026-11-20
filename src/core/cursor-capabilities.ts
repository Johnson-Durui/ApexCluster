import { cursorCommandBindingMatches, resolveCursorCommand, type CursorCapabilities } from '../adapters/cursor.js';
import type { CommandOverride } from '../adapters/types.js';

/** 只展示服务器已有的 H7 记录；不执行 CLI，不把文档能力视为本机实测。 */
export function cursorAvailability(model: string, capabilities: CursorCapabilities | null, command: CommandOverride | null = null) {
  const available = !!(capabilities?.verifiedAt && Number.isFinite(Date.parse(capabilities.verifiedAt))
    && capabilities.cliVersion && model === 'grok-4.7-high-fast' && capabilities.model === model
    && capabilities.reportedModel?.trim() && capabilities.toolPolicy === 'deny_all'
    && capabilities.stdinPromptVerified && capabilities.readOnlyToolsVerified
    && cursorCommandBindingMatches(resolveCursorCommand(command), capabilities));
  return { available, reason: available ? '纯文本整理已绑定调用入口和工具拒绝策略；每次调用仍校验 CLI 版本' : 'Cursor 调用入口、stdin、型号显示名和工具拒绝策略尚未经 H7 按版本验证',
    model, verifiedAt: capabilities?.verifiedAt ?? null, cliVersion: capabilities?.cliVersion ?? null, capabilities };
}
