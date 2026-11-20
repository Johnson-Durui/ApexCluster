import { createHash } from 'node:crypto';
import { z } from 'zod';

const requirementId = /^R-\d{3}$/;
const acceptanceId = /^AC-\d{3}$/;
const assumptionId = /^AS-\d{3}$/;
const sha256 = /^[a-f0-9]{64}$/;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const exactText = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0, '不得只包含空白');
const exactIdentifier = exactText(200).refine(value => value === value.trim(), 'ID 前后不得包含空白');

const RequirementZ = z.object({
  id: z.string().regex(requirementId),
  text: exactText(20_000),
  sourceIds: z.array(exactIdentifier).max(100).optional(),
  assumptionIds: z.array(z.string().regex(assumptionId)).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (!value.sourceIds?.length && !value.assumptionIds?.length) {
    context.addIssue({ code: 'custom', message: '每条需求必须至少引用一个用户原文来源或已记录假设' });
  }
  if (value.sourceIds && !unique(value.sourceIds)) {
    context.addIssue({ code: 'custom', path: ['sourceIds'], message: '来源 ID 不得重复' });
  }
  if (value.assumptionIds && !unique(value.assumptionIds)) {
    context.addIssue({ code: 'custom', path: ['assumptionIds'], message: '假设 ID 不得重复' });
  }
});

const AcceptanceZ = z.object({
  id: z.string().regex(acceptanceId),
  requirementIds: z.array(z.string().regex(requirementId)).min(1).max(100),
  kind: z.enum(['command', 'ui', 'manual']),
  description: exactText(20_000),
  command: exactText(20_000).optional(),
}).strict().superRefine((value, context) => {
  if (!unique(value.requirementIds)) {
    context.addIssue({ code: 'custom', path: ['requirementIds'], message: '需求关联不得重复' });
  }
  if (value.kind === 'command' && !value.command) {
    context.addIssue({ code: 'custom', path: ['command'], message: '命令类验收必须提供 command' });
  }
  if (value.kind !== 'command' && value.command !== undefined) {
    context.addIssue({ code: 'custom', path: ['command'], message: '只有命令类验收可以提供 command' });
  }
});

const AssumptionZ = z.object({
  id: z.string().regex(assumptionId),
  text: exactText(20_000),
}).strict();

/** Strict payload accepted by the architecture-layer contract_submit tool. */
export const ContractSubmissionZ = z.object({
  requirements: z.array(RequirementZ).min(1).max(1_000),
  acceptance: z.array(AcceptanceZ).min(1).max(1_000),
  assumptions: z.array(AssumptionZ).max(1_000).optional(),
}).strict();

const SourceZ = z.object({
  id: exactIdentifier,
  sha256: z.string().regex(sha256),
}).strict();

const ArtifactZ = z.object({
  name: z.enum(['PRD.md', 'ARCHITECTURE.md']),
  ref: exactText(2_000).refine(value => value === value.trim(), '产物引用前后不得包含空白'),
  sha256: z.string().regex(sha256),
}).strict();

const ValidationInputZ = z.object({
  submission: z.unknown(),
  prdMarkdown: z.string().min(1).max(10_000_000),
  sources: z.array(SourceZ).max(10_000),
  artifacts: z.array(ArtifactZ).max(2),
}).strict();

export type ContractSubmission = z.infer<typeof ContractSubmissionZ>;
export type ContractSource = z.infer<typeof SourceZ>;
export type ContractArtifact = z.infer<typeof ArtifactZ>;

export interface ContractIssue {
  code: string;
  path: string;
  message: string;
}

export interface FrozenContract {
  readonly version: 1;
  readonly requirements: readonly Readonly<Required<ContractSubmission['requirements'][number]>>[];
  readonly acceptance: readonly Readonly<ContractSubmission['acceptance'][number]>[];
  readonly assumptions: readonly Readonly<NonNullable<ContractSubmission['assumptions']>[number]>[];
  readonly sources: readonly Readonly<ContractSource>[];
  readonly artifacts: readonly Readonly<ContractArtifact>[];
  readonly sha256: string;
}

export type ContractValidationResult =
  | { ok: true; contract: FrozenContract }
  | { ok: false; issues: ContractIssue[] };

export interface ContractValidationInput {
  submission: unknown;
  prdMarkdown: string;
  sources: readonly ContractSource[];
  artifacts: readonly ContractArtifact[];
}

