// 协作 popover (BUILD-SPEC-B §4.7): which seats can take work, from the real driver capabilities. Seat names come from
// the observatory role labels (no borrowed fallback name). Rows are [data-seat] for focus-one-seat.
import Popover from '../../../components/Popover';
import { seatHandlers } from '../../../components/seatFocus';
import { Icon } from '../../../components/ui';
import type { DriverCapability } from '../../../lib/chat-api';
import type { Observatory } from '../observatoryModel';
import { seatLabel, seatStyle } from '../thread/seats';

export function CollabPopover({ capabilities, model, demo }: { capabilities: DriverCapability[]; model: Observatory; demo: boolean }) {
  const available = capabilities.filter(item => item.available).length;
  const name = (role: string) => model.roles.find(item => item.id === role)?.label ?? seatLabel(role);
  return <Popover label="协作 Agent" placement="up" align="end" buttonClassName="c-pill"
    button={demo ? <><b>预设协作</b><Icon name="chevron-down" size={12} /></> : <><b>自动协作</b><span className="mono"> · {available} 席位</span><Icon name="chevron-down" size={12} /></>}
    panelClassName="collab-pop">
    <h2>协作 Agent</h2>
    {demo ? <p>本会话播放固定的角色脚本，不发起真实模型调用，不生成调用次数或上下文用量。</p> : <>
      <p>根据任务需要分工，使用当前配置。</p>
      {capabilities.length ? <ul className="collab-rows">{capabilities.map(item => {
        const { onClick: _pin, ...hover } = seatHandlers(item.role);
        return <li key={item.role} className="collab-row" style={seatStyle(item.role)} {...hover}>
          <span className="seat-dot" aria-hidden="true" /><b>{name(item.role)}</b>
          <span className={item.available ? 'ok-text' : 'muted'}>{item.available ? '已连接' : item.reason ?? '当前不可用'}</span>
        </li>;
      })}</ul> : <p>暂未取得模型状态，可在环境与连接中检查。</p>}
    </>}
  </Popover>;
}
