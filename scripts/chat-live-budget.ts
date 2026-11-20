import type { ChatRole } from '../src/chat/types.js';

export interface LiveBudgetState {
  maximumNativeCallsReserved: number;
  nativeCallsReserved: number;
  nativeCliInvocations: number;
  nativeCallsReservedByRole: Partial<Record<ChatRole, number>>;
  nativeCliInvocationsByRole: Partial<Record<ChatRole, number>>;
}

export class LiveNativeCallBudgetExceeded extends Error {
  readonly exitConfirmed = true;
  constructor(reserved: number, maximum: number) {
    super(`原生调用预算已满：${reserved}/${maximum}`);
    this.name = 'LiveNativeCallBudgetExceeded';
  }
}

export class LiveNativeCallBudget {
  constructor(private readonly state: LiveBudgetState, private readonly persist: () => void) {}

  reserve(role: ChatRole, observedAtNativeDispatch: boolean): void {
    if (this.state.nativeCallsReserved >= this.state.maximumNativeCallsReserved) {
      throw new LiveNativeCallBudgetExceeded(this.state.nativeCallsReserved, this.state.maximumNativeCallsReserved);
    }
    this.state.nativeCallsReserved += 1;
    this.state.nativeCallsReservedByRole[role] = (this.state.nativeCallsReservedByRole[role] ?? 0) + 1;
    if (observedAtNativeDispatch) {
      this.state.nativeCliInvocations += 1;
      this.state.nativeCliInvocationsByRole[role] = (this.state.nativeCliInvocationsByRole[role] ?? 0) + 1;
    }
    this.persist();
  }

  async runObserved<T>(role: ChatRole, dispatch: () => Promise<T>): Promise<T> {
    this.reserve(role, true);
    return dispatch();
  }
}
