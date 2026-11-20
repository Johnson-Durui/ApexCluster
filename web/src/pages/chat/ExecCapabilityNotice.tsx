import type { ExecCapability } from '../../lib/chat-api';
import './exec-capability.css';

export default function ExecCapabilityNotice({ capability, warningsOnly = false }: { capability?: ExecCapability; warningsOnly?: boolean }) {
  if (!capability?.backend || (warningsOnly && !capability.unsafe)) return null;
  if (capability.unsafe) {
    return <div className="exec-capability is-unsafe" role="alert">
      <strong>本机无沙箱执行</strong>
      <span>模型命令可以访问宿主文件和网络。</span>
    </div>;
  }
  return <div className="exec-capability" role="status">
    <strong>{capability.backend === 'docker' ? 'Docker 执行沙箱' : capability.backend}</strong>
    <span>{capability.available ? '已就绪' : capability.reason ?? '不可用'}</span>
  </div>;
}
