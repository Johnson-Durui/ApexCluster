import { cloneSessionInit, createProviderSession, type NativeTurn } from './session.js';
import type { ModelProvider, ProviderEvent, ProviderInput, ProviderSession, ProviderSessionInit, WireProtocol } from './types.js';

/** Deterministic per-request input for offline tests. Turn and attempt are one-based. */
export interface ScriptedTurn {
  init: ProviderSessionInit;
  input: ProviderInput;
  priorInputs: readonly ProviderInput[];
  turn: number;
  attempt: number;
  signal: AbortSignal;
}

type Events = Iterable<ProviderEvent> | AsyncIterable<ProviderEvent>;
export type ProviderScript = (turn: ScriptedTurn) => Events | Promise<Events>;

/** Test-only provider with the same input, usage and tool-call boundaries as SDK providers. */
export class ScriptedProvider implements ModelProvider {
  readonly simulated = true;

  constructor(
    private readonly script: ProviderScript,
    readonly protocol: WireProtocol = 'openai-responses',
    private readonly modelIds: readonly string[] = [],
  ) {}

  async listModels(): Promise<string[]> {
    return [...this.modelIds];
  }

  open(init: ProviderSessionInit): ProviderSession {
    init = cloneSessionInit(init);
    let lastHistory: readonly ProviderInput[] | undefined;
    let attempt = 0;
    return createProviderSession<ProviderInput>(init, {
      apiKey: '',
      encode: input => [input],
      request: async (history, signal) => {
        attempt = history === lastHistory ? attempt + 1 : 1;
        lastHistory = history;
        const input = history.at(-1);
        if (!input) throw new Error('Missing scripted input');
        const result: NativeTurn<ProviderInput> = { historyItems: [], events: [], toolCalls: [], reason: 'stop' };
        let ended = false;
        const events = await this.script({ init, input, priorInputs: history.slice(0, -1), turn: history.length, attempt, signal });
        for await (const event of events) {
          signal.throwIfAborted();
          if (ended) throw new Error('Scripted event after the terminal event');
          switch (event.type) {
            case 'text':
            case 'reasoning_summary': result.events.push(event); break;
            case 'response_metadata':
              if (result.metadata) throw new Error('Duplicate scripted response metadata');
              result.metadata = event;
              break;
            case 'tool_call': result.toolCalls.push(event); break;
            case 'usage':
              if (result.usage) throw new Error('Duplicate scripted usage');
              result.usage = event;
              break;
            case 'end':
              result.reason = event.reason;
              ended = true;
              break;
          }
        }
        if (!ended) throw new Error('Scripted response lacks a terminal event');
        return result;
      },
    });
  }
}
