import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateUsageUsd, reserveUsageUsd } from '../src/chat/api-run-settings.js';
import { loadRoster, type ModelBinding, type Roster } from '../src/chat/roster.js';
import { modelProviderFor } from '../src/providers/factory.js';
import { loadModelRegistry, modelSpecHash, requireModel } from '../src/providers/registry.js';
import type { ModelProvider, ModelSpec, ProviderEvent, ProviderResponseMetadata, ProviderUsage, WireProtocol } from '../src/providers/types.js';

const MAX_BUDGET_USD = 5;
const OUTPUT_RESERVE = 256;
const FIRST_TURN_INPUT_RESERVE = 2_048;
const SECOND_TURN_INPUT_RESERVE = 4_096;
const TOOL_NAME = 'smoke_echo';
const LEDGER_FILE = path.resolve('work/v1/live-ledger.json');
const effortRank = new Map(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value, index) => [value, index]));

export interface SmokeTarget {
  model: ModelSpec;
  effort: string;
}

export interface SmokeEvidence {
  model: string;
  provider: string;
  protocol: WireProtocol;
  requestedEffort: string;
  responses: SmokeResponseEvidence[];
  verification: SmokeVerification;
  listed: boolean;
  modelSpecSha256: string;
  nativeTool: { name: typeof TOOL_NAME; callIdPresent: true; receiptBound: true };
  usage: { input: number; cachedInput: number; cacheWrite: number; output: number; reasoning: number | 'not_reported' };
  behavioralEcho: { label: 'behavioral_echo'; outcome: 'pass' };
  estimatedUsd: number;
}

export type SmokeEcho = { outcome: 'matched' | 'mismatched' | 'not_returned'; returned?: string };
export interface SmokeResponseEvidence {
  request: { completed: true; effortIncluded: true };
  modelEcho: SmokeEcho;
  effortEcho: SmokeEcho;
  usage: 'reported';
  reasoning: { summary: 'nonempty_text_delta' | 'not_reported'; usage: 'positive_token_count' | 'zero_token_count' | 'not_reported' };
}
export interface SmokeVerification {
  outcome: 'fully_verified' | 'partially_verified';
  limitations: Array<'model_not_returned' | 'effort_not_returned' | 'reasoning_not_observed'>;
}

export interface SmokeReport {
  version: 1;
  kind: 'live-smoke';
  startedAt: string;
  completedAt: string;
  budgetUsd: number;
  reservedUsd: number;
  estimatedUsd: number;
  models: SmokeEvidence[];
}

export interface SmokeDependencies {
  env?: NodeJS.ProcessEnv;
  registry?: ReadonlyMap<string, ModelSpec>;
  roster?: Roster;
  providerFor?: (protocol: WireProtocol) => ModelProvider;
  now?: () => Date;
  ledgerFile?: string;
  appendLedger?: (file: string, line: string) => void;
}

function allBindings(roster: Roster): ModelBinding[] {
  const seats = roster.seats.flatMap(seat => Object.values(seat.bindings));
  const pools = roster.pools.flatMap(pool => 'byParentProvider' in pool.binding
    ? Object.values(pool.binding.byParentProvider)
    : [pool.binding]);
  return [...seats, ...pools];
}

/** Expand every seat, phase override and pool alternative, then invoke each model only once. */
export function collectSmokeTargets(roster: Roster, registry: ReadonlyMap<string, ModelSpec>): SmokeTarget[] {
  const selected = new Map<string, ModelBinding>();
  for (const binding of allBindings(roster)) {
    const prior = selected.get(binding.model);
    if (!prior || (effortRank.get(binding.effort) ?? -1) > (effortRank.get(prior.effort) ?? -1)) selected.set(binding.model, binding);
  }
  return [...selected.values()].map(binding => ({
    model: requireModel(registry, binding.model, binding.effort),
    effort: binding.effort,
  })).sort((left, right) => left.model.id.localeCompare(right.model.id));
}

export function parseSmokeBudget(argv: readonly string[]): number {
  if (argv.length !== 2 || argv[0] !== '--budget-usd') throw new Error('Usage: npm run smoke:live -- --budget-usd 5');
  const budget = Number(argv[1]);
  if (!Number.isFinite(budget) || budget <= 0 || budget > MAX_BUDGET_USD) throw new Error('Live smoke budget must be greater than 0 and at most USD 5.');
  return budget;
}

