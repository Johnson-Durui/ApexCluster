// cross-spawn 的最小类型声明（不额外依赖 @types/cross-spawn）
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process';
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  export default spawn;
}
