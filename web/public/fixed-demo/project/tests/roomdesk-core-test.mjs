// RoomDesk 核心逻辑测试。只用 Node 自带的 node:test 和 node:assert，没有第三方依赖。
// 运行：npm test（等同于 node --test "tests/*-test.mjs"）。
// 文件名用 -test.mjs 结尾而不是 .test.mjs：Node 默认会识别这种命名，同时不会被上层仓库的其他测试工具误收。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOORS, ROOMS, RULES, STORAGE_KEY,
  addBooking, addDays, escapeText, eventLines, filterRooms, findConflicts, findFreeRooms, foldLine,
  formatTime, isStateDamaged, isValidDate, mergeSamples, nextWorkday, overlaps, parseState, parseTime, removeBooking, sampleBookings,
  serialiseState, suggestSlot, toICalendar, unfoldLines, utf8Length, validateBooking, validateSlot,
} from '../src/roomdesk-core.mjs';

const DAY = '2026-11-20';
const NOW = new Date('2026-11-20T01:30:00Z');

function booking(overrides = {}) {
  return { id: 'b1', roomId: 'r203', date: DAY, start: '09:30', end: '10:30', title: '产品评审', organiser: '林一', ...overrides };
}

function codes(result) {
  return result.errors.map(item => item.code);
}

describe('楼层筛选', () => {
  test('全部楼层返回 3 层共 8 间会议室', () => {
    assert.equal(FLOORS.length, 3);
    const rooms = filterRooms(ROOMS, { floorId: 'all' });
    assert.equal(rooms.length, 8);
    assert.deepEqual(new Set(rooms.map(item => item.floorId)), new Set(FLOORS.map(item => item.id)));
  });

  test('按楼层筛选只返回该楼层的会议室，并保持原顺序', () => {
    const rooms = filterRooms(ROOMS, { floorId: 'f3' });
    assert.deepEqual(rooms.map(item => item.id), ['r301', 'r302', 'r303']);
  });

  test('不存在的楼层返回空列表，最少人数条件同时生效', () => {
    assert.deepEqual(filterRooms(ROOMS, { floorId: 'f9' }), []);
    assert.deepEqual(filterRooms(ROOMS, { floorId: 'f2', minCapacity: 6 }).map(item => item.id), ['r202', 'r203']);
  });
});

describe('时段校验', () => {
  test('时刻解析只接受 HH:MM，并能与分钟数互转', () => {
    assert.equal(parseTime('09:30'), 570);
    assert.equal(formatTime(570), '09:30');
    for (const bad of ['9:30', '24:30', '12:60', 'abc', '', undefined]) assert.ok(Number.isNaN(parseTime(bad)), String(bad));
  });

  test('工作时间内、对齐 15 分钟的时段通过校验，08:00 开始与 21:00 结束的边界也允许', () => {
    assert.deepEqual(validateSlot({ date: DAY, start: '09:00', end: '10:30' }), { ok: true, errors: [] });
    assert.equal(validateSlot({ date: DAY, start: '08:00', end: '09:00' }).ok, true);
    assert.equal(validateSlot({ date: DAY, start: '20:00', end: '21:00' }).ok, true);
  });

  test('早于 08:00 或晚于 21:00 的时段被拒绝', () => {
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '07:45', end: '08:30' })), ['outside-hours']);
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '20:30', end: '21:15' })), ['outside-hours']);
  });

  test('不在 15 分钟刻度上的时间被拒绝', () => {
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '09:10', end: '10:00' })), ['off-grid']);
  });

  test('结束不晚于开始时被拒绝', () => {
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '10:00', end: '10:00' })), ['end-before-start']);
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '11:00', end: '10:00' })), ['end-before-start']);
  });

  test('时长上限 4 小时：恰好 4 小时通过，超过被拒绝', () => {
    assert.equal(RULES.maxDuration, 240);
    assert.equal(validateSlot({ date: DAY, start: '09:00', end: '13:00' }).ok, true);
    assert.deepEqual(codes(validateSlot({ date: DAY, start: '09:00', end: '13:15' })), ['too-long']);
  });

  test('不存在的日期和错误格式的日期被拒绝', () => {
    assert.equal(isValidDate('2026-02-30'), false);
    assert.equal(isValidDate('2028-02-29'), true);
    assert.deepEqual(codes(validateSlot({ date: '2026/11/20', start: '09:00', end: '10:00' })), ['invalid-date']);
  });

  test('完整预约还要求会议室存在、主题和预约人已填写、主题不超过 40 字', () => {
    const result = validateBooking(booking({ roomId: 'r999', title: '  ', organiser: '' }));
    assert.deepEqual(codes(result), ['unknown-room', 'missing-title', 'missing-organiser']);
    assert.deepEqual(codes(validateBooking(booking({ title: '会'.repeat(41) }))), ['title-too-long']);
    assert.equal(validateBooking(booking()).ok, true);
  });
});

