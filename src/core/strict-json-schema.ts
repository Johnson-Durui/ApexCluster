/**
 * 把 zod schema 转成两家 CLI 都能接受的“严格” JSON Schema（draft-07）。
 *
 * - Claude Code：--json-schema 需要合法 JSON Schema（draft-07 校验器）。
 * - Codex：--output-schema 走 OpenAI 严格结构化输出：每个对象 additionalProperties=false，
 *   所有属性必须出现在 required 中（可空用 anyOf null 表达），根节点必须是 object。
 *
 * 这里做两件事：生成 + 体检（lint）。体检失败直接抛错，防止有人在模型输出 schema 里
 * 写了 .optional()、.min() 等严格模式不支持的东西。
 */
import { z } from 'zod/v4';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonSchema = { [k: string]: Json };

/** 严格模式下不允许出现的关键字（部分实现不支持，统一禁用，约束放到语义校验里） */
const FORBIDDEN_KEYWORDS = [
  'default',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'const',
];

function walk(node: Json, path: string, visit: (n: { [k: string]: Json }, p: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
    return;
  }
  if (node && typeof node === 'object') {
    visit(node, path);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, visit);
  }
}

export function lintStrictSchema(schema: JsonSchema): string[] {
  const problems: string[] = [];
  if (schema.type !== 'object') problems.push('根节点必须是 type=object');
  walk(schema, '$', (n, p) => {
    // 跳过 properties 容器本身（它的键是字段名，不是关键字）
    if (p.endsWith('.properties')) return;
    for (const k of FORBIDDEN_KEYWORDS) {
      if (k in n) problems.push(`${p}: 不允许使用关键字 ${k}`);
    }
    if (n.type === 'object' || (n.properties && typeof n.properties === 'object')) {
      const props = (n.properties ?? {}) as Record<string, Json>;
      const keys = Object.keys(props);
      if (n.additionalProperties !== false) problems.push(`${p}: 对象必须 additionalProperties=false`);
      const req = Array.isArray(n.required) ? (n.required as string[]) : [];
      for (const key of keys) if (!req.includes(key)) problems.push(`${p}: 属性 ${key} 必须列入 required（可空请用 nullable）`);
    }
  });
  return problems;
}

/** 生成严格 JSON Schema；不合规直接抛错。 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' } as Parameters<typeof z.toJSONSchema>[1]) as JsonSchema;
  const out: JsonSchema = { ...raw };
  delete out.$schema;
  const problems = lintStrictSchema(out);
  if (problems.length) throw new Error(`schema 不满足严格模式：\n${problems.join('\n')}`);
  return out;
}

/** 紧凑字符串（用于命令行参数 / 文件） */
export function schemaToCompactString(schema: JsonSchema): string {
  return JSON.stringify(schema);
}
