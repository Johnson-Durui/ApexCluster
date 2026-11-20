// This process belongs to one invocation. Credentials never appear in MCP output.
import readline from 'node:readline';

const { CHAT_BRIDGE_URL, CHAT_BRIDGE_TOKEN, CHAT_BRIDGE_CHAT, CHAT_BRIDGE_INVOCATION, CHAT_BRIDGE_TOOLS } = process.env;
let tools;
try {
  const url = new URL(CHAT_BRIDGE_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw Error('invalid bridge');
  if (!CHAT_BRIDGE_TOKEN || !CHAT_BRIDGE_CHAT || !CHAT_BRIDGE_INVOCATION) throw Error('missing identity');
  tools = JSON.parse(CHAT_BRIDGE_TOOLS);
  if (!Array.isArray(tools) || tools.some(t => !t || typeof t.name !== 'string' || !t.inputSchema)) throw Error('invalid tools');
} catch { process.exit(1); }
const allowed = new Set(tools.map(t => t.name));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const statuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
const stepId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function safePlanText(tool, value) {
  if (!exactKeys(value, ['planError']) || !exactKeys(value.planError, ['code', 'details'])) return null;
  const { code, details } = value.planError;
  if (tool === 'plan_update' && code === 'PLAN_QUERY_VERIFICATION_FORBIDDEN'
    && exactKeys(details, ['stepId','invalidTool','storedStatus','requestedStatus','verificationLocked']) && stepId(details.stepId)
    && ['plan_read','plan_update','task_state','task_evidence','result_read','execution_read','execution_submit_review','user_source_list','user_source_read','file_list','session_file_list','grok_collect','grok_disposition','agent_submit','grok_submit','artifact_publish','task_yield','task_complete','task_fail','ask_user'].includes(details.invalidTool)
    && ['new', ...statuses].includes(details.storedStatus) && statuses.has(details.requestedStatus) && typeof details.verificationLocked === 'boolean') {
    const recovery = details.verificationLocked ? '该步骤已started，verification仍锁定，不能改写或补设' : `拒绝未落盘；步骤仍为${details.storedStatus === 'new' ? '未创建' : 'pending'}，请保持pending并修正verification后用同一revision重试`;
    return `PLAN_QUERY_VERIFICATION_FORBIDDEN stepId=${details.stepId} invalidTool=${details.invalidTool} storedStatus=${details.storedStatus} requestedStatus=${details.requestedStatus} verificationLocked=${details.verificationLocked}：协调/取证查询本身不能作为工作验收；${recovery}。`;
  }
  if (tool === 'plan_update' && code === 'PLAN_DEPENDENCY_INCOMPLETE' && exactKeys(details, ['stepId','requestedStatus','incompleteDependencies'])
    && stepId(details.stepId) && statuses.has(details.requestedStatus) && Array.isArray(details.incompleteDependencies) && details.incompleteDependencies.length > 0 && details.incompleteDependencies.length <= 32
    && details.incompleteDependencies.every(item => exactKeys(item, ['stepId','status']) && stepId(item.stepId) && statuses.has(item.status) && item.status !== 'completed')) {
    return `PLAN_DEPENDENCY_INCOMPLETE stepId=${details.stepId} requestedStatus=${details.requestedStatus} incompleteDependencies=${details.incompleteDependencies.map(item => `${item.stepId}(${item.status})`).join('、')}：先完成依赖步骤；或将当前步骤保持pending后用同一revision修正。`;
  }
  if (tool === 'task_complete' && code === 'PLAN_INCOMPLETE' && exactKeys(details, ['steps']) && Array.isArray(details.steps) && details.steps.length > 0 && details.steps.length <= 32
    && details.steps.every(item => exactKeys(item, ['stepId','status']) && stepId(item.stepId) && statuses.has(item.status))) {
    return `PLAN_INCOMPLETE steps=${details.steps.map(item => `${item.stepId}(${item.status})`).join('、')}：当前任务计划尚未闭合；继续完成真实工作。只有当前任务目标确实无法完成时，才先保存可用报告或证据再调用task_fail；独立评审得出不通过结论仍可正常提交真实评审报告。`;
  }
  return null;
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  void (async () => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params } = message;
    if (id === undefined) return;
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'workbench', version: '1' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method !== 'tools/call' || !allowed.has(params?.name)) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method or tool' } });
    try {
      const endpoint = new URL(`/internal/chat-tools/${encodeURIComponent(CHAT_BRIDGE_CHAT)}/${encodeURIComponent(CHAT_BRIDGE_INVOCATION)}`, CHAT_BRIDGE_URL);
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CHAT_BRIDGE_TOKEN}` }, body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        let rejected; try { rejected = await response.json(); } catch { throw Error('tool rejected'); }
        const text = safePlanText(params.name, rejected);
        if (!text) throw Error('tool rejected');
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text.slice(0, 4000) }], isError: true } });
      }
      const result = await response.json();
      if (typeof result?.text !== 'string') throw Error('invalid tool response');
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text.slice(0, 4000) }], isError: false } });
    } catch { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '工具调用失败或已失效' }], isError: true } }); }
  })();
});
