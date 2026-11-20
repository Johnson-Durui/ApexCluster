/** 显式对最终便携JS模块运行无模型隔离探针；不会改写包内文件或manifest。 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WslRunnerProof } from '../src/chat/runner-wsl.js';

const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot)) throw new Error('请提供候选包绝对目录');
const moduleFile = path.join(packageRoot, 'app/src/chat/runner-wsl.js');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'chat-source-manifest.json'), 'utf8')) as { application: { path: string; sha256: string }[] };
const actual = createHash('sha256').update(readFileSync(moduleFile)).digest('hex');
if (manifest.application.find(file => file.path.replaceAll('\\', '/') === 'src/chat/runner-wsl.js')?.sha256 !== actual) throw new Error('便携runner与构建清单不符');
const { probeWslTestRunner, loadWslTestRunner } = await import(pathToFileURL(moduleFile).href) as typeof import('../src/chat/runner-wsl.js');
const dataRoot = path.resolve(process.env.DMW_DATA_ROOT ?? 'data');
const proofFile = path.join(dataRoot, 'capabilities/runner-wsl.json');
const options = { workRootWindows: path.join(dataRoot, 'work') };
const proof: WslRunnerProof = await probeWslTestRunner(options);
mkdirSync(path.dirname(proofFile), { recursive: true });
if (existsSync(proofFile)) copyFileSync(proofFile, `${proofFile}.before-portable-${Date.now()}.json`);
const temporary = `${proofFile}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(proof, null, 2), { flag: 'wx' }); renameSync(temporary, proofFile);
const loaded = loadWslTestRunner(proofFile, options);
if (!loaded.availability.available) throw new Error(`便携proof复核失败：${loaded.availability.reason}`);
process.stdout.write(`${JSON.stringify({ proofFile, moduleFile, moduleSha256: actual, verified: loaded.proof?.verified, realModelCalls: 0 })}\n`);
