// RoomDesk 页面逻辑：负责 DOM、事件和 localStorage。
// 所有规则判断（校验、冲突、建议、iCal）都调用 roomdesk-core.mjs，本文件不重复实现规则。
import {
  FLOORS, ROOMS, RULES, STORAGE_KEY, PREFS_KEY,
  addBooking, addDays, bookingsOn, describeDuration, filterRooms, findConflicts, findFloor, findFreeRooms,
  findRoom, formatTime, icsFileName, isStateDamaged, isValidDate, localDateText, mergeSamples, parseState, parseTime,
  nextWorkday, removeBooking, sampleBookings, serialiseState, suggestSlot, toICalendar, validateSlot,
} from './roomdesk-core.mjs';

const $ = id => document.getElementById(id);
const SPAN = RULES.dayEnd - RULES.dayStart;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DEFAULT_ROOM = 'r203';
const DEFAULT_ORGANISER = '林一';
const today = localDateText(new Date());

const ui = {
  summary: $('summary'), tabs: $('floor-tabs'), timeline: $('timeline'), viewDate: $('view-date'),
  prevDay: $('prev-day'), nextDay: $('next-day'), goToday: $('go-today'), exportDay: $('export-day'),
  form: $('booking-form'), room: $('f-room'), date: $('f-date'), start: $('f-start'), end: $('f-end'),
  title: $('f-title'), organiser: $('f-organiser'), check: $('check'), submit: $('submit'), duration: $('duration'),
  mineList: $('mine-list'), mineCount: $('mine-count'), reset: $('reset'), storageNote: $('storage-note'),
  detail: $('detail'), detailTitle: $('detail-title'), detailList: $('detail-list'), detailIcs: $('detail-ics'), detailRemove: $('detail-remove'),
  toast: $('toast'),
};

// ---------------------------------------------------------------- 本地存储（任何异常都不影响页面运行）

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 存储不可用时无需处理：内存中的状态已经重置。
  }
}

