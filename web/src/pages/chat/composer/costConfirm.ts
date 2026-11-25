// Cost confirmation (BUILD-SPEC-B §4.7 foot). Confirming is persisted only on an actual send; 撤销 unchecks it and
// removes the stored confirmation. Storage access is wrapped: a throwing sessionStorage means "not confirmed".
export const COST_KEY = 'dmw:chat:cost-confirmed:v1';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const session = (): Store | undefined => typeof sessionStorage === 'undefined' ? undefined : sessionStorage;

export function readCostConfirmed(storage: Store | undefined = session()): boolean {
  try { return storage?.getItem(COST_KEY) === '1'; } catch { return false; }
}

export function persistCostConfirmed(storage: Store | undefined = session()) {
  try { storage?.setItem(COST_KEY, '1'); } catch { /* the in-memory confirmation still holds for this page */ }
}

export function revokeCostConfirmation(storage: Store | undefined = session()) {
  try { storage?.removeItem(COST_KEY); } catch { /* nothing stored */ }
}

/** What still blocks sending, in the order the user meets it (only missing items). */
export function missingForSend({ hasContent, costConfirmed, needsCost, pipeline, workspace, preset, teamInvalid = false }: {
  hasContent: boolean; costConfirmed: boolean; needsCost: boolean; pipeline: boolean; workspace: boolean; preset: boolean; teamInvalid?: boolean;
}): string[] {
  const missing: string[] = [];
  if (!hasContent) missing.push('输入内容');
  if (needsCost && !costConfirmed) missing.push('额度确认');
  if (pipeline && !workspace) missing.push('项目目录');
  if (pipeline && !preset) missing.push('流水线预设');
  if (!pipeline && teamInvalid) missing.push('自定义团队配置');
  return missing;
}
