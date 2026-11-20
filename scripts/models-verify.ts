import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadModelRegistry } from '../src/providers/registry.js';
import { modelsMissingKeys, saveModelVerification, verifyModelListings } from '../src/providers/verification.js';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    offline: { type: 'boolean', default: false },
    provider: { type: 'string', multiple: true },
    'data-root': { type: 'string' },
  } });
  const root = process.cwd();
  const models = [...loadModelRegistry(path.join(root, 'config')).values()];
  if (values.provider?.some(provider => !models.some(model => model.provider === provider))) throw new Error('所选厂商不在模型注册表中');
  const selected = values.provider?.length ? models.filter(model => values.provider?.includes(model.provider)) : models;
  if (values.offline) {
    console.log(`离线校验通过，共 ${selected.length} 个模型。`);
    return 0;
  }

  const dotenv = path.join(root, '.env');
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  const missing = modelsMissingKeys(selected);
  if (missing.length) {
    for (const model of missing) console.error(`${model.id}：缺少环境变量 ${model.apiKeyEnv}`);
    return 1;
  }
  const configFile = path.join(root, 'config', 'chat.config.json');
  const local = !values['data-root'] && existsSync(configFile)
    ? z.object({ dataRoot: z.string().min(1).optional() }).parse(JSON.parse(readFileSync(configFile, 'utf8')))
    : {};
  const dataRoot = path.resolve(root, values['data-root'] ?? local.dataRoot ?? 'data/chat');
  const { modelProviderFor } = await import('../src/providers/factory.js');
  const proof = await verifyModelListings(selected, modelProviderFor, AbortSignal.timeout(120_000));
  for (const model of proof.models) {
    console.log(`${model.id}：${model.status === 'verified' ? '已核对' : model.reason}`);
  }
  console.log(`核对结果已保存到 ${saveModelVerification(dataRoot, proof)}`);
  return proof.models.every(model => model.status === 'verified') ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '型号核对失败');
  process.exitCode = 1;
}