function readPrefs() {
  try {
    const value = JSON.parse(readStorage(PREFS_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const storedText = readStorage(STORAGE_KEY);
const saved = parseState(storedText);
const storageDamaged = isStateDamaged(storedText, saved);
const prefs = readPrefs();

const state = {
  bookings: mergeSamples(sampleBookings(today), saved.bookings, saved.hiddenSamples),
  hiddenSamples: saved.hiddenSamples,
  floorId: FLOORS.some(floor => floor.id === prefs.floorId) ? prefs.floorId : 'all',
  viewDate: today,
  detailId: null,
  storageOk: true,
};

function persistPrefs() {
  writeStorage(PREFS_KEY, JSON.stringify({ floorId: state.floorId, organiser: ui.organiser.value.trim() || DEFAULT_ORGANISER }));
}

function persist() {
  const ok = writeStorage(STORAGE_KEY, serialiseState({ bookings: state.bookings, hiddenSamples: state.hiddenSamples }));
  persistPrefs();
  if (!ok && state.storageOk) {
    state.storageOk = false;
    ui.storageNote.textContent = '当前浏览器不允许本地存储，刷新页面后新建的预约会丢失。';
  }
}

if (storageDamaged) ui.storageNote.textContent = '本地保存的预约有部分无法读取（数据损坏或版本不符），已忽略这部分，其余功能照常。';

/** 当前时刻的分钟数（浏览器本地时间）。 */
function minutesNow() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** 给 suggestSlot 的选项：日期是今天时，只建议当前时刻之后的时段。 */
function notBeforeFor(date) {
  return date === today ? { notBefore: minutesNow() } : {};
}

// ---------------------------------------------------------------- 小工具

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'style') for (const [name, rule] of Object.entries(value)) node.style.setProperty(name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`), rule);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function formatDay(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${month} 月 ${day} 日 ${WEEKDAYS[weekday]}`;
}

// 短会议放不下文字：不足 45 分钟只显示色块，不足 90 分钟只显示主题，完整信息在悬停提示和详情里。
function blockSize(minutes) {
  if (minutes < 45) return ' is-tiny';
  return minutes < 90 ? ' is-narrow' : '';
}

function formatShortDay(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return `${month}/${day} ${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`;
}

function percent(minutes) {
  return `${((minutes - RULES.dayStart) / SPAN) * 100}%`;
}

function roomLabel(room) {
  const floor = findFloor(FLOORS, room.floorId);
  return `${floor ? `${floor.name} ` : ''}${room.name}`;
}

let toastTimer = 0;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, 2800);
}

/** 用 Blob 生成文件并触发下载，不经过任何服务器。 */
function download(text, fileName) {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBooking(booking) {
  download(toICalendar([booking], { calendarName: `RoomDesk · ${booking.title}` }), icsFileName(booking));
  toast(`已生成 ${icsFileName(booking)}`);
}

/** 两步确认按钮：第一次点击只“上膛”，3 秒内再点一次才执行。 */
function armOrRun(button, armedText, run) {
  if (button.dataset.armed === '1') {
    run();
    return;
  }
  const original = button.textContent;
  button.dataset.armed = '1';
  button.classList.add('is-armed');
  button.textContent = armedText;
  window.setTimeout(() => {
    if (!button.isConnected) return;
    button.dataset.armed = '';
    button.classList.remove('is-armed');
    button.textContent = original;
  }, 3000);
}

// ---------------------------------------------------------------- 表单

function fillFormOptions() {
  for (const floor of FLOORS) {
    const group = el('optgroup', { label: `${floor.name} · ${floor.zone}` });
    for (const room of filterRooms(ROOMS, { floorId: floor.id })) group.append(new Option(`${room.name} · ${room.capacity} 人`, room.id));
    ui.room.append(group);
  }
  for (let minutes = RULES.dayStart; minutes < RULES.dayEnd; minutes += RULES.step) ui.start.append(new Option(formatTime(minutes), formatTime(minutes)));
  for (let minutes = RULES.dayStart + RULES.step; minutes <= RULES.dayEnd; minutes += RULES.step) ui.end.append(new Option(formatTime(minutes), formatTime(minutes)));
  // 默认时段：今天当前时刻之后最近的 15 分钟刻度、默认会议室里第一个空闲的 1 小时；今天已排不下时用下一个工作日。
  let date = today;
  let start = Math.max(RULES.dayStart, Math.ceil(minutesNow() / RULES.step) * RULES.step);
  if (start + 60 > RULES.dayEnd) {
    date = nextWorkday(today);
    start = 9 * 60;
  }
  const draft = { roomId: DEFAULT_ROOM, date, start: formatTime(start), end: formatTime(start + 60) };
  const free = suggestSlot(state.bookings, draft, RULES, notBeforeFor(date)) ?? draft;
  state.viewDate = date;
  ui.room.value = DEFAULT_ROOM;
  ui.date.value = date;
  ui.start.value = free.start;
  ui.end.value = free.end;
  ui.organiser.value = typeof prefs.organiser === 'string' && prefs.organiser.trim() ? prefs.organiser.trim().slice(0, 20) : DEFAULT_ORGANISER;
}

function readForm() {
  return { roomId: ui.room.value, date: ui.date.value, start: ui.start.value, end: ui.end.value, title: ui.title.value, organiser: ui.organiser.value };
}

function setSlot(start, end) {
  ui.start.value = start;
  ui.end.value = end;
  refresh();
}

function renderCheck() {
  const draft = readForm();
  const room = findRoom(ROOMS, draft.roomId);
  const slot = validateSlot(draft);
  const startMinutes = parseTime(draft.start);
  const endMinutes = parseTime(draft.end);
  ui.duration.textContent = endMinutes > startMinutes ? `时长 ${describeDuration(endMinutes - startMinutes)}` : '';
  ui.check.className = 'check';
  ui.check.replaceChildren();
  let canSubmit = false;

  if (!room || !slot.ok) {
    ui.check.classList.add('is-error');
    const messages = [...(room ? [] : ['请选择有效的会议室。']), ...slot.errors.map(item => item.message)];
    ui.check.append(el('p', {}, '这个时段不能预约：'), el('ul', {}, messages.map(message => el('li', {}, message))));
  } else {
    const conflicts = findConflicts(state.bookings, draft);
    if (conflicts.length) {
      ui.check.classList.add('is-conflict');
      const first = conflicts[0];
      const more = conflicts.length > 1 ? `等 ${conflicts.length} 场预约` : '';
      ui.check.append(el('p', {}, el('strong', {}, '时段冲突'), `：${room.name}已有「${first.title}」${first.start}–${first.end}（${first.organiser}）${more}。`));
      const suggestion = suggestSlot(state.bookings, draft, RULES, notBeforeFor(draft.date));
      const freeRooms = findFreeRooms(ROOMS, state.bookings, draft, { floorId: room.floorId, excludeRoomId: room.id }).slice(0, 3);
      if (suggestion) {
        ui.check.append(el('p', { className: 'suggest' }, '最近的空闲时段：',
          el('button', { type: 'button', className: 'chip', onclick: () => setSlot(suggestion.start, suggestion.end) }, `改为 ${suggestion.start}–${suggestion.end}`)));
      } else {
        ui.check.append(el('p', {}, `${room.name}当天已没有这么长的空闲时段。`));
      }
      if (freeRooms.length) {
        ui.check.append(el('p', { className: 'suggest' }, '同楼层同时段空闲：',
          freeRooms.map(item => el('button', { type: 'button', className: 'chip', onclick: () => { ui.room.value = item.id; refresh(); } }, `换到 ${item.name}（${item.capacity} 人）`))));
      }
    } else {
      ui.check.classList.add('is-ok');
      const missing = [!ui.title.value.trim() && '会议主题', !ui.organiser.value.trim() && '预约人'].filter(Boolean);
      canSubmit = missing.length === 0;
      ui.check.append(el('p', {}, missing.length
        ? `该时段空闲，填写${missing.join('和')}后即可预约。`
        : `该时段空闲，${room.name}可容纳 ${room.capacity} 人，可以预约。`));
    }
  }
  ui.submit.disabled = !canSubmit;
}

function submitForm(event) {
  event.preventDefault();
  const result = addBooking(state.bookings, { ...readForm(), mine: true }, { now: new Date().toISOString() });
  if (!result.ok) {
    renderCheck();
    toast(result.errors[0]?.message ?? '无法预约。');
    return;
  }
  state.bookings = result.bookings;
  state.viewDate = result.booking.date;
  persist();
  ui.title.value = '';
  // 刚预约的时段已被占用：把表单移到同一会议室最近的空闲时段，方便继续预约，也避免立刻显示冲突。
  const next = suggestSlot(state.bookings, { ...result.booking, id: undefined }, RULES, notBeforeFor(result.booking.date));
  if (next) {
    ui.start.value = next.start;
    ui.end.value = next.end;
  }
  const room = findRoom(ROOMS, result.booking.roomId);
  toast(`已预约 ${room ? room.name : ''} ${result.booking.start}–${result.booking.end}「${result.booking.title}」`);
  render();
}

// ---------------------------------------------------------------- 楼层页签与日程板

function renderTabs() {
  const tabs = [{ id: 'all', name: '全部楼层', count: ROOMS.length }, ...FLOORS.map(floor => ({ id: floor.id, name: floor.name, count: filterRooms(ROOMS, { floorId: floor.id }).length }))];
  ui.tabs.replaceChildren(...tabs.map(tab => el('button', {
    type: 'button', role: 'tab', className: 'floor-tab', 'aria-selected': String(state.floorId === tab.id),
    onclick: () => selectFloor(tab.id),
  }, tab.name, el('small', {}, `${tab.count} 间`))));
}

function selectFloor(floorId) {
  state.floorId = floorId;
  const current = findRoom(ROOMS, ui.room.value);
  if (floorId !== 'all' && current?.floorId !== floorId) ui.room.value = filterRooms(ROOMS, { floorId })[0]?.id ?? DEFAULT_ROOM;
  // 只保存页签偏好：切换楼层不重写预约数据（本地数据损坏时，未读出的部分不会因此被覆盖）。
  persistPrefs();
  render();
}

function renderTimeline() {
  const rooms = filterRooms(ROOMS, { floorId: state.floorId });
  const draft = readForm();
  const draftStart = parseTime(draft.start);
  const draftEnd = parseTime(draft.end);
  const draftVisible = draft.date === state.viewDate && draftEnd > draftStart && draftStart >= RULES.dayStart && draftEnd <= RULES.dayEnd;
  const draftConflict = draftVisible && findConflicts(state.bookings, draft).length > 0;

  const hours = [];
  for (let minutes = RULES.dayStart; minutes <= RULES.dayEnd; minutes += 60) hours.push(el('span', { className: 'tl-hour', style: { left: percent(minutes) } }, formatTime(minutes)));
  const children = [el('div', { className: 'tl-hours', 'aria-hidden': 'true' }, el('div'), el('div', { className: 'tl-hours-track' }, hours))];

  for (const floor of FLOORS) {
    const floorRooms = rooms.filter(room => room.floorId === floor.id);
    if (!floorRooms.length) continue;
    children.push(el('div', { className: 'tl-floor' }, el('span', { className: 'tl-floor-label' }, el('strong', {}, floor.name), floor.zone)));
    for (const room of floorRooms) {
      const blocks = bookingsOn(state.bookings, state.viewDate, [room.id]).map(booking => {
        const start = parseTime(booking.start);
        const end = parseTime(booking.end);
        const label = `${booking.title}，${booking.start}–${booking.end}，${booking.organiser}${booking.sample ? '（示例数据）' : ''}`;
        return el('button', {
          type: 'button', className: `tl-block${booking.mine ? ' is-mine' : ''}${blockSize(end - start)}`,
          style: { left: percent(start), width: `${((end - start) / SPAN) * 100}%` },
          title: label, 'aria-label': label, dataset: { id: booking.id },
        }, el('span', {}, booking.title), el('small', {}, `${booking.start}–${booking.end} · ${booking.organiser}`));
      });
      if (draftVisible && draft.roomId === room.id) {
        blocks.push(el('div', {
          className: `tl-draft${draftConflict ? ' is-conflict' : ''}`, 'aria-hidden': 'true',
          style: { left: percent(draftStart), width: `${((draftEnd - draftStart) / SPAN) * 100}%` },
        }));
      }
      children.push(el('div', { className: 'tl-row' },
        el('div', { className: 'tl-room' }, el('strong', {}, room.name), el('span', {}, `${room.capacity} 人 · ${room.equipment.join('、')}`)),
        el('div', { className: 'tl-track', dataset: { room: room.id }, title: `在${room.name}新建预约` }, blocks)));
    }
  }

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (state.viewDate === today && nowMinutes >= RULES.dayStart && nowMinutes <= RULES.dayEnd) {
    children.push(el('div', { className: 'tl-now', style: { '--at': String((nowMinutes - RULES.dayStart) / SPAN) }, 'aria-hidden': 'true' }));
  }
  ui.timeline.replaceChildren(...children);
}

function onTimelineClick(event) {
  const block = event.target.closest('.tl-block');
  if (block) {
    openDetail(block.dataset.id);
    return;
  }
  const track = event.target.closest('.tl-track');
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  let start = RULES.dayStart + Math.floor((ratio * SPAN) / RULES.step) * RULES.step;
  start = Math.min(start, RULES.dayEnd - 60);
  ui.room.value = track.dataset.room;
  ui.date.value = state.viewDate;
  ui.start.value = formatTime(start);
  ui.end.value = formatTime(start + 60);
  refresh();
  ui.title.focus();
}

function renderSummary() {
  const count = bookingsOn(state.bookings, state.viewDate).length;
  ui.summary.textContent = `${formatDay(state.viewDate)} · ${count} 场预约 · ${ROOMS.length} 间会议室`;
  ui.viewDate.value = state.viewDate;
  ui.exportDay.disabled = count === 0;
}

/** 窄屏下日程板可以横向滚动：首次打开时把“当前时间前 1 小时”滚到可见位置。 */
function scrollToNow() {
  const scroller = ui.timeline.parentElement;
  const track = ui.timeline.querySelector('.tl-track');
  if (!scroller || !track || scroller.scrollWidth <= scroller.clientWidth || state.viewDate !== today) return;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes() - 60;
  if (minutes <= RULES.dayStart) return;
  scroller.scrollLeft = (Math.min(minutes, RULES.dayEnd) - RULES.dayStart) / SPAN * track.clientWidth;
}

// ---------------------------------------------------------------- 我的预约与详情

function renderMine() {
  const mine = state.bookings.filter(booking => booking.mine);
  ui.mineCount.textContent = mine.length ? `${mine.length} 场` : '';
  if (!mine.length) {
    ui.mineList.replaceChildren(el('li', { className: 'mine-empty' }, '还没有你的预约。在左侧日程板点击空白处，或直接填写上方表单。'));
    return;
  }
  ui.mineList.replaceChildren(...mine.map(booking => {
    const room = findRoom(ROOMS, booking.roomId);
    return el('li', { className: 'mine-item' },
      el('button', { type: 'button', className: 'mine-main', onclick: () => openDetail(booking.id) },
        el('strong', {}, booking.title, booking.sample ? el('span', { className: 'tag' }, '示例') : null),
        el('span', {}, `${formatShortDay(booking.date)} ${booking.start}–${booking.end} · ${room ? room.name : booking.roomId}`)),
      el('div', { className: 'mine-actions' },
        el('button', { type: 'button', className: 'small-button', title: '下载这场会议的 .ics 文件', onclick: () => downloadBooking(booking) }, '.ics'),
        el('button', { type: 'button', className: 'small-button is-danger', onclick: event => armOrRun(event.currentTarget, '确认', () => cancelBooking(booking.id)) }, '取消')));
  }));
}

function cancelBooking(id) {
  const booking = state.bookings.find(item => item.id === id);
  if (!booking) return;
  state.bookings = removeBooking(state.bookings, id);
  if (booking.sample) state.hiddenSamples = [...state.hiddenSamples, id];
  persist();
  if (state.detailId === id && ui.detail.open) ui.detail.close();
  toast(`已取消「${booking.title}」`);
  render();
}

function openDetail(id) {
  const booking = state.bookings.find(item => item.id === id);
  if (!booking) return;
  state.detailId = id;
  const room = findRoom(ROOMS, booking.roomId);
  const minutes = parseTime(booking.end) - parseTime(booking.start);
  ui.detailTitle.textContent = booking.title;
  const rows = [
    ['会议室', room ? `${roomLabel(room)}（${room.capacity} 人）` : booking.roomId],
    ['时间', `${formatDay(booking.date)} ${booking.start}–${booking.end}（${describeDuration(minutes)}）`],
    ['预约人', booking.organiser],
    ['设备', room ? room.equipment.join('、') : '—'],
    ['来源', booking.sample ? '示例数据（页面预置）' : '在本浏览器创建'],
  ];
  ui.detailList.replaceChildren(...rows.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]));
  ui.detailRemove.dataset.armed = '';
  ui.detailRemove.classList.remove('is-armed');
  ui.detailRemove.textContent = '取消预约';
  if (typeof ui.detail.showModal === 'function') ui.detail.showModal();
  else ui.detail.setAttribute('open', '');
}