describe('冲突检测', () => {
  test('半开区间：首尾相接不算重叠，有交集才算', () => {
    assert.equal(overlaps(540, 600, 600, 660), false);
    assert.equal(overlaps(540, 601, 600, 660), true);
    assert.equal(overlaps(600, 630, 540, 720), true);
  });

  test('同一会议室同一天时段重叠即冲突，相邻时段不冲突', () => {
    const existing = [booking()];
    assert.deepEqual(findConflicts(existing, booking({ id: 'b2', start: '10:00', end: '11:00' })).map(item => item.id), ['b1']);
    assert.deepEqual(findConflicts(existing, booking({ id: 'b2', start: '10:30', end: '11:00' })), []);
    assert.deepEqual(findConflicts(existing, booking({ id: 'b2', start: '09:00', end: '09:30' })), []);
  });

  test('不同会议室或不同日期互不冲突', () => {
    const existing = [booking()];
    assert.deepEqual(findConflicts(existing, booking({ id: 'b2', roomId: 'r202' })), []);
    assert.deepEqual(findConflicts(existing, booking({ id: 'b2', date: addDays(DAY, 1) })), []);
  });

  test('编辑自身时不与自己冲突', () => {
    assert.deepEqual(findConflicts([booking()], booking({ end: '11:00' })), []);
  });

  test('新增有冲突的预约被拒绝，返回冲突与建议，原数组不变', () => {
    const existing = Object.freeze([booking()]);
    const result = addBooking(existing, booking({ id: 'b2', start: '10:00', end: '11:00', title: '周会' }));
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ['conflict']);
    assert.deepEqual(result.conflicts.map(item => item.id), ['b1']);
    assert.deepEqual(result.suggestion, { roomId: 'r203', date: DAY, start: '10:30', end: '11:30' });
    assert.equal(result.bookings, existing);
  });

  test('新增合法预约返回按时间排序的新数组，删除同样不改原数组', () => {
    const existing = [booking()];
    const result = addBooking(existing, { roomId: 'r203', date: DAY, start: '08:00', end: '09:00', title: ' 晨会 ', organiser: '周舟' }, { id: 'b0', now: NOW.toISOString() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.bookings.map(item => item.id), ['b0', 'b1']);
    assert.equal(result.booking.title, '晨会');
    assert.equal(existing.length, 1);
    assert.deepEqual(removeBooking(result.bookings, 'b0').map(item => item.id), ['b1']);
    assert.equal(result.bookings.length, 2);
  });
});

