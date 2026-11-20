import type { CommandRunner } from '../chat/runner-contract.js';
import { DockerBackend } from './docker.js';
import { LocalUnsafeExecBackend } from './local-unsafe.js';
import { RunnerExecBackend } from './runner-backend.js';
import type { ExecSettings } from './settings.js';
import type { ExecBackend } from './types.js';

/** Select the configured backend. An unavailable backend stays unavailable. */
export function createExecBackend(settings: ExecSettings, runner?: CommandRunner): ExecBackend {
  if (settings.backend === 'local-unsafe') return new LocalUnsafeExecBackend();
  if (settings.backend !== 'docker') return new RunnerExecBackend(settings.backend, runner);
  if (settings.docker) {
    const { cacheVolume, ...docker } = settings.docker;
    return new DockerBackend({ ...docker, packageCacheVolume: cacheVolume, installNetwork: settings.installNetwork });
  }
  const reason = '请在 exec.docker.image 配置沙箱镜像的固定摘要';
  return {
    id: 'docker',
    async probe() { return { ok: false, reason }; },
    async run() { throw new Error(reason); },
  };
}
