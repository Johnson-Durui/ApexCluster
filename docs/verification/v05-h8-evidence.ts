export type UsageSemantics = 'unknown' | 'per_turn_context' | 'cumulative';

export interface AnalyzeContextEvidenceInput {
  adapter: string;
  cliVersion: string | null | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  events: unknown[];
  helpText?: string;
}

export interface NumericObservation {
  eventIndex: number;
  source: 'usage' | 'modelUsage';
  model: string | null;
  values: Record<string, number>;
}

export interface WindowObservation {
  eventIndex: number;
  source: string;
  model: string | null;
  value: number;
}

export interface CompactObservation {
  eventIndex: number;
  eventType: string;
  fields: Record<string, number | boolean>;
}

export interface RetainedContextEvent {
  eventIndex: number;
  eventType: string;
  usage?: Record<string, number>;
  modelUsage?: Array<{ model: string; values: Record<string, number> }>;
  contextWindow?: Array<{ field: string; value: number }>;
  compact?: Record<string, number | boolean>;
}

export interface ContextEvidenceReport {
  adapter: string;
  cliVersion: string | null;
  model: string | null;
  effort: string | null;
  retainedEvents: RetainedContextEvent[];
  observations: {
    usage: NumericObservation[];
    windows: WindowObservation[];
    compactions: CompactObservation[];
    helpParameters: {
      autocompactListed: boolean;
      maxTurnsListed: boolean;
      modelAutoCompactTokenLimitListed: boolean;
    };
  };
  contextWindow: null;
  usageSemantics: UsageSemantics;
  compactions: number | null;
  canEnableResume: false;
  guards: {
    windowVerified: false;
    usageSemanticsVerified: false;
    compactionObservabilityVerified: false;
    autoCompactGuardVerified: false;
    maxTurnsGuardVerified: false;
  };
  reasons: string[];
}

type JsonObject = Record<string, unknown>;

const USAGE_FIELDS = new Set([
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens',
  'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_write_input_tokens',
  'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens',
  'cacheCreationInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens',
]);

const WINDOW_FIELDS = new Set([
  'context_window', 'context_window_tokens', 'contextWindow', 'contextWindowTokens',
]);

const COMPACT_EVENT_TYPES = new Set([
  'context.compacted', 'context_compacted', 'conversation.compacted',
  'conversation_compacted', 'compact.completed', 'compact_completed',
]);

const COMPACT_FIELDS = new Set([
  'before_tokens', 'after_tokens', 'removed_tokens',
  'beforeTokens', 'afterTokens', 'removedTokens', 'automatic',
]);

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function cleanIdentity(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

function safeModelKey(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) ? value : '[redacted-model-key]';
}

function eventType(event: JsonObject): string {
  const type = typeof event.type === 'string' ? event.type : '';
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  if (type === 'system' && subtype) return `${type}.${subtype}`;
  return type;
}

function numericFields(value: unknown, allowed: Set<string>): Record<string, number> {
  const object = objectValue(value);
  if (!object) return {};
  const result: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(object)) {
    if (!allowed.has(key)) continue;
    const number = nonNegativeNumber(candidate);
    if (number !== null) result[key] = number;
  }
  return result;
}

function windowFields(value: JsonObject): Array<{ field: string; value: number }> {
  const result: Array<{ field: string; value: number }> = [];
  for (const [key, candidate] of Object.entries(value)) {
    if (!WINDOW_FIELDS.has(key)) continue;
    const number = positiveInteger(candidate);
    if (number !== null) result.push({ field: key, value: number });
  }
  return result;
}

function compactFields(value: JsonObject): Record<string, number | boolean> {
  const result: Record<string, number | boolean> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!COMPACT_FIELDS.has(key)) continue;
    if (typeof candidate === 'boolean') result[key] = candidate;
    else {
      const number = nonNegativeNumber(candidate);
      if (number !== null) result[key] = number;
    }
  }
  return result;
}

function isClaude(adapter: string): boolean {
  return /claude/i.test(adapter);
}

function isCodex(adapter: string): boolean {
  return /codex|astra|sol/i.test(adapter);
}

function acceptsUsageEnvelope(adapter: string, type: string): boolean {
  if (isClaude(adapter)) return type === 'result';
  if (isCodex(adapter)) return type === 'turn.completed';
  return false;
}

function acceptsWindowEnvelope(adapter: string, type: string): boolean {
  if (isClaude(adapter)) return type === 'result' || type === 'system.init' || type === 'context_window';
  if (isCodex(adapter)) return type === 'turn.completed' || type === 'thread.started' || type === 'context_window';
  return false;
}

function listed(helpText: string, pattern: RegExp): boolean {
  return pattern.test(helpText);
}

