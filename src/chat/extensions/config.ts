import { z } from 'zod/v4';

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const timeout = z.number().int().min(1_000).max(60_000).default(30_000);
const toolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const secretEnv = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const noEmbeddedSecret = (value: string) => !/(?:api[-_]?key|token|secret|password|bearer|cookie)\s*[=:]/i.test(value) && !/:\/\/[^/@\s]+:[^/@\s]+@/.test(value);

const skill = z.object({ id, root: z.string().min(1).max(2_000), enabled: z.boolean().default(true) }).strict();
const mcpBase = {
  id, enabled: z.boolean().default(true), toolAllowlist: z.array(toolName).min(1).max(100),
  toolAccess: z.record(toolName, z.enum(['read', 'write'])), allowWrites: z.boolean().default(false),
  writeToolAllowlist: z.array(toolName).max(40).default([]), timeoutMs: timeout,
  maxOutputBytes: z.number().int().min(1_024).max(1024 * 1024).default(256 * 1024),
  searchTool: toolName.optional(),
};
const stdioMcp = z.object({ ...mcpBase, transport: z.literal('stdio'), dockerCli: z.string().min(1).max(2_000), dockerCliSha256: z.string().regex(/^[a-f0-9]{64}$/), image: z.string().regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/i), serverArgs: z.array(z.string().max(2_000).refine(noEmbeddedSecret, '容器参数不能内嵌凭据')).max(32).default([]) }).strict();
const httpMcp = z.object({ ...mcpBase, transport: z.literal('http'), url: z.string().url().max(2_000), apiKeyEnv: secretEnv.optional(), apiKeyHeader: z.enum(['Authorization', 'x-api-key']).optional() }).strict();
const mcp = z.discriminatedUnion('transport', [stdioMcp, httpMcp]).superRefine((value, ctx) => {
  const allowed = new Set(value.toolAllowlist), access = Object.keys(value.toolAccess), writes = new Set(value.writeToolAllowlist);
  if (allowed.size !== value.toolAllowlist.length) ctx.addIssue({ code: 'custom', message: 'toolAllowlist包含重复工具' });
  if (access.some(name => !allowed.has(name)) || value.toolAllowlist.some(name => !(name in value.toolAccess))) ctx.addIssue({ code: 'custom', message: 'toolAccess必须精确分类所有允许工具' });
  if ([...writes].some(name => value.toolAccess[name] !== 'write') || value.toolAllowlist.some(name => value.toolAccess[name] === 'write' && !writes.has(name))) ctx.addIssue({ code: 'custom', message: '写工具必须同时出现在toolAccess和writeToolAllowlist' });
  if (value.searchTool && (value.toolAccess[value.searchTool] !== 'read' || !allowed.has(value.searchTool))) ctx.addIssue({ code: 'custom', message: 'searchTool必须是已允许的只读工具' });
});
const media = z.object({ enabled: z.boolean().default(true), allowPaidCalls: z.boolean().default(false), endpoint: z.string().url().max(2_000), editEndpoint: z.string().url().max(2_000).optional(), model: z.string().min(1).max(200), apiKeyEnv: secretEnv, timeoutMs: timeout, maxOutputBytes: z.number().int().min(1_024).max(32 * 1024 * 1024).default(32 * 1024 * 1024) }).strict();
const codexMedia = z.object({ enabled:z.boolean().default(false), allowSubscriptionCalls:z.boolean().default(false), timeoutMs:z.number().int().min(1_000).max(900_000).default(180_000) }).strict();
export const extensionConfigSchema = z.object({
  version: z.literal(1), skills: z.array(skill).max(20).default([]), mcp: z.array(mcp).max(20).default([]),
  media: z.object({ vision: media.optional(), image: media.optional(), codex:codexMedia.optional() }).strict().default({}),
  documentWorker: z.object({ enabled: z.boolean().default(true), url: z.string().url().default('http://127.0.0.1:18781') }).strict().default({ enabled: true, url: 'http://127.0.0.1:18781' }),
}).strict().superRefine((value, ctx) => {
  for (const [kind, values] of [['Skill', value.skills], ['MCP', value.mcp]] as const) if (new Set(values.map(item => item.id)).size !== values.length) ctx.addIssue({ code: 'custom', message: `${kind} ID重复` });
  try { const url = new URL(value.documentWorker.url); if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(); } catch { ctx.addIssue({ code: 'custom', message: 'documentWorker只允许本机HTTP地址' }); }
});
export type ExtensionConfig = z.infer<typeof extensionConfigSchema>;
export type McpConfig = ExtensionConfig['mcp'][number];
export const emptyExtensionConfig = (): ExtensionConfig => extensionConfigSchema.parse({ version: 1 });
