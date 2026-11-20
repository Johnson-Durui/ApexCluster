// RoomDesk 核心逻辑。
// 纯 ES 模块：不访问 DOM，不读写存储，不读取系统时钟（需要“现在”的函数都通过参数接收），
// 浏览器页面 app.js 和 Node 测试 tests/roomdesk-core-test.mjs 使用的是同一份代码。
// 时间统一用“当天 0 点起的分钟数”计算，日期统一用 'YYYY-MM-DD' 字符串，时刻用 'HH:MM' 字符串。

/** 预约规则。改动这里会同时影响页面、校验和测试。 */
export const RULES = Object.freeze({
  dayStart: 8 * 60, // 08:00，最早开始
  dayEnd: 21 * 60, // 21:00，最晚结束
  step: 15, // 时间网格：15 分钟
  maxDuration: 4 * 60, // 单次预约最长 4 小时
  titleMax: 40, // 会议主题最多 40 个字符（按 Unicode 码点计）
});

/** 导出 iCal 时使用的时区。Asia/Shanghai 自 1991 年起不实行夏令时，固定为 UTC+08:00。 */
export const TIME_ZONE = 'Asia/Shanghai';
const UTC_OFFSET_MINUTES = 8 * 60;

/** localStorage 键名。带版本号，数据结构变化时换新键，旧数据不会被误读。 */
export const STORAGE_KEY = 'roomdesk:v1:state';
export const PREFS_KEY = 'roomdesk:v1:prefs';

export const FLOORS = Object.freeze([
  Object.freeze({ id: 'f2', name: '2 层', zone: '产品与设计' }),
  Object.freeze({ id: 'f3', name: '3 层', zone: '研发' }),
  Object.freeze({ id: 'f5', name: '5 层', zone: '综合' }),
]);

export const ROOMS = Object.freeze([
  room('r201', 'f2', '青杉', 4, ['电视']),
  room('r202', 'f2', '白桦', 6, ['电视', '白板']),
  room('r203', 'f2', '银杏', 10, ['投影', '视频会议', '白板']),
  room('r301', 'f3', '云杉', 4, ['白板']),
  room('r302', 'f3', '枫林', 8, ['电视', '视频会议']),
  room('r303', 'f3', '松涛', 12, ['投影', '视频会议', '白板']),
  room('r501', 'f5', '远山', 6, ['电视', '白板']),
  room('r502', 'f5', '星河', 20, ['投影', '视频会议', '扩声']),
]);

function room(id, floorId, name, capacity, equipment) {
  return Object.freeze({ id, floorId, name, capacity, equipment: Object.freeze([...equipment]) });
}

// ---------------------------------------------------------------- 时间与日期

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 'HH:MM' → 分钟数。格式不对或超过 24:00 时返回 NaN。 */
export function parseTime(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(text ?? ''));
  if (!match) return NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return NaN;
  const total = hours * 60 + minutes;
  return total <= 24 * 60 ? total : NaN;
}