describe('空闲时段建议', () => {
  test('建议离原开始时间最近、时长相同的空闲时段', () => {
    const existing = [booking({ start: '10:00', end: '11:00' }), booking({ id: 'b2', start: '11:00', end: '12:00' })];
    assert.deepEqual(suggestSlot(existing, booking({ id: 'new', start: '10:30', end: '11:30' })), { roomId: 'r203', date: DAY, start: '12:00', end: '13:00' });
    // 页面对“今天”传入当前时刻：不建议已经过去的时段
    assert.deepEqual(suggestSlot(existing, booking({ id: 'new', start: '10:30', end: '11:30' }), RULES, { notBefore: 13 * 60 + 10 }), { roomId: 'r203', date: DAY, start: '13:15', end: '14:15' });
  });

  test('前后距离相同时优先顺延', () => {
    const existing = [booking({ start: '10:00', end: '11:00' })];
    assert.deepEqual(suggestSlot(existing, booking({ id: 'new', start: '10:00', end: '11:00' })), { roomId: 'r203', date: DAY, start: '11:00', end: '12:00' });
  });

  test('超出工作时间的请求被挪回 08:00–21:00 之内；全天占满时返回 null', () => {
    assert.deepEqual(suggestSlot([], booking({ id: 'new', start: '20:30', end: '21:30' })), { roomId: 'r203', date: DAY, start: '20:00', end: '21:00' });
    const fullDay = [];
    for (let start = RULES.dayStart; start < RULES.dayEnd; start += 60) {
      fullDay.push(booking({ id: `full-${start}`, start: formatTime(start), end: formatTime(start + 60) }));
    }
    assert.equal(suggestSlot(fullDay, booking({ id: 'new', start: '10:00', end: '10:30' })), null);
  });

  test('同一时段可以换到同楼层其他空闲会议室', () => {
    const existing = [booking(), booking({ id: 'b2', roomId: 'r202' })];
    const free = findFreeRooms(ROOMS, existing, { date: DAY, start: '09:30', end: '10:30' }, { floorId: 'f2', excludeRoomId: 'r203' });
    assert.deepEqual(free.map(item => item.id), ['r201']);
  });
});

describe('示例数据与本地存储', () => {
  test('示例数据全部带示例标记、字段合法且互不冲突', () => {
    const samples = sampleBookings(DAY);
    assert.ok(samples.length >= 8);
    for (const item of samples) {
      assert.equal(item.sample, true);
      assert.equal(validateBooking(item).ok, true, item.id);
      assert.deepEqual(findConflicts(samples, item), [], item.id);
    }
    // 第二天的示例落在下一个工作日：DAY 是周五，所以是下周一
    assert.deepEqual(new Set(samples.map(item => item.date)), new Set([DAY, '2026-11-23']));
    assert.equal(nextWorkday('2026-11-23'), addDays('2026-11-23', 1));
  });

  test('合并时隐藏已删除的示例，与用户预约冲突的示例让位', () => {
    const samples = sampleBookings(DAY);
    const mine = booking({ id: 'u1', roomId: 'r203', start: '10:00', end: '11:00', title: '我的会', mine: true });
    const merged = mergeSamples(samples, [mine], [`sample-${DAY}-1`]);
    const ids = merged.map(item => item.id);
    assert.ok(ids.includes('u1'));
    assert.ok(!ids.includes(`sample-${DAY}-1`), '已删除的示例不应出现');
    assert.ok(!ids.includes(`sample-${DAY}-2`), '与用户预约冲突的示例不应出现');
    assert.equal(merged.length, samples.length - 1);
  });

  test('存储格式可往返，坏数据回退为空，不合法和互相冲突的记录被丢弃', () => {
    assert.equal(STORAGE_KEY, 'roomdesk:v1:state');
    const user = booking({ id: 'u1', mine: true });
    const text = serialiseState({ bookings: [user, ...sampleBookings(DAY)], hiddenSamples: ['sample-x', 'sample-x'] });
    assert.deepEqual(JSON.parse(text).bookings.map(item => item.id), ['u1']);
    assert.deepEqual(parseState(text), { bookings: [{ ...user }], hiddenSamples: ['sample-x'] });
    assert.deepEqual(parseState('{not json'), { bookings: [], hiddenSamples: [] });
    assert.equal(isStateDamaged(text), false);
    assert.equal(isStateDamaged(null), false);
    assert.equal(isStateDamaged('{not json'), true);
    assert.deepEqual(parseState(JSON.stringify({ version: 2, bookings: [user] })), { bookings: [], hiddenSamples: [] });
    const dirty = JSON.stringify({ version: 1, bookings: [user, booking({ id: 'u2', start: '10:00', end: '11:00' }), { id: 'u3', roomId: 'r203' }, null] });
    assert.deepEqual(parseState(dirty).bookings.map(item => item.id), ['u1']);
    assert.equal(isStateDamaged(dirty), true);
  });
});