/**
 * Conservatively extracts H8 evidence from caller-supplied JSONL events.
 *
 * It deliberately does not infer context occupancy from token consumption,
 * cached-token fields, model names, absent compact events, or help text.
 */
export function analyzeContextEvidence(input: AnalyzeContextEvidenceInput): ContextEvidenceReport {
  const adapter = cleanIdentity(input.adapter) ?? 'unknown';
  const usage: NumericObservation[] = [];
  const windows: WindowObservation[] = [];
  const compactionEvents: CompactObservation[] = [];
  const retainedEvents: RetainedContextEvent[] = [];

  input.events.forEach((candidate, eventIndex) => {
    const event = objectValue(candidate);
    if (!event) return;
    const type = eventType(event);
    const retained: RetainedContextEvent = { eventIndex, eventType: type || 'unknown' };
    let retain = false;

    if (acceptsUsageEnvelope(adapter, type)) {
      const eventUsage = numericFields(event.usage, USAGE_FIELDS);
      if (Object.keys(eventUsage).length > 0) {
        retained.usage = eventUsage;
        usage.push({ eventIndex, source: 'usage', model: null, values: eventUsage });
        retain = true;
      }

      if (isClaude(adapter)) {
        const modelUsage = objectValue(event.modelUsage);
        const safeEntries: Array<{ model: string; values: Record<string, number> }> = [];
        if (modelUsage) {
          for (const [rawModel, rawValues] of Object.entries(modelUsage)) {
            const modelValues = numericFields(rawValues, USAGE_FIELDS);
            const modelObject = objectValue(rawValues);
            const safeModel = safeModelKey(rawModel);
            const observedWindows = modelObject ? windowFields(modelObject) : [];
            const retainedValues = { ...modelValues };
            for (const observed of observedWindows) retainedValues[observed.field] = observed.value;
            if (Object.keys(retainedValues).length > 0) {
              safeEntries.push({ model: safeModel, values: retainedValues });
              retain = true;
            }
            if (Object.keys(modelValues).length > 0) {
              usage.push({ eventIndex, source: 'modelUsage', model: safeModel, values: modelValues });
            }
            for (const observed of observedWindows) {
              windows.push({ eventIndex, source: `modelUsage.${observed.field}`, model: safeModel, value: observed.value });
            }
          }
        }
        if (safeEntries.length > 0) {
          retained.modelUsage = safeEntries;
          retain = true;
        }
      }
    }

    if (acceptsWindowEnvelope(adapter, type)) {
      const observed = windowFields(event);
      if (observed.length > 0) {
        retained.contextWindow = observed;
        for (const item of observed) windows.push({ eventIndex, source: item.field, model: null, value: item.value });
        retain = true;
      }
    }

    if (COMPACT_EVENT_TYPES.has(type)) {
      const fields = compactFields(event);
      retained.compact = fields;
      compactionEvents.push({ eventIndex, eventType: type, fields });
      retain = true;
    }

    if (retain) retainedEvents.push(retained);
  });

  const helpText = typeof input.helpText === 'string' ? input.helpText : '';
  const helpParameters = {
    autocompactListed: listed(helpText, /(?:^|\s)--autocompact(?:\s|[=,]|$)/m),
    maxTurnsListed: listed(helpText, /(?:^|\s)--max-turns(?:\s|[=,]|$)/m),
    modelAutoCompactTokenLimitListed: listed(helpText, /model_auto_compact_token_limit(?:\s|=|,|$)/m),
  };
  const reasons = [
    '未提供版本绑定、可重复的窗口实测，contextWindow 保持 null',
    '单次 usage/modelUsage 事件只能证明消耗字段存在，不能证明它表示当前上下文占用',
    '未建立该 CLI 版本的压缩事件完整性；缺少事件不能解释为 0 次压缩',
    'help 文本只能证明参数被列出，不能证明参数被接受或实际生效',
  ];
  if (!cleanIdentity(input.cliVersion)) reasons.unshift('缺少 CLI 版本，所有能力结论必须保持未验证');
  if (input.events.length === 0) reasons.unshift('没有原始事件可供分析');

  return {
    adapter,
    cliVersion: cleanIdentity(input.cliVersion),
    model: cleanIdentity(input.model),
    effort: cleanIdentity(input.effort),
    retainedEvents,
    observations: { usage, windows, compactions: compactionEvents, helpParameters },
    contextWindow: null,
    usageSemantics: 'unknown',
    compactions: compactionEvents.length > 0 ? compactionEvents.length : null,
    canEnableResume: false,
    guards: {
      windowVerified: false,
      usageSemanticsVerified: false,
      compactionObservabilityVerified: false,
      autoCompactGuardVerified: false,
      maxTurnsGuardVerified: false,
    },
    reasons,
  };
}
