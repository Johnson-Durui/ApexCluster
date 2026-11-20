// 新建评审 (#/new, BUILD-SPEC-B §6.3): section index | form | sticky launch card. One real run per submit, after a
// confirm sheet. Field labels, option orders and helper strings are kept (NewPage.test and the v05 QA scripts pin them).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import type { AppConfig, BuildOptions, CreateRunInput, Effort, ModelRole, ReferenceArchive, ReferenceDocument, Run } from '../../lib/types';
import { Field, Icon, Modal, type StatusKind } from '../../components/ui';
import { Crumb } from '../../components/shell/TopBar';
import { TopBarActions, TopBarTitle } from '../../components/shell/ShellSlots';
import { ReferenceDocumentsEditor } from './ReferenceDocumentsEditor';
import { draftKey, readTaskDraft } from './taskDraft';
import { CallEstimate, designNames, effortNames, FormSection, inRange, LaunchCard, LimitField, RequiredField, type CheckItem } from './NewParts';
import { jumpToSection, SectionNav } from './SectionNav';
import './new.css';

type PrimaryRole = Exclude<ModelRole, 'grok'>;
type DocKind = 'handbook' | 'devdoc' | 'prd';
const roles: PrimaryRole[] = ['claude', 'astra', 'sol'];
const roleNames: Record<ModelRole, string> = { claude: 'Claude', astra: 'Astra', sol: 'Sol', grok: 'Grok' };
const roleDuty: Record<ModelRole, string> = { claude: '统一澄清、主导架构与终审', astra: '围绕 Claude 方案补充评审、关键分歧裁决', sol: '在隔离工作区构建最小 MVP', grok: '带来源锚点的摘要、问题分组与受限轻量返工' };
const effortOptions: Record<PrimaryRole, Effort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  astra: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  sol: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};
const defaultBuild: BuildOptions = { autoRework: false, maxRounds: 3, maxWriterSessions: 12, maxModelCalls: 20, maxActiveMinutes: 360, resumePolicy: 'never', lightReworkEnabled: false, lightReworkMinutes: 5 };
const LIMIT_NAMES = ['maxRounds', 'maxWriterSessions', 'maxModelCalls', 'maxActiveMinutes', 'lightRework', 'evaluatorTimeout', 'finalReviewTimeout'];

type ConstraintDraft = { id: number; text: string; kind: 'must' | 'must_not' };
export function buildFeatureInput(input: {
  build: BuildOptions; contextEnabled: boolean; resumePolicy: BuildOptions['resumePolicy']; evaluatorEnabled: boolean; lightReworkAvailable: boolean; lightReworkSupported: boolean;
  digestEnabled: boolean; qgroupEnabled: boolean; grokAvailable: boolean;
  designMode: 'auto' | 'dual' | 'single'; riskLevel: 'low' | 'medium' | 'high';
  docWriters: Record<DocKind, { role: PrimaryRole; effort: Effort }>;
}): Pick<CreateRunInput, 'build' | 'contextBudget' | 'chores' | 'designMode' | 'riskLevel' | 'docWriters'> {
  const build: BuildOptions = { ...input.build, resumePolicy: input.contextEnabled ? input.resumePolicy : 'never', lightReworkEnabled: Boolean(input.build.lightReworkEnabled && input.evaluatorEnabled && !input.contextEnabled && input.lightReworkAvailable), lightReworkMinutes: input.build.lightReworkMinutes ?? 5 };
  if (!input.lightReworkSupported) { delete build.lightReworkEnabled; delete build.lightReworkMinutes; }
  return {
    build,
    contextBudget: { enabled: input.contextEnabled },
    chores: { digest: input.digestEnabled && input.grokAvailable, qgroup: input.qgroupEnabled && input.grokAvailable },
    designMode: input.designMode, riskLevel: input.riskLevel, docWriters: input.docWriters,
  };
}

