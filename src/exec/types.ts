/** Commands use argv directly. The task's relative cwd never selects a host mount. */
export interface ExecSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  purpose?: 'install' | 'build' | 'test' | 'run';
}

/** The workspace and output directory are resolved and authorized by the host. */
export interface ExecContext {
  copyDir: string;
  outputDir: string;
  signal: AbortSignal;
}

/** Backend references point to host-owned files inside outputDir. */
export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  exitConfirmed: boolean;
  durationMs: number;
  stdoutRef: string;
  stderrRef: string;
  network: 'none' | 'full';
  outputLimited?: true;
}

export type ExecBackendId = 'docker' | 'wsl-bwrap' | 'windows-mxc' | 'local-unsafe';

export interface ExecWorkspace {
  copyDir: string;
  sourceSnapshotId: string;
  sourceFingerprint: string;
  testSnapshotId?: string;
  workCopyId?: string;
}

/** Durable ownership and input identity for an API command or background job. */
export interface TaskExecJob extends Omit<ExecWorkspace, 'copyDir'> {
  id: string;
  taskId: string;
  invocationId: string;
  backend: ExecBackendId;
  purpose?: ExecSpec['purpose'];
  sourceRevision?: number;
  command?: Pick<ExecSpec, 'argv' | 'cwd' | 'timeoutMs'>;
  uiAcceptanceId?: string;
  state: 'starting' | 'running' | 'finished' | 'exit_unknown';
  receiptRef?: string;
}

export interface ExecBackend {
  readonly id: ExecBackendId;
  probe(): Promise<{ ok: boolean; reason?: string }>;
  run(spec: ExecSpec, context: ExecContext): Promise<ExecResult>;
}
