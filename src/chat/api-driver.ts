import { createHash } from 'node:crypto';
import { modelSpecHash, requireModel } from '../providers/registry.js';
import { ScriptedProvider } from '../providers/scripted.js';
import type { ModelProvider, ModelSpec, ProviderEvent, ProviderInput, ProviderUsage } from '../providers/types.js';
import { providerSdkVersions, type ModelVerification } from '../providers/verification.js';
import type { ApiChatBinding, ResolvedSeat, Roster } from './roster.js';
import type { ChatDriver, DriverCapability, DriverInput, DriverResult, ToolReply } from './types.js';
import { assessWindow, calibrateEstimate, contextPolicy, estimateTokens, resolveLimits, WINDOW_REMINDER, type ContextPolicy, type ContextSettings, type WindowLimits } from './window.js';

export interface ApiChatBindingOptions {
  providerFor?: (model: ModelSpec) => ModelProvider;
  offline?: true;
  context?: ContextSettings;
}

type SimulatedProvider = ModelProvider & { readonly simulated?: boolean };
const PARALLEL_READ_TOOLS = new Set([
  'file_list', 'file_read', 'file_search', 'workspace_changes',
  'plan_read', 'execution_read', 'session_file_list', 'session_file_read',
  'task_state', 'task_evidence', 'user_source_list', 'user_source_read', 'result_read',
]);

function hasUnknownExit(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { exitConfirmed?: unknown }).exitConfirmed === false;
}

function confirmedError(value: unknown): Error & { exitConfirmed: boolean } {
  const error = value instanceof Error ? value : new Error(String(value));
  if (typeof (error as Error & { exitConfirmed?: unknown }).exitConfirmed !== 'boolean') Object.assign(error, { exitConfirmed: true });
  return error as Error & { exitConfirmed: boolean };
}

function unknownToolExit(name: string): Error & { exitConfirmed: false } {
  return Object.assign(new Error(`宿主工具 ${name} 的退出状态未知`), { exitConfirmed: false as const });
}

function unavailable(seat: ResolvedSeat, model: ModelSpec | undefined, reasons: string[], limits?: WindowLimits): ChatDriver {
  const capability: DriverCapability = {
    role: seat.id,
    available: false,
    reason: reasons.join('；'),
    isolationVerified: true,
    isolationBasis: 'api-no-local-process',
    ...(limits ? { contextHard: limits.hard } : {}),
    ...(model ? { model: model.id, effort: seat.binding.effort, provider: model.provider, contextWindow: model.contextWindow } : {}),
  };
  return { capability, async invoke() { throw Object.assign(new Error(capability.reason), { exitConfirmed: true }); } };
}

function sdkVersionFor(model: ModelSpec, versions: ModelVerification['sdkVersions']): string {
  if (model.protocol === 'anthropic-messages') return versions.anthropic;
  if (model.protocol === 'google-genai') return versions.google;
  return versions.openai;
}

function usageValue(event: ProviderUsage): Omit<ProviderUsage, 'type'> {
  const { type: _type, ...usage } = event;
  return usage;
}

function result(text: string, model: ModelSpec, used: number, finishReason: string): DriverResult {
  return { text, exitConfirmed: true, contextWindow: model.contextWindow, contextUsed: used, finishReason };
}

function markDelivered(input: DriverInput, receiptIds: readonly string[]): void {
  for (const id of receiptIds) {
    const delivery = input.invocation.toolReceiptDeliveries?.find(item => item.id === id);
    if (!delivery) throw new Error(`宿主工具回执 ${id} 缺少交付记录`);
    delivery.delivered = true;
  }
}

function rotateHard(text: string, model: ModelSpec, used: number, input: DriverInput): DriverResult {
  input.invocation.rotationReason = 'hard';
  return result(text, model, used, 'rotate');
}