export default function NewPage({ onCreated }: { onCreated: (run: Run) => void }) {
  const [draft] = useState(() => { try { return readTaskDraft(sessionStorage); } catch { return readTaskDraft({ getItem: () => null }); } });
  const created = useRef(false);
  const createLock = useRef(false);
  const mounted = useRef(true);
  const [draftWarning, setDraftWarning] = useState('');
  const [draftNotice, setDraftNotice] = useState(draft.discardedAttachments ? `已忽略 ${draft.discardedAttachments} 份损坏的草稿附件，需求正文仍保留；可重新导入资料。` : '');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [coreFlows, setCoreFlows] = useState(draft.coreFlows);
  const [existingStack, setExistingStack] = useState(draft.existingStack);
  const [deployment, setDeployment] = useState(draft.deployment);
  const [budget, setBudget] = useState(draft.budget);
  const [acceptance, setAcceptance] = useState(draft.acceptance);
  const [context, setContext] = useState(draft.context);
  const [constraints, setConstraints] = useState<ConstraintDraft[]>([]);
  const [clarifyWith, setClarifyWith] = useState<CreateRunInput['clarifyWith']>('claude');
  const [allowWebResearch, setAllowWebResearch] = useState(true);
  const [preflightEnabled, setPreflightEnabled] = useState(false);
  const [writeDocs, setWriteDocs] = useState(true);
  const [writePrd, setWritePrd] = useState(true);
  const [build, setBuild] = useState<BuildOptions>(defaultBuild);
  const [lightReworkSupported, setLightReworkSupported] = useState(false);
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(false);
  const [evaluatorEffort, setEvaluatorEffort] = useState<Effort>('max');
  const [evaluatorTimeout, setEvaluatorTimeout] = useState(30);
  const [finalReviewEnabled, setFinalReviewEnabled] = useState(false);
  const [finalReviewEffort, setFinalReviewEffort] = useState<Effort>('xhigh');
  const [finalReviewTimeout, setFinalReviewTimeout] = useState(30);
  const [efforts, setEfforts] = useState<Record<PrimaryRole, Effort>>({ claude: 'max', astra: 'max', sol: 'max' });
  const [designMode, setDesignMode] = useState<'auto' | 'dual' | 'single'>('single');
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [contextEnabled, setContextEnabled] = useState(false);
  const [resumePolicy, setResumePolicy] = useState<BuildOptions['resumePolicy']>('never');
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [qgroupEnabled, setQgroupEnabled] = useState(false);
  const [docWriters, setDocWriters] = useState<Record<DocKind, { role: PrimaryRole; effort: Effort }>>({ handbook: { role: 'claude', effort: 'xhigh' }, devdoc: { role: 'astra', effort: 'max' }, prd: { role: 'claude', effort: 'xhigh' } });
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingRun, setPendingRun] = useState<CreateRunInput | null>(null);
  const [referenceDocuments, setReferenceDocuments] = useState<ReferenceDocument[]>(draft.referenceDocuments);
  const [referenceArchives, setReferenceArchives] = useState<ReferenceArchive[]>(draft.referenceArchives);
  const [referencesBusy, setReferencesBusy] = useState(false);
  const [referencesInvalid, setReferencesInvalid] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [limitsOpen, setLimitsOpen] = useState(false);
  const limitsRef = useRef<HTMLDetailsElement>(null);
  const focusLimits = useRef(false);
  const focusConstraint = useRef<number | 'add' | null>(null);
  const addConstraintRef = useRef<HTMLButtonElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const touch = useCallback((name: string) => setTouched(current => current.has(name) ? current : new Set([...current, name])), []);

  useEffect(() => {
    if (created.current) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ title, prompt, coreFlows, existingStack, deployment, budget, acceptance, context, referenceDocuments, referenceArchives })); setDraftWarning(''); }
    catch { setDraftWarning('当前标签页无法保存草稿，离开前请保留需求与资料。'); }
  }, [title, prompt, coreFlows, existingStack, deployment, budget, acceptance, context, referenceDocuments, referenceArchives]);

  const loadConfig = useCallback(() => {
    setConfigError('');
    api.get<AppConfig>('/api/config').then(data => {
      if (!mounted.current) return;
      setConfig(data);
      try {
        const checked = readTaskDraft(sessionStorage, data.referenceLimits);
        setReferenceDocuments(checked.referenceDocuments); setReferenceArchives(checked.referenceArchives);
        if (checked.discardedAttachments) setDraftNotice(`已忽略 ${checked.discardedAttachments} 份不符合当前限制的草稿附件；请重新导入。`);
      } catch { /* 存储不可用时保留内存中的草稿。 */ }
      setEfforts({ claude: data.models.claude.effort, astra: data.models.astra.effort, sol: data.models.sol.effort });
      setPreflightEnabled(data.preflight?.enabled ?? false);
      const supportsLightRework = Boolean(data.build && Object.prototype.hasOwnProperty.call(data.build, 'lightReworkEnabled') && Object.prototype.hasOwnProperty.call(data.build, 'lightReworkMinutes'));
      setLightReworkSupported(supportsLightRework);
      setBuild({ ...defaultBuild, ...(data.build ?? {}), lightReworkEnabled: false, lightReworkMinutes: data.build?.lightReworkMinutes ?? 5 });
      setEvaluatorEnabled(data.evaluator?.enabled ?? false);
      setEvaluatorEffort(data.evaluator?.effort ?? 'max');
      setEvaluatorTimeout(data.evaluator?.timeoutMinutes ?? 30);
      setFinalReviewEnabled(data.finalReview?.enabled ?? false);
      setFinalReviewEffort(data.finalReview?.effort ?? 'xhigh');
      setFinalReviewTimeout(data.finalReview?.timeoutMinutes ?? 30);
      setContextEnabled(false);
      setResumePolicy('never');
      setWeights(Object.fromEntries(data.criteria.map(item => [item.id, item.weight])));
    }).catch(e => { if (mounted.current) setConfigError(e instanceof Error ? e.message : '读取配置失败'); });
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);
  useEffect(() => {
    const target = focusConstraint.current;
    if (target === null) return;
    focusConstraint.current = null;
    if (target === 'add') addConstraintRef.current?.focus(); else document.getElementById(`constraint-${target}`)?.focus();
  }, [constraints]);
  useEffect(() => {
    if (!focusLimits.current) return;
    focusLimits.current = false;
    limitsRef.current?.querySelector<HTMLElement>('[aria-invalid=true]')?.focus();
  });

  const totalWeight = useMemo(() => Object.values(weights).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0), [weights]);
  const weightsOk = Math.abs(totalWeight - 1) <= 0.001;
  const flows = coreFlows.split('\n').map(value => value.trim()).filter(Boolean);
  const activeConstraints = constraints.filter(item => item.text.trim());
  const lightReworkModelReady = config?.models.grok?.model === 'grok-4.7-high-fast' && config.models.grok.effort === 'high';
  const lightReworkAvailable = Boolean(config && lightReworkModelReady && (config.models.grok?.adapter === 'mock' || config.cursorWriteCapabilities?.available));
  const lightReworkBlockReason = !config ? '正在读取能力状态'
    : !lightReworkSupported ? '当前服务未提供轻量返工字段；为兼容旧 strict API，本次不会发送这些字段'
      : !lightReworkModelReady ? 'Grok 必须固定为 grok-4.7-high-fast · High'
      : !lightReworkAvailable ? config.cursorWriteCapabilities?.reason || 'Cursor WSL 写入能力尚未通过验证'
      : !evaluatorEnabled ? '必须先启用 Astra 独立评审'
        : contextEnabled ? '与构建上下文会话预算不能同时开启'
          : null;
  const lightReworkMinutes = build.lightReworkMinutes ?? 5;
  const buildLimitsOk = inRange(build.maxRounds, 1, 4) && inRange(build.maxWriterSessions, 1, 100) && inRange(build.maxModelCalls, 1, 200) && inRange(build.maxActiveMinutes, 1, 1440)
    && inRange(lightReworkMinutes, 1, 15) && (!build.lightReworkEnabled || lightReworkBlockReason === null);
  const reviewLimitsOk = (!evaluatorEnabled || inRange(evaluatorTimeout, 1, 120)) && (!finalReviewEnabled || inRange(finalReviewTimeout, 1, 120));
  const limitsOk = buildLimitsOk && reviewLimitsOk;
  const ready = Boolean(config) && title.trim().length > 0 && prompt.trim().length > 0 && weightsOk && limitsOk && !referencesBusy && !referencesInvalid;
  const normalize = () => {
    if (!config || totalWeight <= 0) return;
    setWeights(Object.fromEntries(config.criteria.map(item => [item.id, Number(((weights[item.id] ?? 0) / totalWeight).toFixed(4))])));
  };
  const updateConstraint = (id: number, patch: Partial<ConstraintDraft>) => setConstraints(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  const addConstraint = () => { const id = Date.now(); focusConstraint.current = id; setConstraints(items => [...items, { id, kind: 'must', text: '' }]); };
  const removeConstraint = (index: number) => { const previous = constraints[index - 1]; focusConstraint.current = previous ? previous.id : 'add'; setConstraints(items => items.filter((_, itemIndex) => itemIndex !== index)); };
  const revealLimits = () => { setLimitsOpen(true); setTouched(current => new Set([...current, ...LIMIT_NAMES])); focusLimits.current = true; };
  const docCalls = (writeDocs ? 2 : 0) + (writePrd ? 1 : 0);
  const grokAvailable = Boolean(config?.models.grok && (config.models.grok.adapter === 'mock' || config.cursorCapabilities?.available));
  const grokReason = config?.models.grok
    ? config.models.grok.adapter === 'mock' ? '服务端 Mock 演示配置；不会声明本机 Cursor 已验证。' : config.cursorCapabilities?.available ? `Cursor 能力已验证${config.cursorCapabilities.verifiedAt ? ` · ${config.cursorCapabilities.verifiedAt}` : ''}` : config.cursorCapabilities?.reason || 'Cursor 能力尚未验证'
    : config ? '服务端未配置 Grok 模型' : '正在读取 Grok 能力状态';
  const resolvedDesign = designMode === 'auto' ? (riskLevel === 'high' || activeConstraints.length >= 4 ? 'dual' : 'single') : designMode;
  const callEstimate = useMemo(() => {
    const base = { claude: 0, astra: 0, sol: contextEnabled ? 2 : 1, grok: 0 };
    if (clarifyWith === 'both') { base.claude += 1; base.astra += 1; }
    else if (clarifyWith === 'claude' || clarifyWith === 'astra') base[clarifyWith] += 1;
    if (resolvedDesign === 'dual') { base.claude += 2; base.astra += 2; }
    else { base.claude += 1; base.astra += 1; }
    if (writeDocs) { base[docWriters.handbook.role] += 1; base[docWriters.devdoc.role] += 1; }
    if (writePrd) base[docWriters.prd.role] += 1;
    if (evaluatorEnabled) base.astra += 1;
    if (finalReviewEnabled) base.claude += 1;
    if (digestEnabled && grokAvailable) base.grok += 1;
    if (qgroupEnabled && grokAvailable) base.grok += 1;
    return { base, total: Object.values(base).reduce((sum, value) => sum + value, 0) };
  }, [clarifyWith, contextEnabled, digestEnabled, docWriters, evaluatorEnabled, finalReviewEnabled, grokAvailable, qgroupEnabled, resolvedDesign, writeDocs, writePrd]);

  async function createRun(body: CreateRunInput) {
    if (createLock.current) return;
    createLock.current = true;
    let submittedDraft: string | null = null;
    try { submittedDraft = sessionStorage.getItem(draftKey); } catch { /* 创建不依赖存储可用性。 */ }
    setSubmitting(true); setError('');
    try {
      const run = await api.post<Run>('/api/runs', body);
      created.current = true;
      try { if (sessionStorage.getItem(draftKey) === submittedDraft) sessionStorage.removeItem(draftKey); } catch { /* 新运行已创建，存储失败不能当作发送失败。 */ }
      window.dispatchEvent(new CustomEvent('workbench:run-created', { detail: { id: run.id, title: run.title } }));
      if (mounted.current) onCreated(run);
    }
    catch (e) { if (mounted.current) { const message = e instanceof Error ? e.message : '创建运行失败'; setError(e instanceof ApiError ? message : `未收到创建结果（${message}）。任务可能已在后台创建，请先检查任务历史，避免重复发送。`); } }
    finally { createLock.current = false; if (mounted.current) setSubmitting(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!config || submitting || referencesBusy) return;
    if (referencesInvalid) { setError('请先处理参考资料区域的错误。'); return; }
    if (!title.trim() || !prompt.trim()) { setTouched(current => new Set([...current, 'title', 'prompt'])); setError('请填写项目标题和要解决的问题。'); return; }
    if (!weightsOk) { setError(`评分权重合计必须为 1，当前为 ${totalWeight.toFixed(3)}。`); return; }
    if (!limitsOk) { setError('请先修正构建、评审或终审的上限。'); revealLimits(); return; }
    if (!acknowledged) { setError('请先确认真实运行会消耗订阅额度。'); return; }
    setError('');
    setPendingRun({
      title: title.trim(), mode: 'real', mockScenario: null,
      project: {
        prompt: prompt.trim(), coreFlows: flows, existingStack, deployment, budget, acceptance, context,
        referenceDocuments: referenceDocuments.map(document => ({ ...document })),
        referenceArchives: referenceArchives.map(archive => ({ id: archive.id })),
      },
      constraints: activeConstraints.map(({ text, kind }) => ({ text: text.trim(), kind })),
      clarifyWith, allowWebResearch, preflightEnabled, writeDocs, writePrd,
      ...buildFeatureInput({ build, contextEnabled, resumePolicy, evaluatorEnabled, lightReworkAvailable, lightReworkSupported, digestEnabled, qgroupEnabled, grokAvailable, designMode, riskLevel, docWriters }),
      evaluator: { enabled: evaluatorEnabled, effort: evaluatorEffort, timeoutMinutes: evaluatorTimeout },
      finalReview: { enabled: finalReviewEnabled, effort: finalReviewEffort, timeoutMinutes: finalReviewTimeout },
      efforts: { ...efforts, docs: docWriters.handbook.effort }, criteriaWeights: weights,
    } as CreateRunInput);
  }

  const titleError = touched.has('title') && !title.trim() ? '请填写项目标题。' : '';
  const promptError = touched.has('prompt') && !prompt.trim() ? '请填写要解决的问题。' : '';
  const referenceCount = referenceDocuments.length + referenceArchives.length;
  const focusField = (id: string) => () => document.getElementById(id)?.focus();
  const checks: CheckItem[] = [
    { key: 'title', label: '项目标题', state: title.trim() ? 'ok' : 'err', onFix: focusField('new-title') },
    { key: 'prompt', label: '要解决的问题', state: prompt.trim() ? 'ok' : 'err', onFix: focusField('new-prompt') },
    { key: 'flows', label: '核心流程', state: flows.length ? 'ok' : 'idle', value: `${flows.length} 项` },
    { key: 'constraints', label: '硬约束', state: activeConstraints.length ? 'ok' : 'idle', value: `${activeConstraints.length} 条` },
    { key: 'references', label: '参考资料', state: referencesInvalid ? 'err' : referenceCount ? 'ok' : 'idle', value: referencesInvalid ? '有错误' : referencesBusy ? '读取中…' : `${referenceCount} 份`, onFix: () => jumpToSection('new-references') },
    { key: 'weights', label: '评分权重合计', state: !config ? 'idle' : weightsOk ? 'ok' : 'err', value: config ? totalWeight.toFixed(3) : '—', onFix: () => jumpToSection('new-s5') },
    { key: 'config', label: '配置', state: config ? 'ok' : configError ? 'err' : 'idle', value: config ? '已读取' : '读取中…', ...(configError ? { onFix: loadConfig, fixLabel: '重试' } : {}) },
    { key: 'limits', label: '构建与评审上限', state: limitsOk ? 'ok' : 'err', value: limitsOk ? '有效' : '需修正', onFix: revealLimits },
    { key: 'ack', label: '额度确认', state: acknowledged ? 'ok' : 'err', onFix: () => ackRef.current?.focus() },
  ];
  const missing = [!title.trim() && '项目标题', !prompt.trim() && '要解决的问题', (referencesInvalid || referencesBusy) && '参考资料', !config && '配置', config && !weightsOk && '评分权重', !limitsOk && '构建与评审上限', !acknowledged && '额度确认'].filter((item): item is string => Boolean(item));
  const sectionState = (ok: boolean, bad: boolean): StatusKind => ok ? 'ok' : bad ? 'err' : 'idle';
  const navItems = [
    { id: 'new-s1', index: '01', label: '项目需求', status: sectionState(Boolean(title.trim() && prompt.trim()) && !referencesInvalid, referencesInvalid || Boolean(titleError || promptError)) },
    { id: 'new-s2', index: '02', label: '硬约束', status: sectionState(activeConstraints.length > 0, false) },
    { id: 'new-s3', index: '03', label: '模型与评审', status: sectionState(Boolean(config), Boolean(configError)) },
    { id: 'new-s4', index: '04', label: '构建前准备', status: sectionState(Boolean(config) && limitsOk, !limitsOk) },
    { id: 'new-s5', index: '05', label: '评分权重', status: sectionState(Boolean(config) && weightsOk, Boolean(config) && !weightsOk) },
  ];
  const limitProps = (name: string) => ({ name, touched: touched.has(name), onBlur: touch });
  const confirm = () => { const body = pendingRun; setPendingRun(null); if (body) void createRun(body); };

  return <form className="page new-page" onSubmit={submit} noValidate>
    <TopBarTitle><Crumb trail={[{ label: '任务历史', href: '#/history' }]} current="新建评审" /></TopBarTitle>
    <TopBarActions><a className="btn ghost" href="#/history">取消</a></TopBarActions>
    <header className="new-head">
      <div><h1>新建评审</h1><p>描述需求与约束。默认由 Claude 统一澄清并主导架构，Astra 围绕同一方案补充评审；所有取舍都在关卡中由你确认。</p></div>
      {draftWarning ? <div className="alert warn new-draft" role="status">{draftWarning}</div> : <p className="new-draft">需求正文与已导入资料会保存在当前标签页；创建成功后清除草稿。约束、开关与权重不进草稿。</p>}
    </header>
    <div className="new-grid">
      <SectionNav className="new-index" label="表单章节" items={navItems} />
      <div className="new-main">
        {configError ? <div className="alert bad new-alert" role="alert"><span>{configError}</span><button type="button" className="btn sm" onClick={loadConfig}>重试</button></div> : null}
        {draftNotice ? <div className="alert warn new-alert" role="status"><span>{draftNotice}</span><button type="button" className="btn sm" onClick={() => { setDraftNotice(''); (document.querySelector<HTMLElement>('.reference-actions button') ?? document.getElementById('new-title'))?.focus(); }}>知道了</button></div> : null}
        <FormSection id="new-s1" index="01" title="项目需求" description="原始需求在后续文档中的来源编号为 REQ-1；请写清楚要解决的问题和核心流程。">
          <div className="form-grid">
            <RequiredField id="new-title" label="项目标题（必填）" error={titleError}><input id="new-title" required maxLength={200} value={title} aria-invalid={Boolean(titleError) || undefined} aria-describedby={titleError ? 'new-title-error' : undefined} onBlur={() => touch('title')} onChange={e => setTitle(e.target.value)} placeholder="例如：本地个人记账与预算工具" /></RequiredField>
            <Field label="部署与运行条件"><input value={deployment} onChange={e => setDeployment(e.target.value)} placeholder="例如：Windows 11 x64，单人本机使用" /></Field>
          </div>
          <RequiredField id="new-prompt" label="要解决的问题（必填）" error={promptError}><textarea id="new-prompt" required rows={5} value={prompt} aria-invalid={Boolean(promptError) || undefined} aria-describedby={promptError ? 'new-prompt-error' : undefined} onBlur={() => touch('prompt')} onChange={e => setPrompt(e.target.value)} placeholder="背景、目标用户、要达成的结果" /></RequiredField>
          <Field label="核心流程" hint="每行一项"><textarea rows={4} value={coreFlows} onChange={e => setCoreFlows(e.target.value)} placeholder={'录入交易\n导入银行 CSV 并去重'} /></Field>
          <div className="form-grid">
            <Field label="已有技术栈"><textarea rows={3} value={existingStack} onChange={e => setExistingStack(e.target.value)} placeholder="团队熟悉或必须沿用的技术" /></Field>
            <Field label="预算和资源"><textarea rows={3} value={budget} onChange={e => setBudget(e.target.value)} placeholder="费用、时间、人力限制" /></Field>
            <Field label="验收要求"><textarea rows={3} value={acceptance} onChange={e => setAcceptance(e.target.value)} placeholder="怎样算做成了" /></Field>
            <Field label="补充背景"><textarea rows={3} value={context} onChange={e => setContext(e.target.value)} placeholder="使用者习惯、已知风险等" /></Field>
          </div>
          {config?.referenceLimits ? <ReferenceDocumentsEditor documents={referenceDocuments} archives={referenceArchives} limits={config.referenceLimits} onDocumentsChange={setReferenceDocuments} onArchivesChange={setReferenceArchives} onBusyChange={setReferencesBusy} onBlockingErrorChange={setReferencesInvalid} /> : null}
        </FormSection>

        <FormSection id="new-s2" index="02" title="硬约束" description="只有两位评审一致判定违反时才会淘汰方案；只有一方判定违反时交给你确认。" action={<button ref={addConstraintRef} type="button" className="btn" onClick={addConstraint}><Icon name="plus" size={15} />添加约束</button>}>
          {constraints.length ? <div className="constraint-list">{constraints.map((item, index) => <div className="constraint-row" key={item.id}>
            <span className="constraint-id mono">H{index + 1}</span>
            <select aria-label={`约束 H${index + 1} 类型`} value={item.kind} onChange={e => updateConstraint(item.id, { kind: e.target.value as ConstraintDraft['kind'] })}><option value="must">必须</option><option value="must_not">禁止</option></select>
            <input id={`constraint-${item.id}`} aria-label={`约束 H${index + 1} 内容`} value={item.text} onChange={e => updateConstraint(item.id, { text: e.target.value })} placeholder="例如：数据必须只保存在本机" />
            <button type="button" className="btn danger" aria-label={`删除约束 H${index + 1}`} onClick={() => removeConstraint(index)}><Icon name="x" size={14} />删除</button>
          </div>)}</div> : <p className="empty-line">暂未设置硬约束。没有约束也可以开始评审。</p>}
        </FormSection>

        <FormSection id="new-s3" index="03" title="模型与评审" description="型号固定，不加后备型号，也不自动降级；强度在创建时冻结。">
          <div className="form-grid">
            <Field label="澄清问题由谁提问"><select aria-label="澄清问题由谁提问" value={clarifyWith} onChange={e => setClarifyWith(e.target.value as CreateRunInput['clarifyWith'])}><option value="both">两边分别提问（兼容模式）</option><option value="claude">Claude 统一提问</option><option value="astra">只用 Astra</option><option value="skip">跳过澄清</option></select></Field>
            <Field label="设计阶段联网检索" hint="文档撰写阶段始终不联网。"><select value={allowWebResearch ? 'yes' : 'no'} onChange={e => setAllowWebResearch(e.target.value === 'yes')}><option value="yes">允许</option><option value="no">不允许</option></select></Field>
            <Field label="设计模式"><select aria-label="设计模式" value={designMode} onChange={e => setDesignMode(e.target.value as typeof designMode)}><option value="auto">自动判断（兼容模式）</option><option value="dual">双架构师独立提案（兼容模式）</option><option value="single">Claude 主导 + Astra 协作评审</option></select><small>{designMode === 'auto' ? `当前输入预估为 ${resolvedDesign === 'dual' ? '双架构师独立提案' : 'Claude 主导架构'}；G1 未答阻塞题达到 3 条时仍会升级。` : resolvedDesign === 'dual' ? '已显式选择兼容的双架构师独立提案。' : '已显式选择 Claude 主导架构，Astra 围绕同一方案补充评审。'}</small></Field>
            <Field label="风险等级"><select aria-label="风险等级" value={riskLevel} onChange={e => setRiskLevel(e.target.value as typeof riskLevel)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>
          </div>
          <div className="model-settings">{roles.map(role => <div className={`model-setting ${role}`} data-seat={role} key={role}>
            <div className="model-setting-head"><b>{roleNames[role]}</b><small>{roleDuty[role]}</small></div>
            <Field label="型号（固定）"><input className="mono" readOnly value={config?.models[role].model ?? '正在读取…'} /></Field>
            <Field label="推理强度"><select value={efforts[role]} onChange={e => setEfforts(old => ({ ...old, [role]: e.target.value as Effort }))}>{effortOptions[role].map(value => <option value={value} key={value}>{effortNames[value]}</option>)}</select></Field>
          </div>)}</div>
          <p className="help-note">在 G2 选择复核后，若双方完整复核仍有关键分歧，会追加一次 gpt-6.2-astra · Ultra 裁决。建议单独展示，不改评分、不自动选择候选、不启动 Sol。</p>
        </FormSection>

        <FormSection id="new-s4" index="04" title="构建前准备" description="环境预检、项目文档和撰写强度会在创建运行时冻结。">
          <div className="doc-switches">
            <label className="switch-row"><input type="checkbox" checked={preflightEnabled} onChange={event => setPreflightEnabled(event.target.checked)} /><span><b>Sol 构建前运行环境预检</b><small>只执行工作台定义的固定检查命令，不调用模型；发现缺失工具时会停在 G4，由你修复、重查或填写理由继续。{config && !config.preflight ? ' 当前服务未提供预检默认值，已按关闭兼容。' : ''}</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={writeDocs} onChange={event => setWriteDocs(event.target.checked)} /><span><b>构建 MVP 前写《架构说明手册》和《开发文档》</b><small>G2 后并行撰写，G3 确认后 Sol 才开始构建；开发文档会写进工作区的 DEV_GUIDE.md 和 AGENTS.md。</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={writePrd} onChange={event => setWritePrd(event.target.checked)} /><span><b>接受 MVP 后写《PRD》</b><small>依据 G4 接受的作业和执行日志撰写，在 G5 确认。</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={evaluatorEnabled} onChange={event => { const enabled = event.target.checked; setEvaluatorEnabled(enabled); if (!enabled) setBuild(current => ({ ...current, lightReworkEnabled: false })); }} /><span><b>Astra 独立评审每轮构建</b><small>在绑定提交的独立副本中复现验收项；不修改构建工作区。默认关闭。</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={finalReviewEnabled} onChange={event => setFinalReviewEnabled(event.target.checked)} /><span><b>Claude 只读终审</b><small>循环结束后审查代码与核验材料，不运行命令、不联网。默认关闭。</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={build.autoRework} onChange={event => setBuild(current => ({ ...current, autoRework: event.target.checked }))} /><span><b>仅按已核验实现缺陷自动返工</b><small>人工待验、证据不足、配额或环境故障不会自动开新轮。默认关闭。</small></span></label>
            <label className={`switch-row${lightReworkBlockReason !== null ? ' is-disabled' : ''}`}><input type="checkbox" checked={Boolean(build.lightReworkEnabled)} disabled={lightReworkBlockReason !== null} onChange={event => setBuild(current => ({ ...current, lightReworkEnabled: event.target.checked }))} /><span><b>允许 Grok 轻量返工</b><small>{lightReworkBlockReason ?? '仅限一次，当前 minor 实现缺陷最多涉及 5 个不同文件；Grok 只改允许文件，Windows Astra 在独立副本运行验收命令，程序按实际日志核验。'} 默认关闭。</small></span></label>
            <label className="switch-row"><input type="checkbox" checked={contextEnabled} onChange={event => { const enabled = event.target.checked; setContextEnabled(enabled); if (enabled) setBuild(current => ({ ...current, lightReworkEnabled: false })); }} /><span><b>启用构建上下文会话预算</b><small>默认关闭。无法确认旧线程状态时会显示 unknown，并新建线程，不把未知值当作 0。</small></span></label>
            <label className={`switch-row${grokAvailable ? '' : ' is-disabled'}`}><input type="checkbox" checked={digestEnabled} disabled={!grokAvailable} onChange={event => setDigestEnabled(event.target.checked)} /><span><b>Grok 构建摘要</b><small>{grokReason} 摘要必须带来源锚点，不能代替核验。</small></span></label>
            <label className={`switch-row${grokAvailable ? '' : ' is-disabled'}`}><input type="checkbox" checked={qgroupEnabled} disabled={!grokAvailable} onChange={event => setQgroupEnabled(event.target.checked)} /><span><b>Grok 问题分组提示</b><small>{grokReason} 只改变浏览提示，不合并、删除或代答问题。</small></span></label>
          </div>
          <div className="form-grid doc-writers">{(['handbook', 'devdoc', 'prd'] as const).map(kind => <div className="field" key={kind}><span>{kind === 'handbook' ? '架构说明手册' : kind === 'devdoc' ? '开发文档' : 'PRD'}撰写配置</span><div className="row"><select aria-label={`${kind} 撰写者`} value={docWriters[kind].role} onChange={event => setDocWriters(current => ({ ...current, [kind]: { ...current[kind], role: event.target.value as PrimaryRole } }))}>{roles.map(role => <option value={role} key={role}>{roleNames[role]}</option>)}</select><select aria-label={`${kind} 撰写强度`} value={docWriters[kind].effort} onChange={event => setDocWriters(current => ({ ...current, [kind]: { ...current[kind], effort: event.target.value as Effort } }))}>{effortOptions[docWriters[kind].role].map(value => <option key={value} value={value}>{effortNames[value]}</option>)}</select></div></div>)}</div>
          <details className={`new-adv${limitsOk ? '' : ' is-invalid'}`} ref={limitsRef} open={limitsOpen} onToggle={event => setLimitsOpen(event.currentTarget.open)}>
            <summary>构建与评审上限（高级）<small>· {build.maxRounds} 轮构建 · {build.maxWriterSessions} 个写者会话 · {build.maxModelCalls} 次模型调用 · {build.maxActiveMinutes} 分钟{limitsOk ? '' : ' · 需修正'}</small></summary>
            <div className="form-grid review-settings">
              <LimitField {...limitProps('maxRounds')} label="每作业最多构建轮数" min={1} max={4} value={build.maxRounds} onChange={value => setBuild(current => ({ ...current, maxRounds: value }))} />
              <LimitField {...limitProps('maxWriterSessions')} label="每作业写者会话上限" min={1} max={100} value={build.maxWriterSessions} onChange={value => setBuild(current => ({ ...current, maxWriterSessions: value }))} />
              <LimitField {...limitProps('maxModelCalls')} label="每作业模型调用上限" min={1} max={200} value={build.maxModelCalls} onChange={value => setBuild(current => ({ ...current, maxModelCalls: value }))} />
              <LimitField {...limitProps('maxActiveMinutes')} label="每作业模型主动时间上限（分钟）" min={1} max={1440} value={build.maxActiveMinutes} onChange={value => setBuild(current => ({ ...current, maxActiveMinutes: value }))} />
              {build.lightReworkEnabled ? <LimitField {...limitProps('lightRework')} label="Grok 轻量返工上限（分钟）" min={1} max={15} value={lightReworkMinutes} onChange={value => setBuild(current => ({ ...current, lightReworkMinutes: value }))}><small>Grok 固定使用 High；启动前由服务端再次核验并冻结 Grok 写者、Astra 评审和已启用的 Claude 终审预算。</small></LimitField> : null}
              {contextEnabled ? <Field label="会话续接策略"><select aria-label="会话续接策略" value={resumePolicy} onChange={event => setResumePolicy(event.target.value as BuildOptions['resumePolicy'])}><option value="never">每个里程碑新线程</option><option value="budgeted">预算允许时续接</option></select><small>线程上下文状态为 unknown 时始终新建线程。</small></Field> : null}
              {evaluatorEnabled ? <><Field label="Astra 评审强度"><select value={evaluatorEffort} onChange={event => setEvaluatorEffort(event.target.value as Effort)}>{effortOptions.astra.map(value => <option key={value} value={value}>{effortNames[value]}</option>)}</select></Field><LimitField {...limitProps('evaluatorTimeout')} label="Astra 评审超时（分钟）" min={1} max={120} value={evaluatorTimeout} onChange={setEvaluatorTimeout} /></> : null}
              {finalReviewEnabled ? <><Field label="Claude 终审强度"><select value={finalReviewEffort} onChange={event => setFinalReviewEffort(event.target.value as Effort)}>{effortOptions.claude.map(value => <option key={value} value={value}>{effortNames[value]}</option>)}</select></Field><LimitField {...limitProps('finalReviewTimeout')} label="Claude 终审超时（分钟）" min={1} max={120} value={finalReviewTimeout} onChange={setFinalReviewTimeout} /></> : null}
            </div>
            <p className="help-note">所有写者、评审、终审和结构修复共用上述作业上限；上下文估算与实际观测会分开显示。</p>
          </details>
        </FormSection>

        <FormSection id="new-s5" index="05" title="评分权重" description="权重在开始评审时锁定，防止看到结果后再调整。" action={<div className="weight-total">合计 <strong className={`mono ${weightsOk ? 'ok-text' : 'bad-text'}`}>{totalWeight.toFixed(3)}</strong><button type="button" className="btn sm" onClick={normalize} disabled={totalWeight <= 0}>按比例归一化</button></div>}>
          <div className="weight-list">{config?.criteria.map(item => <div className="weight-row" key={item.id}>
            <label htmlFor={`weight-${item.id}`}>{item.name}</label>
            <span className="weight-bar" aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, weights[item.id] ?? 0))})` }} /></span>
            <input id={`weight-${item.id}`} className="mono" type="number" min="0" max="1" step="0.01" value={weights[item.id] ?? 0} onChange={e => setWeights(old => ({ ...old, [item.id]: Number(e.target.value) }))} />
          </div>) ?? <p className="muted">{configError ? '评分项暂不可用：配置读取失败。' : '正在读取评分项…'}</p>}</div>
        </FormSection>
      </div>

      <LaunchCard checks={checks} acknowledged={acknowledged} onAck={setAcknowledged} ackRef={ackRef} error={error}
        canLaunch={ready && acknowledged && !submitting && !pendingRun} buttonLabel={submitting ? '正在创建…' : referencesBusy ? '正在读取参考资料…' : '启动评审…'}
        reason={submitting || pendingRun || !missing.length ? '' : `还差 ${missing.length} 项：${missing.join('、')}`}
        estimate={<CallEstimate designLabel={designMode === 'auto' ? `自动 · 当前按 ${designNames[resolvedDesign]}` : designNames[resolvedDesign]} contextEnabled={contextEnabled} base={callEstimate.base} total={callEstimate.total} efforts={efforts} docCalls={docCalls} evaluator={evaluatorEnabled ? evaluatorEffort : null} finalReview={finalReviewEnabled ? finalReviewEffort : null} build={build} />} />
    </div>
    {pendingRun ? <Modal title="确认启动真实评审" size="sm" initialFocus={backRef} onClose={() => setPendingRun(null)}
      footer={<><button ref={backRef} type="button" className="btn" onClick={() => setPendingRun(null)}>返回修改</button><button type="button" className="btn primary" disabled={submitting} onClick={confirm}>确认并启动</button></>}>
      <p>即将调用本机登录的 Claude Code 与 Codex CLI，开始“{pendingRun.title}”的澄清提问。之后每个阶段都会消耗订阅额度；如在 G2 选择复核，双方复核后仍有关键分歧时，还会最多追加一次 Astra Ultra 裁决。</p>
    </Modal> : null}
  </form>;
}
