import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv } from 'ajv';
import { z } from 'zod/v4';
import { OUTPUT_SCHEMAS } from '../src/core/schemas.js';
import { lintStrictSchema, toStrictJsonSchema } from '../src/core/strict-json-schema.js';

test('所有模型输出 schema 都能生成严格 JSON Schema，并且是合法 draft-07', () => {
  const ajv = new Ajv({ allErrors: true });
  for (const [phase, zs] of Object.entries(OUTPUT_SCHEMAS)) {
    const js = toStrictJsonSchema(zs);
    assert.deepEqual(lintStrictSchema(js), [], phase);
    assert.equal(js.$schema, undefined);
    const validate = ajv.compile(js as object);
    assert.equal(typeof validate, 'function', phase);
    const size = JSON.stringify(js).length;
    // 命令行参数长度预算：Windows CreateProcess 上限 32767 字符
    assert.ok(size < 24_000, `${phase} schema 太大：${size}`);
  }
});

test('使用 optional 会被体检拦截（严格模式要求全部 required）', () => {
  const bad = z.object({ a: z.string().optional() });
  assert.throws(() => toStrictJsonSchema(bad), /required/);
});

test('使用 min/max 等关键字会被体检拦截', () => {
  const bad = z.object({ a: z.array(z.string()).min(1) });
  assert.throws(() => toStrictJsonSchema(bad), /minItems/);
});