function reserveTurns(target: SmokeTarget): [number, number] {
  const first = reserveUsageUsd(target.model, FIRST_TURN_INPUT_RESERVE, OUTPUT_RESERVE);
  const second = reserveUsageUsd(target.model, SECOND_TURN_INPUT_RESERVE, OUTPUT_RESERVE);
  if (first === null || second === null) throw new Error(`Live smoke requires verified pricing for model ${target.model.id}.`);
  return [first, second];
}

function addUsage(total: Omit<ProviderUsage, 'type'>, usage: ProviderUsage): void {
  total.input += usage.input;
  total.cachedInput += usage.cachedInput;
  total.cacheWrite = (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0);
  total.output += usage.output;
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0);
}

async function receive(session: ReturnType<ModelProvider['open']>, input: Parameters<ReturnType<ModelProvider['open']>['send']>[0]): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of session.send(input, new AbortController().signal)) events.push(event);
  return events;
}

function usageOf(events: readonly ProviderEvent[]): ProviderUsage {
  const usage = events.find((event): event is ProviderUsage => event.type === 'usage');
  if (!usage) throw new Error('Provider response did not include normalized authoritative usage.');
  return usage;
}

function metadataOf(events: readonly ProviderEvent[]): ProviderResponseMetadata | undefined {
  const found = events.filter((event): event is ProviderResponseMetadata => event.type === 'response_metadata');
  if (found.length > 1) throw new Error('DUPLICATE_RESPONSE_METADATA');
  return found[0];
}

function echo(expected: string, returned: string | undefined): SmokeEcho {
  if (returned === undefined) return { outcome: 'not_returned' };
  return { outcome: returned === expected ? 'matched' : 'mismatched', returned };
}

function responseEvidence(events: readonly ProviderEvent[], target: SmokeTarget): SmokeResponseEvidence {
  const metadata = metadataOf(events);
  const evidence: SmokeResponseEvidence = {
    request: { completed: true, effortIncluded: true },
    modelEcho: echo(target.model.id, metadata?.modelId),
    effortEcho: echo(target.effort, metadata?.effort),
    usage: 'reported',
    reasoning: {
      summary: events.some(event => event.type === 'reasoning_summary' && event.delta.trim().length > 0) ? 'nonempty_text_delta' : 'not_reported',
      usage: events.some(event => event.type === 'usage' && (event.reasoning ?? 0) > 0) ? 'positive_token_count'
        : events.some(event => event.type === 'usage' && event.reasoning === 0) ? 'zero_token_count' : 'not_reported',
    },
  };
  if (evidence.modelEcho.outcome === 'mismatched') throw Object.assign(new Error('RETURNED_MODEL_MISMATCH'), { smokeEvidence: evidence });
  if (evidence.effortEcho.outcome === 'mismatched') throw Object.assign(new Error('RETURNED_EFFORT_MISMATCH'), { smokeEvidence: evidence });
  return evidence;
}

function verificationOf(responses: readonly SmokeResponseEvidence[]): SmokeVerification {
  const limitations: SmokeVerification['limitations'] = [];
  if (responses.some(response => response.modelEcho.outcome === 'not_returned')) limitations.push('model_not_returned');
  if (responses.some(response => response.effortEcho.outcome === 'not_returned')) limitations.push('effort_not_returned');
  if (responses.every(response => response.reasoning.summary === 'not_reported' && response.reasoning.usage !== 'positive_token_count')) {
    limitations.push('reasoning_not_observed');
  }
  return { outcome: limitations.length ? 'partially_verified' : 'fully_verified', limitations };
}

function evidenceFromError(error: unknown): SmokeResponseEvidence | undefined {
  if (!error || typeof error !== 'object' || !('smokeEvidence' in error)) return undefined;
  return error.smokeEvidence as SmokeResponseEvidence;
}