/** 分钟数 → 'HH:MM'。 */
export function formatTime(minutes) {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function dateParts(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 是否为真实存在的公历日期，例如 2026-02-30 返回 false。 */
export function isValidDate(text) {
  const parts = dateParts(text);
  if (!parts) return false;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day;
}

/** 日期加减天数，只做日历运算，不受运行环境时区影响。 */
export function addDays(dateText, days) {
  const parts = dateParts(dateText);
  if (!parts) throw new TypeError(`无效日期：${dateText}`);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 下一个工作日（跳过周六、周日），只做日历运算。 */
export function nextWorkday(dateText) {
  let next = addDays(dateText, 1);
  for (;;) {
    const parts = dateParts(next);
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return next;
    next = addDays(next, 1);
  }
}

/** 用 Date 对象的本地日期生成 'YYYY-MM-DD'。页面用它得到“今天”。 */
export function localDateText(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 时长的中文描述，例如 90 → '1 小时 30 分'。 */
export function describeDuration(minutes) {
  if (!(minutes > 0)) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} 小时 ${rest} 分`;
  return hours ? `${hours} 小时` : `${rest} 分钟`;
}

// ---------------------------------------------------------------- 楼层与会议室

/**
 * 按楼层和最少人数筛选会议室，保持原有顺序。
 * floorId 为 'all' 或空值时不按楼层过滤；不存在的楼层返回空数组。
 */
export function filterRooms(rooms, { floorId = 'all', minCapacity = 0 } = {}) {
  return rooms.filter(item => (!floorId || floorId === 'all' || item.floorId === floorId) && item.capacity >= minCapacity);
}

export function findRoom(rooms, roomId) {
  return rooms.find(item => item.id === roomId) ?? null;
}

export function findFloor(floors, floorId) {
  return floors.find(item => item.id === floorId) ?? null;
}

// ---------------------------------------------------------------- 校验

function issue(code, message) {
  return { code, message };
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 校验时段本身（不看其他预约）：
 * 日期真实存在；时刻为 HH:MM；对齐 15 分钟网格；开始早于结束；时长不超过 4 小时；
 * 整个时段落在 08:00–21:00 之内。返回全部问题，而不是遇到第一个就停。
 */
export function validateSlot(slot, rules = RULES) {
  const errors = [];
  if (!isValidDate(slot?.date)) errors.push(issue('invalid-date', '日期格式应为 YYYY-MM-DD，并且必须是真实存在的日期。'));
  const start = parseTime(slot?.start);
  const end = parseTime(slot?.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    errors.push(issue('invalid-time', '开始和结束时间应为 HH:MM 格式。'));
    return { ok: false, errors };
  }
  if (start % rules.step !== 0 || end % rules.step !== 0) errors.push(issue('off-grid', `时间需要对齐 ${rules.step} 分钟刻度。`));
  if (start >= end) errors.push(issue('end-before-start', '结束时间必须晚于开始时间。'));
  else if (end - start > rules.maxDuration) errors.push(issue('too-long', `单次预约不能超过 ${rules.maxDuration / 60} 小时。`));
  if (start < rules.dayStart || end > rules.dayEnd) {
    errors.push(issue('outside-hours', `预约时间须在 ${formatTime(rules.dayStart)}–${formatTime(rules.dayEnd)} 之间。`));
  }
  return { ok: errors.length === 0, errors };
}

/** 校验一条完整预约：会议室存在、时段合法、主题和预约人已填写。 */
export function validateBooking(booking, rooms = ROOMS, rules = RULES) {
  const errors = [];
  if (!findRoom(rooms, booking?.roomId)) errors.push(issue('unknown-room', '请选择有效的会议室。'));
  errors.push(...validateSlot(booking, rules).errors);
  const title = cleanText(booking?.title);
  if (!title) errors.push(issue('missing-title', '请填写会议主题。'));
  else if ([...title].length > rules.titleMax) errors.push(issue('title-too-long', `会议主题不超过 ${rules.titleMax} 个字。`));
  if (!cleanText(booking?.organiser)) errors.push(issue('missing-organiser', '请填写预约人。'));
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- 冲突检测

/** 半开区间 [aStart, aEnd) 与 [bStart, bEnd) 是否重叠。首尾相接（10:00 结束、10:00 开始）不算重叠。 */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function compareBookings(a, b) {
  return a.date.localeCompare(b.date) || parseTime(a.start) - parseTime(b.start) || a.roomId.localeCompare(b.roomId) || String(a.id).localeCompare(String(b.id));
}

/**
 * 找出与候选预约冲突的已有预约：同一会议室、同一天、时段重叠。
 * 与候选预约 id 相同的记录（编辑自身时）不算冲突。结果按开始时间排序。
 */
export function findConflicts(bookings, candidate) {
  const start = parseTime(candidate?.start);
  const end = parseTime(candidate?.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return [];
  return bookings
    .filter(item => item.id !== candidate.id && item.roomId === candidate.roomId && item.date === candidate.date)
    .filter(item => overlaps(start, end, parseTime(item.start), parseTime(item.end)))
    .sort(compareBookings);
}

/**
 * 在同一会议室、同一天里找离原开始时间最近的空闲时段，时长保持不变（向上取整到 15 分钟）。
 * 距离相同时优先顺延（选更晚的那个）。原时段本身空闲且在工作时间内时，返回原时段。
 * notBefore（分钟数，可选）：只考虑不早于它的开始时间，页面对“今天”传入当前时刻，避免建议已经过去的时段。
 * 时段无法解析、时长不大于 0 或超过 4 小时时返回 null；当天没有空位时也返回 null。
 */
export function suggestSlot(bookings, candidate, rules = RULES, { notBefore } = {}) {
  const start = parseTime(candidate?.start);
  const end = parseTime(candidate?.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return null;
  const duration = Math.ceil((end - start) / rules.step) * rules.step;
  if (duration > rules.maxDuration) return null;
  let best = null;
  const first = Number.isFinite(notBefore) ? Math.max(rules.dayStart, Math.ceil(notBefore / rules.step) * rules.step) : rules.dayStart;
  for (let probe = first; probe + duration <= rules.dayEnd; probe += rules.step) {
    const slot = { ...candidate, start: formatTime(probe), end: formatTime(probe + duration) };
    if (findConflicts(bookings, slot).length) continue;
    const distance = Math.abs(probe - start);
    if (!best || distance <= best.distance) best = { distance, probe };
    else break; // 距离开始变大，后面只会更远
  }
  if (!best) return null;
  return { roomId: candidate.roomId, date: candidate.date, start: formatTime(best.probe), end: formatTime(best.probe + duration) };
}

/** 同一时段内空闲的其他会议室，可按楼层和人数筛选。用于“换个会议室”建议。 */
export function findFreeRooms(rooms, bookings, slot, { floorId = 'all', minCapacity = 0, excludeRoomId } = {}) {
  return filterRooms(rooms, { floorId, minCapacity })
    .filter(item => item.id !== excludeRoomId)
    .filter(item => findConflicts(bookings, { ...slot, roomId: item.id }).length === 0);
}

// ---------------------------------------------------------------- 预约增删

/** 生成预约 id。优先用 crypto.randomUUID（需要安全上下文），不可用时退回时间戳加随机数。 */
export function createId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 整理用户输入：去掉多余空白，只保留已知字段。 */
export function normaliseBooking(input, id) {
  const booking = {
    id: String(input?.id ?? id ?? createId()),
    roomId: String(input?.roomId ?? ''),
    date: String(input?.date ?? ''),
    start: String(input?.start ?? ''),
    end: String(input?.end ?? ''),
    title: cleanText(input?.title),
    organiser: cleanText(input?.organiser),
  };
  if (input?.mine) booking.mine = true;
  if (input?.sample) booking.sample = true;
  if (input?.createdAt) booking.createdAt = String(input.createdAt);
  return booking;
}

/**
 * 新增预约。不修改传入数组：成功时返回新的、已排序的数组。
 * 先做字段校验，再做冲突检测；有冲突时返回冲突列表和建议时段，原数组原样返回。
 */
export function addBooking(bookings, input, { rooms = ROOMS, rules = RULES, id, now } = {}) {
  const booking = normaliseBooking({ ...input, ...(now ? { createdAt: now } : {}) }, id);
  const validation = validateBooking(booking, rooms, rules);
  if (!validation.ok) return { ok: false, errors: validation.errors, conflicts: [], suggestion: null, bookings };
  const conflicts = findConflicts(bookings, booking);
  if (conflicts.length) {
    const suggestion = suggestSlot(bookings, booking, rules);
    return { ok: false, errors: [issue('conflict', '该会议室在这个时段已被预约。')], conflicts, suggestion, bookings };
  }
  return { ok: true, booking, errors: [], conflicts: [], suggestion: null, bookings: [...bookings, booking].sort(compareBookings) };
}

/** 删除预约，返回新数组。 */
export function removeBooking(bookings, id) {
  return bookings.filter(item => item.id !== id);
}

/** 某一天的预约，可只看指定会议室，按开始时间排序。 */
export function bookingsOn(bookings, date, roomIds) {
  const allowed = roomIds ? new Set(roomIds) : null;
  return bookings.filter(item => item.date === date && (!allowed || allowed.has(item.roomId))).sort(compareBookings);
}

// ---------------------------------------------------------------- 示例数据

// [0 = 今天、1 = 下一个工作日, 会议室, 开始, 结束, 主题, 预约人, 是否为“我的预约”]
const SAMPLE_PLAN = Object.freeze([
  [0, 'r301', '09:00', '09:45', '周会', '周舟', false],
  [0, 'r203', '09:30', '10:30', '产品评审', '林一', true],
  [0, 'r202', '10:00', '10:30', '每日站会', '周舟', false],
  [0, 'r302', '11:00', '12:00', '接口联调', '许言', false],
  [0, 'r501', '13:30', '14:30', '设计走查', '宋禾', false],
  [0, 'r303', '14:00', '15:30', '迭代规划', '陈默', false],
  [0, 'r502', '15:00', '17:00', '季度分享会', '唐果', false],
  [0, 'r201', '16:00', '16:30', '一对一沟通', '林一', true],
  [1, 'r303', '09:30', '10:00', '每日站会', '陈默', false],
  [1, 'r203', '10:00', '11:30', '需求澄清', '林一', true],
  [1, 'r302', '14:00', '15:00', '新人培训', '宋禾', false],
]);

/** 以 today 为基准生成示例预约（今天和下一个工作日）。id 由日期和序号决定，同一天多次生成结果相同。 */
export function sampleBookings(today) {
  const later = nextWorkday(today);
  return SAMPLE_PLAN.map(([offset, roomId, start, end, title, organiser, mine], index) => {
    const date = offset === 0 ? today : later;
    const booking = { id: `sample-${date}-${index + 1}`, roomId, date, start, end, title, organiser, sample: true };
    if (mine) booking.mine = true;
    return booking;
  });
}

/**
 * 合并示例数据和用户自己的预约：
 * 用户删除过的示例（hiddenIds）不再出现；与用户预约冲突的示例让位给用户预约。
 */
export function mergeSamples(samples, userBookings, hiddenIds = []) {
  const hidden = new Set(hiddenIds);
  const kept = samples.filter(item => !hidden.has(item.id) && findConflicts(userBookings, item).length === 0);
  return [...kept, ...userBookings].sort(compareBookings);
}

// ---------------------------------------------------------------- 本地存储格式

/** 序列化需要持久化的部分：只存用户自己的预约和被隐藏的示例 id，示例数据每次按日期重新生成。 */
export function serialiseState({ bookings, hiddenSamples = [] }) {
  const userBookings = bookings.filter(item => !item.sample).map(item => normaliseBooking(item));
  return JSON.stringify({ version: 1, bookings: userBookings, hiddenSamples: [...new Set(hiddenSamples)] });
}

/**
 * 解析 localStorage 里的文本。任何异常（空值、坏 JSON、版本不符）都返回空状态；
 * 逐条校验预约，丢弃不合法的记录，以及与前面已保留记录冲突的记录。
 */
/**
 * 本地存储里的文本是否有内容没能读出：坏 JSON、版本不符、格式不对，或有预约记录被丢弃。
 * 空值不算（首次打开）。页面据此提示用户，满足“数据损坏时照常可用并提示”。
 */
export function isStateDamaged(text, parsed = parseState(text)) {
  if (typeof text !== 'string' || !text) return false;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return true;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.bookings)) return true;
  return parsed.bookings.length < data.bookings.length;
}

export function parseState(text, rooms = ROOMS, rules = RULES) {
  const empty = { bookings: [], hiddenSamples: [] };
  if (typeof text !== 'string' || !text) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.bookings)) return empty;
  const kept = [];
  for (const raw of data.bookings) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    const booking = normaliseBooking({ ...raw, sample: false });
    if (!validateBooking(booking, rooms, rules).ok) continue;
    if (findConflicts(kept, booking).length) continue;
    kept.push(booking);
  }
  const hiddenSamples = Array.isArray(data.hiddenSamples) ? data.hiddenSamples.filter(item => typeof item === 'string') : [];
  return { bookings: kept.sort(compareBookings), hiddenSamples };
}

// ---------------------------------------------------------------- iCal（RFC 5545）导出

/**
 * TEXT 值转义（RFC 5545 §3.3.11）：反斜杠 → \\，分号 → \;，逗号 → \,，换行 → \n。
 * 反斜杠必须最先处理，否则后面加上的反斜杠会被再转义一次。
 * 其余控制字符（制表符除外）在 TEXT 中不允许出现，直接删除。
 */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

/** 一个字符串的 UTF-8 字节数。 */
export function utf8Length(text) {
  let bytes = 0;
  for (const char of String(text)) bytes += utf8Width(char.codePointAt(0));
  return bytes;
}

function utf8Width(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * 内容行折行（RFC 5545 §3.1）：每个物理行不超过 75 个字节（不含 CRLF），
 * 续行以一个空格开头，空格也计入 75 字节。按完整字符切分，不会把一个多字节字符拆到两行。
 */
export function foldLine(line, limit = 75) {
  const parts = [];
  let current = '';
  let used = 0;
  let room = limit;
  for (const char of String(line)) {
    const width = utf8Width(char.codePointAt(0));
    if (used + width > room) {
      parts.push(current);
      current = '';
      used = 0;
      room = limit - 1;
    }
    current += char;
    used += width;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** 折行的逆操作：去掉 CRLF 后紧跟的一个空格或制表符。 */
export function unfoldLines(text) {
  return String(text).replace(/\r\n[ \t]/g, '');
}

/** 本地日期和时刻 → iCal 本地时间格式，例如 20261120T093000。 */
export function toICalLocal(dateText, timeText) {
  return `${dateText.replace(/-/g, '')}T${timeText.replace(':', '')}00`;
}

/** Date → UTC 格式，例如 20261120T013000Z。用于 DTSTAMP。 */
export function toICalUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Asia/Shanghai 的日期和时刻 → UTC 格式（减去 8 小时，必要时跨到前一天）。 */
export function shanghaiToUtc(dateText, timeText) {
  const parts = dateParts(dateText);
  const minutes = parseTime(timeText);
  if (!parts || Number.isNaN(minutes)) throw new TypeError(`无效时间：${dateText} ${timeText}`);
  const ms = Date.UTC(parts.year, parts.month - 1, parts.day) + (minutes - UTC_OFFSET_MINUTES) * 60_000;
  return toICalUtc(new Date(ms));
}

const VTIMEZONE_LINES = Object.freeze([
  'BEGIN:VTIMEZONE',
  `TZID:${TIME_ZONE}`,
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
]);

/** 一条预约 → VEVENT 的内容行（尚未折行）。 */
export function eventLines(booking, { rooms = ROOMS, floors = FLOORS, now = new Date(), utc = false } = {}) {
  const place = findRoom(rooms, booking.roomId);
  const floor = place ? findFloor(floors, place.floorId) : null;
  const location = place ? `${floor ? `${floor.name} ` : ''}${place.name}` : booking.roomId;
  const details = [`预约人：${booking.organiser}`];
  if (place) details.push(`容纳 ${place.capacity} 人；设备：${place.equipment.join(', ')}`);
  const start = utc ? `DTSTART:${shanghaiToUtc(booking.date, booking.start)}` : `DTSTART;TZID=${TIME_ZONE}:${toICalLocal(booking.date, booking.start)}`;
  const end = utc ? `DTEND:${shanghaiToUtc(booking.date, booking.end)}` : `DTEND;TZID=${TIME_ZONE}:${toICalLocal(booking.date, booking.end)}`;
  return [
    'BEGIN:VEVENT',
    `UID:roomdesk-${booking.id}`,
    `DTSTAMP:${toICalUtc(now)}`,
    start,
    end,
    `SUMMARY:${escapeText(booking.title)}`,
    `LOCATION:${escapeText(location)}`,
    `DESCRIPTION:${escapeText(details.join('\n'))}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ];
}

/**
 * 生成完整的 iCalendar 文本：VCALENDAR 包含一个或多个 VEVENT。
 * 默认用 TZID=Asia/Shanghai 并附带 VTIMEZONE；utc: true 时改用 UTC（…Z）形式且不带 VTIMEZONE。
 * 每个内容行先折行，行尾一律 CRLF，最后一行之后也有 CRLF。
 */
export function toICalendar(bookings, { rooms = ROOMS, floors = FLOORS, now = new Date(), utc = false, calendarName = 'RoomDesk 会议室预约' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RoomDesk//RoomDesk 1.0//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  if (!utc) {
    lines.push(`X-WR-TIMEZONE:${TIME_ZONE}`);
    lines.push(...VTIMEZONE_LINES);
  }
  for (const booking of [...bookings].sort(compareBookings)) lines.push(...eventLines(booking, { rooms, floors, now, utc }));
  lines.push('END:VCALENDAR');
  return lines.map(line => foldLine(line)).join('\r\n') + '\r\n';
}

/** 下载文件名，只用 ASCII，避免不同系统对中文文件名的处理差异。 */
export function icsFileName(booking) {
  if (!booking) return 'roomdesk.ics';
  if (typeof booking === 'string') return `roomdesk-${booking}.ics`;
  return `roomdesk-${booking.date}-${booking.start.replace(':', '')}-${booking.roomId}.ics`;
}
