import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { probeWslTestRunner } from '../src/chat/runner-wsl.js';

const workRoot = path.resolve(process.argv[2] ?? process.env.DMW_WORK_ROOT ?? 'work');
const proofFile = path.resolve(process.argv[3] ?? process.env.DMW_WSL_PROOF ?? path.join('data', 'capabilities', 'runner-wsl.json'));
mkdirSync(workRoot, { recursive: true });
mkdirSync(path.dirname(proofFile), { recursive: true });

const proof = await probeWslTestRunner({ workRootWindows: workRoot });
const temporary = `${proofFile}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
renameSync(temporary, proofFile);
process.stdout.write(`${JSON.stringify({ proofFile, verified: proof.verified, verifiedAt: proof.verifiedAt })}\n`);