function appendJsonLine(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${line}\n`, { encoding: 'utf8', flag: 'a' });
}

/** Run only after every no-network guard and the aggregate cost reservation have passed. */
export async function runLiveSmoke(argv: readonly string[], dependencies: SmokeDependencies = {}): Promise<SmokeReport> {
  const env = dependencies.env ?? process.env;
  if (env.LIVE_SMOKE !== '1') throw new Error('Live smoke is disabled. Set LIVE_SMOKE=1 explicitly; no network requests were made.');
  const budgetUsd = parseSmokeBudget(argv);
  const registry = dependencies.registry ?? loadModelRegistry();
  const roster = dependencies.roster ?? loadRoster('config/roster.json', registry);
  const targets = collectSmokeTargets(roster, registry);
  const requiredKeys = [...new Set(targets.map(target => target.model.apiKeyEnv))].sort();
  const missingKeys = requiredKeys.filter(name => !env[name]?.trim());
  if (missingKeys.length) throw new Error(`Live smoke requires these environment variables: ${missingKeys.join(', ')}; no network requests were made.`);
  const reservations = new Map(targets.map(target => [target.model.id, reserveTurns(target)]));
  const reservedUsd = [...reservations.values()].flat().reduce((sum, value) => sum + value, 0);
  if (reservedUsd > budgetUsd) throw new Error(`Conservative live smoke reservation USD ${reservedUsd.toFixed(6)} exceeds budget USD ${budgetUsd.toFixed(2)}; no network requests were made.`);

  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const ledger = dependencies.ledgerFile ?? LEDGER_FILE;
  const append = (entry: Record<string, unknown>) => (dependencies.appendLedger ?? appendJsonLine)(ledger, JSON.stringify({ version: 1, kind: 'live-smoke-ledger', at: now().toISOString(), ...entry }));
  append({ event: 'run_reserved', startedAt, budgetUsd, reservedUsd, modelCount: targets.length });
  const evidence: SmokeEvidence[] = [];
  let estimatedUsd = 0;
  try {
    for (const [index, target] of targets.entries()) {
      const reserved = reservations.get(target.model.id)!;
      const modelReservedUsd = reserved[0] + reserved[1];
      append({ event: 'model_reserved', model: target.model.id, requestedEffort: target.effort, reservedUsd: modelReservedUsd });
      let phase: 'listing' | 'first_send' | 'second_send' | 'validation' = 'listing';
      const knownUsage: Omit<ProviderUsage, 'type'> = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      let usageSeen = false;
      let reasoningUsageSeen = false;
      const responses: SmokeResponseEvidence[] = [];
      let unsettledReservationUsd = 0;
      try {
        const provider = (dependencies.providerFor ?? modelProviderFor)(target.model.protocol);
        const listed = (await provider.listModels(target.model)).includes(target.model.id);
        if (!listed) throw new Error('MODEL_NOT_LISTED');
        const nonce = `smoke-${index + 1}`;
        const session = provider.open({
          model: target.model,
          effort: target.effort,
          system: 'Perform the requested smoke tool call, then acknowledge its result. Do not include hidden reasoning.',
          tools: [{ name: TOOL_NAME, description: 'Return the supplied smoke nonce.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } }],
          maxOutputTokens: OUTPUT_RESERVE,
          cacheKey: `live-smoke:${target.model.id}`,
          singleAttempt: true,
        });
        phase = 'first_send';
        unsettledReservationUsd = reserved[0];
        const first = await receive(session, { text: `Call ${TOOL_NAME} exactly once with nonce ${nonce}.` });
        const firstUsage = usageOf(first);
        addUsage(knownUsage, firstUsage);
        usageSeen = true;
        reasoningUsageSeen ||= firstUsage.reasoning !== undefined;
        unsettledReservationUsd = 0;
        phase = 'validation';
        try { responses.push(responseEvidence(first, target)); }
        catch (error) { const item = evidenceFromError(error); if (item) responses.push(item); throw error; }
        const calls = first.filter((event): event is Extract<ProviderEvent, { type: 'tool_call' }> => event.type === 'tool_call');
        if (calls.length !== 1 || calls[0]?.name !== TOOL_NAME || !calls[0].callId) throw new Error('NATIVE_TOOL_CALL_INVALID');
        const args = calls[0].args as Record<string, unknown>;
        if (!args || args.nonce !== nonce) throw new Error('TOOL_ARGUMENT_BINDING_INVALID');
        const receipt = `SMOKE_RECEIPT:${nonce}`;
        phase = 'second_send';
        unsettledReservationUsd = reserved[1];
        const second = await receive(session, { toolResults: [{ callId: calls[0].callId, text: receipt }] });
        const secondUsage = usageOf(second);
        addUsage(knownUsage, secondUsage);
        usageSeen = true;
        reasoningUsageSeen ||= secondUsage.reasoning !== undefined;
        unsettledReservationUsd = 0;
        phase = 'validation';
        try { responses.push(responseEvidence(second, target)); }
        catch (error) { const item = evidenceFromError(error); if (item) responses.push(item); throw error; }
        const usage = knownUsage;
        if (usage.input > FIRST_TURN_INPUT_RESERVE + SECOND_TURN_INPUT_RESERVE || usage.output > OUTPUT_RESERVE * 2) throw new Error('USAGE_RESERVATION_EXCEEDED');
        const cost = estimateUsageUsd(target.model, usage);
        if (cost === null) throw new Error('PRICING_UNAVAILABLE');
        estimatedUsd += cost;
        if (estimatedUsd > budgetUsd) throw new Error('BUDGET_EXCEEDED');
        const text = second.filter((event): event is Extract<ProviderEvent, { type: 'text' }> => event.type === 'text').map(event => event.delta).join('');
        if (!text.includes(receipt)) throw new Error('BEHAVIORAL_ECHO_MISSING');
        const item: SmokeEvidence = {
      model: target.model.id,
      provider: target.model.provider,
      protocol: target.model.protocol,
      requestedEffort: target.effort,
      responses,
      verification: verificationOf(responses),
      listed,
      modelSpecSha256: modelSpecHash(target.model),
      nativeTool: { name: TOOL_NAME, callIdPresent: true, receiptBound: true },
      usage: {
        input: usage.input,
        cachedInput: usage.cachedInput,
        cacheWrite: usage.cacheWrite ?? 0,
        output: usage.output,
        reasoning: reasoningUsageSeen ? usage.reasoning ?? 0 : 'not_reported',
      },
      behavioralEcho: { label: 'behavioral_echo', outcome: 'pass' },
      estimatedUsd: cost,
        };
        evidence.push(item);
        append({ event: 'model_completed', model: target.model.id, requestedEffort: target.effort, responses,
          verification: item.verification,
          reservedUsd: modelReservedUsd, estimatedUsd: cost, usage: item.usage });
      } catch (error) {
        const reportedUsage = usageSeen ? { input: knownUsage.input, cachedInput: knownUsage.cachedInput, cacheWrite: knownUsage.cacheWrite ?? 0,
          output: knownUsage.output, reasoning: reasoningUsageSeen ? knownUsage.reasoning ?? 0 : 'not_reported' } : undefined;
        const knownUsd = usageSeen ? estimateUsageUsd(target.model, knownUsage) ?? 0 : 0;
        const retainedUsd = unsettledReservationUsd;
        const explicit = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : undefined;
        const reasonCode = explicit ?? (phase === 'listing' ? 'MODEL_LIST_FAILED' : phase === 'first_send' ? 'FIRST_REQUEST_FAILED' : phase === 'second_send' ? 'SECOND_REQUEST_FAILED' : 'MODEL_VALIDATION_FAILED');
        append({ event: 'model_failed', model: target.model.id, requestedEffort: target.effort, reasonCode, responses,
          knownUsage: reportedUsage, knownUsd, retainedReservationUsd: retainedUsd });
        throw error;
      }
    }
  } catch (error) {
    append({ event: 'run_failed', completedModels: evidence.length, reasonCode: 'MODEL_TERMINAL_FAILURE' });
    throw error;
  }

  const report: SmokeReport = { version: 1, kind: 'live-smoke', startedAt, completedAt: now().toISOString(), budgetUsd, reservedUsd, estimatedUsd, models: evidence };
  append({ event: 'run_completed', report });
  return report;
}

async function main(): Promise<void> {
  try {
    const report = await runLiveSmoke(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Live smoke failed.'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