describe('iCal 导出', () => {
  test('TEXT 转义：反斜杠、分号、逗号、换行', () => {
    assert.equal(escapeText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
    assert.equal(escapeText('第一行\r\n第二行\r第三行'), '第一行\\n第二行\\n第三行');
    assert.equal(escapeText('已转义\\,不能再吞'), '已转义\\\\\\,不能再吞');
  });

  test('折行：每行不超过 75 字节，续行以空格开头，不拆开多字节字符，展开后与原文一致', () => {
    const line = `SUMMARY:${escapeText('跨部门季度规划评审📅, 包含预算; 人力与里程碑\\复盘'.repeat(3))}`;
    const folded = foldLine(line);
    const physical = folded.split('\r\n');
    assert.ok(physical.length > 1);
    physical.forEach((part, index) => {
      assert.ok(utf8Length(part) <= 75, `第 ${index + 1} 行 ${utf8Length(part)} 字节`);
      if (index > 0) assert.equal(part[0], ' ');
      assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part);
      assert.ok(!part.includes('�'));
    });
    assert.equal(unfoldLines(folded), line);
    assert.equal(foldLine('SHORT:ok'), 'SHORT:ok');
  });

  test('日历结构完整，行尾一律 CRLF，没有单独的 LF', () => {
    const text = toICalendar([booking(), booking({ id: 'b2', roomId: 'r501', start: '13:30', end: '14:30' })], { now: NOW });
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false);
    assert.equal(text.replace(/\r\n/g, '').includes('\r'), false);
    assert.equal(text.match(/^BEGIN:VEVENT\r$/gm)?.length, 2);
    assert.equal(text.match(/^END:VEVENT\r$/gm)?.length, 2);
    for (const line of text.split('\r\n')) assert.ok(utf8Length(line) <= 75);
  });

  test('VEVENT 含 UID、UTC 的 DTSTAMP，以及带 TZID=Asia/Shanghai 的起止时间和 VTIMEZONE', () => {
    const text = unfoldLines(toICalendar([booking()], { now: NOW }));
    assert.match(text, /\r\nUID:roomdesk-b1\r\n/);
    assert.match(text, /\r\nDTSTAMP:20261120T013000Z\r\n/);
    assert.match(text, /\r\nDTSTART;TZID=Asia\/Shanghai:20261120T093000\r\n/);
    assert.match(text, /\r\nDTEND;TZID=Asia\/Shanghai:20261120T103000\r\n/);
    assert.match(text, /\r\nBEGIN:VTIMEZONE\r\nTZID:Asia\/Shanghai\r\n/);
    assert.match(text, /\r\nLOCATION:2 层 银杏\r\n/);
    assert.match(text, /\r\nDESCRIPTION:预约人：林一\\n容纳 10 人；设备：投影\\, 视频会议\\, 白板\r\n/);
  });

  test('UTC 形式：08:00（UTC+8）导出为 000000Z，且不带 VTIMEZONE', () => {
    const text = toICalendar([booking({ start: '08:00', end: '09:15' })], { now: NOW, utc: true });
    assert.match(text, /\r\nDTSTART:20261120T000000Z\r\n/);
    assert.match(text, /\r\nDTEND:20261120T011500Z\r\n/);
    assert.equal(text.includes('VTIMEZONE'), false);
    assert.equal(text.includes('TZID='), false);
  });

  test('导出的 SUMMARY 已转义特殊字符，长中文主题按字节折行', () => {
    const title = '评审：接口, 存储; 发布\\回滚\n备注';
    const lines = eventLines(booking({ title }), { now: NOW });
    assert.ok(lines.includes('SUMMARY:评审：接口\\, 存储\\; 发布\\\\回滚\\n备注'));
    const long = booking({ title: '跨部门季度规划与预算评审会议议程确认以及下一阶段里程碑和人员安排讨论' });
    const text = toICalendar([long], { now: NOW });
    const summary = text.split('\r\n').findIndex(line => line.startsWith('SUMMARY:'));
    assert.ok(text.split('\r\n')[summary + 1].startsWith(' '), 'SUMMARY 应被折到下一行');
    assert.match(unfoldLines(text), new RegExp(`\\r\\nSUMMARY:${long.title}\\r\\n`));
  });
});
