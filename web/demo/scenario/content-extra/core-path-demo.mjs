// RoomDesk 核心路径原型（架构阶段 Demo，只用于验证路径，不进入交付代码）。
// 验证：3 层 8 间会议室、半开区间冲突、最近空闲时段建议、iCal 转义 / 75 字节折行 / CRLF。
// 运行：node .agent/demo/core-path-demo.mjs
const ROOMS = [
  { id: 'r201', floor: '2 层', name: '青杉' }, { id: 'r202', floor: '2 层', name: '白桦' }, { id: 'r203', floor: '2 层', name: '银杏' },
  { id: 'r301', floor: '3 层', name: '云杉' }, { id: 'r302', floor: '3 层', name: '枫林' }, { id: 'r303', floor: '3 层', name: '松涛' },
  { id: 'r501', floor: '5 层', name: '远山' }, { id: 'r502', floor: '5 层', name: '星河' },
];
const DATE = '2026-12-01';
const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const overlaps = (a, b) => a.roomId === b.roomId && a.date === b.date && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);

/** 同一会议室、时长不变、离原开始时间最近的空闲时段；距离相同时优先顺延。 */
function suggest(bookings, wanted) {
  const length = minutes(wanted.end) - minutes(wanted.start);
  const origin = minutes(wanted.start);
  const starts = [];
  for (let start = 8 * 60; start + length <= 21 * 60; start += 15) starts.push(start);
  starts.sort((a, b) => Math.abs(a - origin) - Math.abs(b - origin) || b - a);
  for (const start of starts) {
    const slot = { ...wanted, start: clock(start), end: clock(start + length) };
    if (!bookings.some(item => overlaps(item, slot))) return slot;
  }
  return null;
}

const escapeText = text => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** 每个物理行不超过 75 字节（续行开头的空格也计入），不拆开多字节字符。 */
function fold(line) {
  const parts = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char);
    const limit = parts.length ? 74 : 75;
    if (size + bytes > limit) { parts.push(current); current = ''; size = 0; }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.map((part, index) => (index ? ` ${part}` : part)).join('\r\n');
}

const stamp = (date, time) => `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;

function toICal(bookings, dtstamp) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//RoomDesk//Core Path Demo//ZH', 'CALSCALE:GREGORIAN'];
  for (const item of bookings) {
    const room = ROOMS.find(entry => entry.id === item.roomId);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}.roomdesk`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;TZID=Asia/Shanghai:${stamp(item.date, item.start)}`,
      `DTEND;TZID=Asia/Shanghai:${stamp(item.date, item.end)}`,
      `SUMMARY:${escapeText(item.title)}`,
      `LOCATION:${escapeText(`${room.floor} · ${room.name}`)}`,
      `DESCRIPTION:${escapeText(`预约人：${item.owner}`)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

const bookings = [];
function book(input) {
  const room = ROOMS.find(item => item.id === input.roomId);
  const label = `${room.name} ${input.start}–${input.end} ${input.title}`;
  const clash = bookings.find(item => overlaps(item, input));
  if (clash) {
    console.log(`预约 ${input.n}：${label} → 冲突（与「${clash.title}」${clash.start}–${clash.end} 重叠）`);
    const slot = suggest(bookings, input);
    console.log(`建议时段：${room.name} ${slot.start}–${slot.end}`);
    return;
  }
  bookings.push(input);
  console.log(`预约 ${input.n}：${label} → 已保存`);
}

const floors = new Set(ROOMS.map(room => room.floor));
console.log(`会议室：${floors.size} 层 ${ROOMS.length} 间`);
book({ n: 1, id: 'demo-1', roomId: 'r203', date: DATE, start: '09:30', end: '10:30', title: '产品评审', owner: '林一' });
book({ n: 2, id: 'demo-2', roomId: 'r302', date: DATE, start: '13:00', end: '14:00', title: '接口联调：预约服务与日历导出的端到端验证（中文长标题折行检查）', owner: '周宁' });
book({ n: 3, id: 'demo-3', roomId: 'r203', date: DATE, start: '10:00', end: '11:00', title: '周会', owner: '许言' });

const ics = toICal(bookings, '20261201T010000Z');
const physical = ics.split('\r\n').filter(Boolean);
const longest = Math.max(...physical.map(line => Buffer.byteLength(line)));
const bareLf = /[^\r]\n/.test(ics);
const unfolded = ics.replace(/\r\n /g, '');
console.log(`iCal：1 个 VCALENDAR，${bookings.length} 个 VEVENT，行尾${bareLf ? '存在单独 LF' : '全部 CRLF'}，最长物理行 ${longest} 字节`);
console.log(`折行展开后与原文一致：${unfolded.includes(`SUMMARY:${escapeText(bookings[1].title)}`) ? '是' : '否'}`);
