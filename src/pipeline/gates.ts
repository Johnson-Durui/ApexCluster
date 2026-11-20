import { pendingPipelineGate, pipelineGateActionSchema, type PipelineGateId, type PipelineState } from './state.js';

export type GateAction = ReturnType<typeof pipelineGateActionSchema.parse>;

export function beginArchitectureRevision(state: PipelineState, now: string) {
  if (state.contract) state.priorContracts.push(state.contract);
  delete state.contract;
  delete state.demoRepairFrom;
  state.stage = 'architecture';
  state.revision++;
  state.revisionStartedAt = now;
}

/** Only a currently pending gate accepts a decision. Automatic decisions obey the frozen policy. */
export function validatePipelineGate(state: PipelineState, gateId: PipelineGateId, raw: unknown, automatic = false): GateAction {
  const input = pipelineGateActionSchema.parse(raw);
  if (pendingPipelineGate(state) !== gateId) throw new Error('该关卡当前未开放');
  if (automatic && (input.decision !== 'confirm' || state.gates[gateId === 'A' ? 'architecture' : 'delivery'] !== 'auto')) {
    throw new Error('当前关卡需要用户决定');
  }
  if (gateId === 'A' && input.decision === 'confirm' && !state.contract) throw new Error('需求与验收契约尚未冻结');
  return input;
}

/** Apply one validated decision after its immutable message has been registered. */
export function applyPipelineGate(state: PipelineState, gateId: PipelineGateId, action: GateAction, messageId: string, automatic: boolean, now: string) {
  validatePipelineGate(state, gateId, action, automatic);
  state.gateDecisions.push({ gateId, decision: action.decision, messageId, automatic, revision: state.revision });
  if (action.decision === 'cancel') { state.stage = 'cancelled'; return; }
  if (action.decision === 'confirm') {
    state.stage = gateId === 'A' ? 'implementation' : 'completed';
    return;
  }
  if (gateId === 'B') { state.stage = 'implementation'; return; }
  beginArchitectureRevision(state, now);
}