// ---------------------------------------------------------------- 汇总渲染与事件

function refresh() {
  renderCheck();
  renderTimeline();
}

function render() {
  if (isValidDate(state.viewDate) && ui.date.value !== state.viewDate) ui.date.value = state.viewDate;
  renderSummary();
  renderTabs();
  renderMine();
  refresh();
}

function changeViewDate(dateText) {
  if (!isValidDate(dateText)) return;
  state.viewDate = dateText;
  ui.date.value = dateText;
  render();
}

ui.form.addEventListener('submit', submitForm);
ui.form.addEventListener('input', () => refresh());
ui.start.addEventListener('change', () => {
  const start = parseTime(ui.start.value);
  if (parseTime(ui.end.value) <= start) ui.end.value = formatTime(Math.min(start + 60, RULES.dayEnd));
  refresh();
});
ui.date.addEventListener('change', () => {
  if (isValidDate(ui.date.value)) changeViewDate(ui.date.value);
  else refresh();
});
ui.timeline.addEventListener('click', onTimelineClick);
ui.viewDate.addEventListener('change', () => changeViewDate(ui.viewDate.value));
ui.prevDay.addEventListener('click', () => changeViewDate(addDays(state.viewDate, -1)));
ui.nextDay.addEventListener('click', () => changeViewDate(addDays(state.viewDate, 1)));
ui.goToday.addEventListener('click', () => changeViewDate(today));
ui.exportDay.addEventListener('click', () => {
  const bookings = bookingsOn(state.bookings, state.viewDate);
  if (!bookings.length) return;
  download(toICalendar(bookings, { calendarName: `RoomDesk · ${state.viewDate}` }), icsFileName(state.viewDate));
  toast(`已导出 ${bookings.length} 场预约到 ${icsFileName(state.viewDate)}`);
});
ui.detailIcs.addEventListener('click', () => {
  const booking = state.bookings.find(item => item.id === state.detailId);
  if (booking) downloadBooking(booking);
});
ui.detailRemove.addEventListener('click', event => armOrRun(event.currentTarget, '再次点击确认取消', () => cancelBooking(state.detailId)));
ui.reset.addEventListener('click', event => armOrRun(event.currentTarget, '确定清除本机预约并恢复示例数据？再点一次', () => {
  removeStorage(STORAGE_KEY);
  if (state.storageOk) ui.storageNote.textContent = '预约保存在当前浏览器的本地存储中，不会上传到任何服务器。';
  state.hiddenSamples = [];
  state.bookings = sampleBookings(today);
  state.viewDate = today;
  toast('已恢复示例数据');
  render();
}));

fillFormOptions();
// 日程板竖线间隔：每小时一条，小时数由 RULES 决定。
ui.timeline.style.setProperty('--hours', String(SPAN / 60));
render();
scrollToNow();
// 每分钟刷新一次“当前时间”红线。
window.setInterval(() => { if (state.viewDate === today) renderTimeline(); }, 60_000);
