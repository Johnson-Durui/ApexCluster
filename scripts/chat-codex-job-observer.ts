import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export type CodexToolCompletionObservation = {
  method: 'item/completed'; tool: 'probe_read' | 'probe_wait'; callIdSha256: string;
  statusIsCompleted: boolean | null; success: boolean | null; contentItemCount: number;
  inputTextCount: number; schemaValid: boolean; responseTextSha256: string | null;
  responseBytes: number | null; equalsExpectedPublicText: boolean | null;
};

type CodexAppServerClass = { prototype: Record<string, unknown> };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export function appendBoundedCodexObservation(target: CodexToolCompletionObservation[], observation: CodexToolCompletionObservation, onOverflow: (code: string) => void): void {
  if (target.length >= 32) { onOverflow('DMW_CODEX_TOOL_OBSERVER_OVERFLOW'); return; }
  target.push(observation);
}

/** Harness-only observer: call the original consume exactly once before inspecting a bounded public summary. */
export function installCodexToolCompletionObserver(
  CodexAppServer: CodexAppServerClass,
  expectedPublicText: string,
  sink: (observation: CodexToolCompletionObservation) => void,
  onObserverError: (code: string) => void,
): () => void {
  let owner: object | null = CodexAppServer.prototype;
  while (owner && !Object.hasOwn(owner, 'consume')) owner = Object.getPrototypeOf(owner);
  assert.ok(owner && owner !== Object.prototype, 'CodexAppServer.consume owner unavailable');
  const descriptor = Object.getOwnPropertyDescriptor(owner, 'consume');
  assert.ok(descriptor && typeof descriptor.value === 'function' && descriptor.value.length === 1 && descriptor.configurable !== false, 'CodexAppServer.consume ABI unavailable');
  const original = descriptor.value as (line: string) => unknown;
  function observedConsume(this: unknown, line: string): unknown {
    const returned = Reflect.apply(original, this, [line]);
    try {
      if (typeof line !== 'string' || line.length > 4 * 1024 * 1024) return returned;
      const message = JSON.parse(line) as any;
      const item = message?.method === 'item/completed' ? message.params?.item : null;
      if (item?.type !== 'dynamicToolCall' || !['probe_read', 'probe_wait'].includes(item.tool)) return returned;
      const tool = item.tool as 'probe_read' | 'probe_wait';
      const items = Array.isArray(item.contentItems) ? item.contentItems : [];
      const texts = items.filter((entry: any) => entry?.type === 'inputText' && typeof entry.text === 'string');
      const schemaValid = Array.isArray(item.contentItems) && items.length === 1 && texts.length === 1 && Object.keys(texts[0]).sort().join(',') === 'text,type';
      const text = schemaValid ? texts[0].text as string : null;
      sink({ method: 'item/completed', tool, callIdSha256: sha256(typeof item.id === 'string' ? `string:${item.id}` : `other:${typeof item.id}`),
        statusIsCompleted: typeof item.status === 'string' ? item.status === 'completed' : null, success: typeof item.success === 'boolean' ? item.success : null,
        contentItemCount: items.length, inputTextCount: texts.length, schemaValid,
        responseTextSha256: text === null ? null : sha256(text), responseBytes: text === null ? null : Buffer.byteLength(text),
        equalsExpectedPublicText: text === null ? null : text === expectedPublicText });
    } catch { onObserverError('DMW_CODEX_TOOL_OBSERVER_PARSE'); }
    return returned;
  }
  Object.defineProperty(owner, 'consume', { ...descriptor, value: observedConsume });
  return () => {
    const current = Object.getOwnPropertyDescriptor(owner, 'consume');
    assert.equal(current?.value, observedConsume, 'CodexAppServer.consume observer changed unexpectedly');
    Object.defineProperty(owner, 'consume', descriptor);
  };
}