export interface PrdContractIds {
  requirements: string[];
  acceptance: string[];
  duplicateRequirements: string[];
  duplicateAcceptance: string[];
}

const definition = /^\s*(?:(?:#{1,6}|[-*+]|\d+[.)])\s+|\|\s*)?(?:\*\*)?(R-\d{3}|AC-\d{3})(?:\*\*)?(?=\s*(?:[:：|.\-–—]|$)|\s+)/u;

/** Extract IDs that define PRD entries at the start of a Markdown line. */
export function extractPrdContractIds(markdown: string): PrdContractIds {
  const requirements: string[] = [];
  const acceptance: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const id = definition.exec(line)?.[1];
    if (!id) continue;
    (id.startsWith('R-') ? requirements : acceptance).push(id);
  }
  const duplicates = (values: readonly string[]) => [...new Set(values.filter((id, index) => values.indexOf(id) !== index))].sort();
  return {
    requirements: [...new Set(requirements)].sort(),
    acceptance: [...new Set(acceptance)].sort(),
    duplicateRequirements: duplicates(requirements),
    duplicateAcceptance: duplicates(acceptance),
  };
}

type ContractBody = Omit<FrozenContract, 'sha256'>;

/** Serialize the frozen contract body in its already-normalized canonical order. */
export function canonicalContractJson(contract: ContractBody | FrozenContract): string {
  const { version, requirements, acceptance, assumptions, sources, artifacts } = contract;
  return JSON.stringify({ version, requirements, acceptance, assumptions, sources, artifacts });
}

const pathText = (path: readonly PropertyKey[]): string => path.length ? path.map(String).join('.') : '$';
const zodIssues = (error: z.ZodError, prefix = ''): ContractIssue[] => error.issues.map(issue => ({
  code: 'INVALID_SHAPE',
  path: [prefix, pathText(issue.path)].filter(Boolean).join('.'),
  message: issue.message,
}));
const add = (issues: ContractIssue[], code: string, path: string, message: string): void => {
  issues.push({ code, path, message });
};
const duplicates = (values: readonly string[]): string[] => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
const compareIds = (actual: readonly string[], expected: readonly string[], onMissing: (id: string) => void, onExtra: (id: string) => void): void => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const id of expected) if (!actualSet.has(id)) onMissing(id);
  for (const id of actual) if (!expectedSet.has(id)) onExtra(id);
};

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validate cross-references and return a deterministic, deeply frozen CONTRACT.json value. */
export function validateContractSubmission(input: ContractValidationInput): ContractValidationResult {
  const envelope = ValidationInputZ.safeParse(input);
  if (!envelope.success) return { ok: false, issues: zodIssues(envelope.error) };
  const parsed = ContractSubmissionZ.safeParse(envelope.data.submission);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, 'submission') };

  const submission = parsed.data;
  const issues: ContractIssue[] = [];
  const prd = extractPrdContractIds(envelope.data.prdMarkdown);
  const requirementIds = submission.requirements.map(item => item.id);
  const acceptanceIds = submission.acceptance.map(item => item.id);
  const assumptionIds = (submission.assumptions ?? []).map(item => item.id);
  const sourceIds = envelope.data.sources.map(item => item.id);

  for (const id of duplicates(requirementIds)) add(issues, 'DUPLICATE_REQUIREMENT', 'submission.requirements', `需求 ${id} 重复；每个需求 ID 只能提交一次`);
  for (const id of duplicates(acceptanceIds)) add(issues, 'DUPLICATE_ACCEPTANCE', 'submission.acceptance', `验收条目 ${id} 重复；每个验收 ID 只能提交一次`);
  for (const id of duplicates(assumptionIds)) add(issues, 'DUPLICATE_ASSUMPTION', 'submission.assumptions', `假设 ${id} 重复；每个假设 ID 只能声明一次`);
  for (const id of duplicates(sourceIds)) add(issues, 'DUPLICATE_SOURCE', 'sources', `来源 ${id} 重复；请只传入一份带固定哈希的来源`);
  for (const id of prd.duplicateRequirements) add(issues, 'DUPLICATE_PRD_REQUIREMENT', 'prdMarkdown', `PRD 重复定义需求 ${id}；请保留一个定义`);
  for (const id of prd.duplicateAcceptance) add(issues, 'DUPLICATE_PRD_ACCEPTANCE', 'prdMarkdown', `PRD 重复定义验收条目 ${id}；请保留一个定义`);

  compareIds(requirementIds, prd.requirements,
    id => add(issues, 'MISSING_PRD_REQUIREMENT', 'submission.requirements', `PRD 中的需求 ${id} 未出现在契约提交中`),
    id => add(issues, 'UNKNOWN_PRD_REQUIREMENT', 'submission.requirements', `契约需求 ${id} 未在 PRD 中定义`));
  compareIds(acceptanceIds, prd.acceptance,
    id => add(issues, 'MISSING_PRD_ACCEPTANCE', 'submission.acceptance', `PRD 中的验收条目 ${id} 未出现在契约提交中；请补齐后重试`),
    id => add(issues, 'UNKNOWN_PRD_ACCEPTANCE', 'submission.acceptance', `契约验收条目 ${id} 未在 PRD 中定义`));

  const knownRequirements = new Set(requirementIds);
  const knownAssumptions = new Set(assumptionIds);
  const knownSources = new Set(sourceIds);
  const referencedAssumptions = new Set<string>();
  const mappedRequirements = new Set<string>();
  for (const [index, requirement] of submission.requirements.entries()) {
    for (const id of requirement.sourceIds ?? []) {
      if (!knownSources.has(id)) add(issues, 'UNKNOWN_SOURCE', `submission.requirements.${index}.sourceIds`, `需求 ${requirement.id} 引用了不存在的来源 ${id}；请使用传入来源的精确 ID`);
    }
    for (const id of requirement.assumptionIds ?? []) {
      if (!knownAssumptions.has(id)) add(issues, 'UNKNOWN_ASSUMPTION', `submission.requirements.${index}.assumptionIds`, `需求 ${requirement.id} 引用了未声明的假设 ${id}`);
      else referencedAssumptions.add(id);
    }
  }
  for (const id of assumptionIds) {
    if (!referencedAssumptions.has(id)) add(issues, 'UNUSED_ASSUMPTION', 'submission.assumptions', `假设 ${id} 没有被任何需求引用；请删除它或在对应需求的 assumptionIds 中引用`);
  }
  for (const [index, acceptance] of submission.acceptance.entries()) {
    for (const id of acceptance.requirementIds) {
      if (!knownRequirements.has(id)) add(issues, 'UNKNOWN_REQUIREMENT_RELATION', `submission.acceptance.${index}.requirementIds`, `验收条目 ${acceptance.id} 指向不存在的需求 ${id}`);
      else mappedRequirements.add(id);
    }
  }
  for (const id of requirementIds) {
    if (!mappedRequirements.has(id)) add(issues, 'UNMAPPED_REQUIREMENT', 'submission.acceptance', `需求 ${id} 没有任何验收条目覆盖；请在至少一条 AC 的 requirementIds 中加入它`);
  }

  const artifactNames = envelope.data.artifacts.map(item => item.name);
  for (const name of ['PRD.md', 'ARCHITECTURE.md'] as const) {
    const count = artifactNames.filter(item => item === name).length;
    if (count === 0) add(issues, 'MISSING_ARTIFACT', 'artifacts', `缺少 ${name} 的固定引用和 SHA-256`);
    if (count > 1) add(issues, 'DUPLICATE_ARTIFACT', 'artifacts', `${name} 只能固定一次，实际收到 ${count} 份`);
  }
  if (issues.length) return { ok: false, issues };

  const referencedSources = new Set(submission.requirements.flatMap(item => item.sourceIds ?? []));
  const body: ContractBody = {
    version: 1,
    requirements: submission.requirements.map(item => ({
      id: item.id,
      text: item.text,
      sourceIds: [...(item.sourceIds ?? [])].sort(),
      assumptionIds: [...(item.assumptionIds ?? [])].sort(),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    acceptance: submission.acceptance.map(item => ({
      id: item.id,
      requirementIds: [...item.requirementIds].sort(),
      kind: item.kind,
      description: item.description,
      ...(item.command === undefined ? {} : { command: item.command }),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    assumptions: [...(submission.assumptions ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    sources: envelope.data.sources.filter(item => referencedSources.has(item.id)).sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: [...envelope.data.artifacts].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const digest = createHash('sha256').update(canonicalContractJson(body)).digest('hex');
  return { ok: true, contract: deepFreeze({ ...body, sha256: digest }) as FrozenContract };
}
