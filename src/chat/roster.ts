import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { modelSpecHash, requireModel } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import type { AgentTask, ChatDriver, ChatRecord } from './types.js';
import type { ContextPolicy, ContextSettings } from './window.js';

export const phaseSchema = z.enum(['architecture', 'cluster', 'demo', 'implementation', 'acceptance']);
export type PhaseId = z.infer<typeof phaseSchema>;
export const seatIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const kinds = z.enum(['lead', 'secondary', 'crossref', 'ideator', 'builder', 'worker']);
export type SeatKind = z.infer<typeof kinds>;
const binding = z.object({
  model: z.string().min(1),
  effort: z.string().min(1),
  delegation: z.enum(['none', 'explicit', 'proactive']),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ModelBinding = z.infer<typeof binding>;

const capabilities = z.object({
  askUser: z.boolean(),
  delegateSeats: z.array(seatIdSchema),
  writeMain: z.boolean(),
  writeIsolated: z.boolean(),
  integrate: z.boolean(),
  acceptance: z.boolean(),
  exec: z.boolean(),
}).strict();
export type SeatCapabilities = z.infer<typeof capabilities>;

const seatSpec = z.object({
  id: seatIdSchema,
  kind: kinds,
  delegationWeight: z.number().int().positive().optional(),
  promptFile: z.string().regex(/^[a-z][a-z0-9-]{0,63}\.md$/),
  strengths: z.string().min(1).max(2_000),
  bindings: z.object({
    default: binding,
    architecture: binding.optional(),
    cluster: binding.optional(),
    demo: binding.optional(),
    implementation: binding.optional(),
    acceptance: binding.optional(),
  }).strict(),
  can: capabilities,
  canByPhase: z.partialRecord(phaseSchema, capabilities.partial()).optional(),
}).strict();
export type SeatSpec = z.infer<typeof seatSpec>;

const poolSpec = z.object({
  id: seatIdSchema,
  delegationWeight: z.number().int().positive().optional(),
  binding: z.union([binding, z.object({ byParentProvider: z.record(z.string().min(1), binding) }).strict()]),
  maxConcurrent: z.number().int().positive().nullable(),
  maxWindowsPerTask: z.number().int().positive(),
  strengths: z.string().min(1).max(2_000),
}).strict();
export type PoolSpec = z.infer<typeof poolSpec>;

const layer = z.object({ pools: z.array(seatIdSchema) }).strict();
const rosterSchema = z.object({
  version: z.literal(1),
  rootSeat: seatIdSchema,
  seats: z.array(seatSpec).min(1),
  pools: z.array(poolSpec),
  layers: z.object({ architecture: layer, implementation: layer }).strict(),
}).strict();
export type Roster = z.infer<typeof rosterSchema>;

export type ResolvedSeat = Omit<SeatSpec, 'bindings' | 'canByPhase'> & { binding: ModelBinding; phase?: PhaseId };

/** This snapshot pins both role policy and the registered model specifications used by a chat. */
export interface FrozenApiRoster {
  roster: Roster;
  modelHashes: Record<string, string>;
  context?: ContextSettings;
}

/** Bootstrap supplies verified drivers. Tests may inject an offline implementation of the same seam. */
export interface ApiChatBinding {
  roster: Roster;
  registry: ReadonlyMap<string, ModelSpec>;
  context?: ContextSettings;
  modelCheckStatus?(model: ModelSpec): 'verified' | 'not_listed' | 'error' | 'unchecked' | 'stale' | 'simulated';
  resolveDriver(seat: ResolvedSeat, expectedModelSpecHash?: string, policy?: ContextPolicy): ChatDriver;
}

/** Resolve the exact phase override, falling back to the seat's declared defaults. */
export function resolveSeat(roster: Roster, id: string, phase?: PhaseId): ResolvedSeat | undefined {
  const seat = roster.seats.find(item => item.id === id);
  if (!seat) return undefined;
  const { bindings, can, canByPhase, ...identity } = seat;
  return {
    ...identity,
    phase,
    binding: (phase && bindings[phase]) || bindings.default,
    can: { ...can, ...(phase ? canByPhase?.[phase] : undefined) },
  };
}

/** Older frozen rosters without weights retain their original delegation policy. */
export function canDelegateByWeight(parent: ResolvedSeat, target: { delegationWeight?: number }): boolean {
  const parentWeight = parent.delegationWeight;
  const targetWeight = target.delegationWeight;
  if (parentWeight === undefined && targetWeight === undefined) return true;
  return parent.kind !== 'worker' && parent.binding.delegation !== 'none' &&
    parentWeight !== undefined && targetWeight !== undefined && parentWeight > targetWeight;
}

export function allowedDelegateSeats(roster: Roster, parent: ResolvedSeat): string[] {
  return parent.can.delegateSeats.filter(id => {
    const target = roster.seats.find(seat => seat.id === id);
    return target !== undefined && canDelegateByWeight(parent, target);
  });
}

function layerForPhase(phase: PhaseId | undefined): keyof Roster['layers'] | undefined {
  if (phase === 'architecture' || phase === 'cluster' || phase === 'demo') return 'architecture';
  if (phase === 'implementation' || phase === 'acceptance') return 'implementation';
  return undefined;
}

/** Resolve a worker pool only inside a phase that declares it, without provider fallback. */
export function resolvePool(roster: Roster, id: string, phase?: PhaseId, parentProvider?: string): ResolvedSeat | undefined {
  const layer = layerForPhase(phase);
  const pool = roster.pools.find(item => item.id === id);
  if (!layer || !pool || !roster.layers[layer].pools.includes(id)) return undefined;
  const entry = 'byParentProvider' in pool.binding ? pool.binding.byParentProvider[parentProvider ?? ''] : pool.binding;
  if (!entry) return undefined;
  return {
    id: pool.id,
    kind: 'worker',
    ...(pool.delegationWeight !== undefined ? { delegationWeight: pool.delegationWeight } : {}),
    promptFile: 'worker.md',
    strengths: pool.strengths,
    phase,
    binding: entry,
    can: {
      askUser: false,
      delegateSeats: [],
      writeMain: false,
      writeIsolated: true,
      integrate: false,
      acceptance: false,
      exec: true,
    },
  };
}

const cliCapabilities: SeatCapabilities = {
  askUser: false, delegateSeats: ['astra', 'sol'], writeMain: false, writeIsolated: false,
  integrate: false, acceptance: false, exec: false,
};

function cliSeat(id: string, kind: SeatKind, model: string, can: Partial<SeatCapabilities>): SeatSpec {
  return {
    id, kind, promptFile: `${id}.md`, strengths: id,
    bindings: { default: { model, effort: kind === 'worker' ? 'high' : 'max', delegation: kind === 'worker' ? 'none' : 'explicit' } },
    can: { ...cliCapabilities, ...can },
  };
}

/** Legacy capability table. Actual CLI model and isolation facts still come from the legacy drivers. */
export const CLI_ROSTER: Roster = {
  version: 1,
  rootSeat: 'claude',
  seats: [
    cliSeat('claude', 'lead', 'claude-opus-5-5', { askUser: true }),
    cliSeat('astra', 'secondary', 'gpt-6.2-astra', { acceptance: true, exec: true }),
    cliSeat('sol', 'builder', 'gpt-6.2-sol', { writeMain: true, integrate: true, exec: true }),
    cliSeat('grok', 'worker', 'grok-4.7-high-fast', { writeIsolated: true, exec: true, delegateSeats: [] }),
  ],
  pools: [],
  layers: { architecture: { pools: [] }, implementation: { pools: [] } },
};

/** Resolve the active roster for a chat, keeping API, custom CLI, and legacy CLI rosters distinct. */
export function chatRoster(chat: ChatRecord): Roster {
  return chat.apiRoster?.roster ?? chat.cliRoster ?? CLI_ROSTER;
}

/** Resolve a task against its recorded policy; old records always use CLI policy. */
export function taskSeat(chat: ChatRecord, task: AgentTask): ResolvedSeat | undefined {
  if (chat.apiRoster) {
    return resolveSeat(chat.apiRoster.roster, task.role, task.phase)
      ?? resolvePool(chat.apiRoster.roster, task.role, task.phase, task.poolProvider);
  }
  return resolveSeat(chat.cliRoster ?? CLI_ROSTER, task.role, task.phase);
}

function poolBindings(pool: PoolSpec): ModelBinding[] {
  return 'byParentProvider' in pool.binding ? Object.values(pool.binding.byParentProvider) : [pool.binding];
}

function validateRosterStructure(input: unknown): Roster {
  const parsed = rosterSchema.safeParse(input);
  if (!parsed.success) throw new Error(`名册结构无效：${parsed.error.issues.map(issue => issue.path.join('.') || 'roster').join(', ')}`);
  const roster = parsed.data;
  const members = [...roster.seats, ...roster.pools];
  if (members.some(member => member.delegationWeight !== undefined) && members.some(member => member.delegationWeight === undefined)) {
    throw new Error('启用委派权重后，所有席位和 Worker 池都必须配置 delegationWeight');
  }
  const seats = new Set(roster.seats.map(seat => seat.id));
  const pools = new Set(roster.pools.map(pool => pool.id));
  if (seats.size !== roster.seats.length || pools.size !== roster.pools.length || [...pools].some(id => seats.has(id))) {
    throw new Error('名册席位或池 ID 重复');
  }
  if (resolveSeat(roster, roster.rootSeat)?.kind !== 'lead') throw new Error('名册须指定一个主导席作为根席位');
  if (Object.values(roster.layers).some(layer => layer.pools.some(id => !pools.has(id)))) throw new Error('名册层引用了未注册的池');
  const mainWriters = new Set<string>();
  for (const phase of [undefined, ...phaseSchema.options]) {
    const resolved = roster.seats.map(seat => resolveSeat(roster, seat.id, phase)!);
    for (const seat of resolved) {
      if (seat.can.writeMain) mainWriters.add(seat.id);
      if (seat.can.delegateSeats.some(id => id === seat.id || !seats.has(id))) throw new Error(`席位 ${seat.id} 的委派目标无效`);
      if (seat.can.integrate && !seat.can.writeMain) throw new Error(`席位 ${seat.id} 缺少集成所需的主工作区写权限`);
      if ((seat.can.writeMain || seat.can.writeIsolated) && seat.can.acceptance) throw new Error(`席位 ${seat.id} 不能同时写入并独立验收`);
      if (seat.kind === 'worker' && (seat.can.writeMain || seat.can.askUser || seat.can.acceptance || seat.can.delegateSeats.length || seat.binding.delegation !== 'none')) {
        throw new Error(`Worker 席位 ${seat.id} 权限超出边界`);
      }
    }
  }
  if (mainWriters.size > 1) throw new Error('所有阶段必须共用唯一的主工作区写者');
  for (const pool of roster.pools) {
    const bindings = poolBindings(pool);
    if (bindings.length === 0) throw new Error(`池 ${pool.id} 缺少绑定`);
    for (const entry of bindings) {
      if (entry.delegation !== 'none') throw new Error(`池 ${pool.id} 的 worker 不可再委派`);
    }
  }
  return roster;
}

/** Validate a custom CLI roster's permission/weight invariants without requiring an API model registry. */
export function validateCliRoster(input: unknown): Roster {
  return validateRosterStructure(input);
}

/** Parse the roster, validating every declared binding and phase permission before startup. */
export function parseRoster(input: unknown, registry: ReadonlyMap<string, ModelSpec>): Roster {
  const roster = validateRosterStructure(input);
  for (const phase of [undefined, ...phaseSchema.options]) {
    const resolved = roster.seats.map(seat => resolveSeat(roster, seat.id, phase)!);
    for (const seat of resolved) {
      requireModel(registry, seat.binding.model, seat.binding.effort);
    }
  }
  for (const pool of roster.pools) {
    for (const entry of poolBindings(pool)) {
      requireModel(registry, entry.model, entry.effort);
    }
  }
  return roster;
}

/** Load a local roster configuration without including file content in parse failures. */
export function loadRoster(file: string, registry: ReadonlyMap<string, ModelSpec>): Roster {
  const text = readFileSync(file, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('名册 JSON 无效');
  }
  return parseRoster(value, registry);
}

/** Pin every reachable binding before persisting a new API chat. */
export function freezeApiRoster(roster: Roster, registry: ReadonlyMap<string, ModelSpec>, context?: ContextSettings): FrozenApiRoster {
  const bindings = [...roster.seats.flatMap(seat => Object.values(seat.bindings)), ...roster.pools.flatMap(poolBindings)];
  const modelHashes = Object.fromEntries(bindings.map(entry => [entry.model, modelSpecHash(requireModel(registry, entry.model, entry.effort))]));
  return { roster: structuredClone(roster), modelHashes, ...(context ? { context: structuredClone(context) } : {}) };
}