async function invokeProvider(provider: ModelProvider, model: ModelSpec, seat: ResolvedSeat, limits: WindowLimits, input: DriverInput): Promise<DriverResult> {
  if (input.signal.aborted) return result('', model, 0, 'cancelled');
  input.invocation.model = model.id;
  input.invocation.effort = seat.binding.effort;
  const first: ProviderInput = { text: input.prompt };
  const initialMaterial = { system: input.systemPrompt, tools: input.tools, input: first };
  const initialEstimate = estimateTokens(initialMaterial);
  const initialCeilingEstimate = estimateTokens(initialMaterial, 2);
  if (initialEstimate > limits.initialMaxTokens || initialEstimate + limits.outputReserve > limits.hard) {
    throw new Error(`新窗口首个请求材料估算 ${initialEstimate} tokens 超过 ${limits.initialMaxTokens} 上限`);
  }
  if (initialCeilingEstimate + limits.outputReserve > limits.ceiling) {
    throw new Error(`新窗口首个请求材料的保守估算 ${initialCeilingEstimate} tokens 超过物理窗口天花板`);
  }
  const session = provider.open({
    model,
    effort: seat.binding.effort,
    system: input.systemPrompt,
    tools: input.tools,
    maxOutputTokens: limits.outputReserve,
    cacheKey: input.task.id,
    ...((input.requestHooks || input.startApiRequest) ? { requestHooks: {
      ...input.requestHooks,
      beforeAttempt: async (signal: AbortSignal) => {
        const release = await input.requestHooks?.beforeAttempt?.(signal) ?? (() => {});
        try {
          signal.throwIfAborted();
          input.startApiRequest?.();
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
    } } : {}),
    ...(seat.binding.providerOptions ? { providerOptions: seat.binding.providerOptions } : {}),
  });
  let text = '';
  let used = 0;
  let continuationUsed = false;
  let warned = false;
  let calibration = 1;
  let next = first;
  let pendingReceiptIds: string[] = [];
  let firstRequest = true;
  let previousInput = 0;
  try {
    while (true) {
      let estimatedDelta = initialEstimate;
      let reservedInput = initialCeilingEstimate;
      if (!firstRequest) {
        let assessment = assessWindow(used, next, limits, calibration);
        if (assessment.warn && !warned && next.toolResults?.length) {
          next.toolResults[next.toolResults.length - 1]!.text += `\n\n${WINDOW_REMINDER}`;
          warned = true;
          assessment = assessWindow(used, next, limits, calibration);
        }
        if (assessment.rotate) return rotateHard(text, model, used, input);
        estimatedDelta = assessment.estimatedDelta;
        reservedInput = assessment.ceilingProjected - limits.outputReserve;
      }
      if (input.signal.aborted) return result(text, model, used, 'cancelled');
      if (input.reserveApiRequest?.(model, reservedInput, limits.outputReserve) === false) {
        return result(text, model, used, 'budget_pause');
      }
      const sentReceiptIds = pendingReceiptIds;
      pendingReceiptIds = [];
      const calls: Extract<ProviderEvent, { type: 'tool_call' }>[] = [];
      let reason: Extract<ProviderEvent, { type: 'end' }>['reason'] | undefined;
      let responseUsage: ProviderUsage | undefined;
      try {
        for await (const event of session.send(next, input.signal)) {
          if (event.type === 'text') { text += event.delta; input.onText(event.delta); }
          else if (event.type === 'tool_call') calls.push(event);
          else if (event.type === 'usage') { responseUsage = event; input.invocation.usage = usageValue(event); }
          else if (event.type === 'end') reason = event.reason;
        }
      } finally {
        input.settleApiRequest?.(model, responseUsage ? usageValue(responseUsage) : undefined);
      }
      const occupancy = session.occupancy();
      used = occupancy.input + occupancy.output;
      if (responseUsage) {
        calibration = calibrateEstimate(calibration, estimatedDelta, firstRequest ? responseUsage.input : Math.max(0, responseUsage.input - previousInput));
        previousInput = responseUsage.input;
      }
      firstRequest = false;
      input.invocation.peakUsed = Math.max(input.invocation.peakUsed ?? 0, used);
      if (!reason) throw new Error('API 响应缺少结束原因');
      if (reason !== 'context_overflow' && responseUsage) {
        markDelivered(input, sentReceiptIds);
        if (sentReceiptIds.length) input.onReceiptsDelivered?.(sentReceiptIds);
      }
      if (used > limits.ceiling) return result(text, model, used, 'context_ceiling_breach');
      if (reason === 'context_overflow' || !responseUsage) return result(text, model, used, reason);
      input.onContext?.({ window: model.contextWindow, used });
      if (input.signal.aborted) return result(text, model, used, 'cancelled');
      if (reason === 'tool_calls') {
        if (!calls.length) throw new Error('API 声明工具调用但没有提供调用内容');
        const replies: ToolReply[] = [];
        if (calls.every(call => PARALLEL_READ_TOOLS.has(call.name))) {
          const settled = await Promise.allSettled(calls.map(call => input.callTool(call.name, call.args)));
          const unknown = settled.findIndex(item => item.status === 'rejected' ? hasUnknownExit(item.reason) : item.value.processExitConfirmed === false);
          if (unknown >= 0) {
            const outcome = settled[unknown]!;
            if (outcome.status === 'rejected') throw outcome.reason;
            throw unknownToolExit(calls[unknown]!.name);
          }
          const rejected = settled.find(item => item.status === 'rejected');
          if (rejected?.status === 'rejected') throw rejected.reason;
          replies.push(...settled.map(item => (item as PromiseFulfilledResult<Awaited<ReturnType<DriverInput['callTool']>>>).value));
        } else {
          for (const call of calls) {
            if (input.signal.aborted) return result(text, model, used, 'cancelled');
            const reply = await input.callTool(call.name, call.args);
            if (reply.processExitConfirmed === false) throw unknownToolExit(call.name);
            replies.push(reply);
            if (reply.stop) return result(text, model, used, reply.stop);
          }
        }
        if (input.signal.aborted) return result(text, model, used, 'cancelled');
        const stopped = replies.find(reply => reply.stop);
        if (stopped?.stop) return result(text, model, used, stopped.stop);
        const toolResults = calls.map((call, index) => ({ callId: call.callId, text: replies[index]!.text }));
        pendingReceiptIds = replies.flatMap(reply => reply.receiptId ? [reply.receiptId] : []);
        next = { toolResults };
        continue;
      }
      if (reason === 'max_output' && !continuationUsed) {
        continuationUsed = true;
        next = { text: '请继续上一条未完成的输出。' };
        continue;
      }
      return result(text, model, used, reason === 'stop' ? 'completed' : reason);
    }
  } catch (error) {
    if (hasUnknownExit(error)) throw error;
    if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return result(text, model, used, 'cancelled');
    throw confirmedError(error);
  }
}

/** Bind every resolved roster seat to its exact verified model without provider fallback. */
export function createApiChatBinding(
  roster: Roster,
  registry: ReadonlyMap<string, ModelSpec>,
  proof: ModelVerification | null,
  options: ApiChatBindingOptions = {},
): ApiChatBinding {
  const providerFor = options.providerFor;
  let installed: ModelVerification['sdkVersions'] | null = null;
  let sdkError = '';
  if (!options.offline) {
    try { installed = providerSdkVersions(); } catch { sdkError = '无法读取当前 Provider SDK 版本'; }
  }
  return {
    roster,
    registry,
    ...(options.context ? { context: options.context } : {}),
    modelCheckStatus(model) {
      if (options.offline) return 'simulated';
      const check = proof?.models.find(item => item.id === model.id);
      if (!check || !proof) return 'unchecked';
      if (check.provider !== model.provider || check.specHash !== modelSpecHash(model) || !installed ||
        sdkVersionFor(model, installed) !== sdkVersionFor(model, proof.sdkVersions)) return 'stale';
      return check.status;
    },
    resolveDriver(seat, expectedModelSpecHash, policy) {
      let model: ModelSpec | undefined;
      const reasons: string[] = [];
      try { model = requireModel(registry, seat.binding.model, seat.binding.effort); }
      catch (error) { reasons.push(error instanceof Error ? `型号绑定无效：${error.message}` : '型号绑定无效'); }
      if (!model) return unavailable(seat, undefined, reasons);
      const actualHash = modelSpecHash(model);
      if (expectedModelSpecHash && expectedModelSpecHash !== actualHash) reasons.push('型号规格与聊天冻结记录不一致');
      let provider: ModelProvider | undefined;
      if (options.offline) {
        try { provider = providerFor?.(model); } catch { reasons.push('无法创建模拟 Provider'); }
        const simulated = provider instanceof ScriptedProvider || (provider as SimulatedProvider | undefined)?.simulated === true;
        if (!options.providerFor || !simulated) reasons.push('离线模式只允许显式注入模拟 Provider');
      } else {
        if (!process.env[model.apiKeyEnv]?.trim()) reasons.push(`缺少环境变量 ${model.apiKeyEnv}`);
        if (!proof) reasons.push('缺少型号核对证明');
        else {
          const check = proof.models.find(item => item.id === model!.id);
          if (!check || check.provider !== model.provider || check.specHash !== actualHash || check.status !== 'verified') reasons.push('当前 API 账户未核对该完整型号 ID');
          const actualSdk = installed ? sdkVersionFor(model, installed) : '';
          const provenSdk = sdkVersionFor(model, proof.sdkVersions);
          if (sdkError) reasons.push(sdkError);
          else if (actualSdk !== provenSdk) reasons.push(`Provider SDK 版本已变化（核对 ${provenSdk}，当前 ${actualSdk}）`);
        }
        if (!reasons.length && providerFor) {
          try { provider = providerFor(model); } catch { reasons.push('无法创建型号对应的 Provider'); }
        }
      }
      if (provider && provider.protocol !== model.protocol) reasons.push('Provider 协议与型号注册信息不一致');
      let limits: WindowLimits | undefined;
      try { limits = resolveLimits(model, policy ?? contextPolicy(options.context, seat.id, seat.kind === 'worker')); }
      catch (error) { reasons.push(error instanceof Error ? `窗口策略无效：${error.message}` : '窗口策略无效'); }
      if (reasons.length) return unavailable(seat, model, reasons, limits);
      const version = options.offline ? 'simulated' : sdkVersionFor(model, installed!);
      const capability: DriverCapability = {
        role: seat.id,
        available: true,
        version,
        fingerprint: createHash('sha256').update(JSON.stringify([seat.id, model.id, seat.binding.effort, actualHash, version])).digest('hex'),
        isolationVerified: true,
        isolationBasis: 'api-no-local-process',
        contextWindow: model.contextWindow,
        contextHard: limits!.hard,
        model: model.id,
        effort: seat.binding.effort,
        provider: model.provider,
      };
      return { capability, async invoke(input) {
        try {
          const adapter = provider ?? (await import('../providers/factory.js')).modelProviderFor(model.protocol);
          return await invokeProvider(adapter, model, seat, limits!, input);
        }
        catch (error) { if (hasUnknownExit(error)) throw error; throw confirmedError(error); }
      } };
    },
  };
}
