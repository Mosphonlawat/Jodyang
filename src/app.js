import { api } from './lib/api.js';
import { cacheGet, cacheSet, queueAdd, queueAll, queueRemove } from './lib/db.js';
import { active, monthlySeries, plotLedger, shareTotals } from './lib/calculations.js';
import { dateKey, dateLabel, escapeHtml as e, id, money } from './lib/format.js';
import { downloadWorkbook } from './lib/xlsx.js';
import { confirmDeleteModal, formModal, mobileMenu, receiptModal } from './forms.js';
import { dateCalendarMarkup, icon, loginView, pageView, renderShell } from './views.js';

const EMPTY_DATA = { plots: [], tappings: [], sales: [], expenses: [], shares: [], users: [], audit: [], settings: {} };
const LABELS = { plots:'แปลงสวน', tappings:'รอบกรีด', sales:'การขาย', expenses:'ค่าใช้จ่าย', shares:'ส่วนแบ่ง', settings:'การตั้งค่า', users:'ผู้ใช้' };
const ACID_STATUS_LABELS = { pending:'รอหยอดกรด', applied:'หยอดแล้ว', skipped:'ไม่ได้หยอด' };

export function mountApp(root) {
  const state = {
    page: 'dashboard',
    setup: false,
    checking: true,
    error: '',
    data: { ...EMPTY_DATA },
    session: null,
    pending: 0,
    online: navigator.onLine,
    range: {},
    year: new Date().getFullYear(),
    reportPlots: null,
    sharePlots: null,
    weather: null,
    rainAlert: '',
    query: '',
  };

  let syncing = false;
  let toastTimer;
  let retryTimer;
  let retryDelay = 2000;
  let resolveConfirmation = null;

  const cacheData = async () => { await cacheSet('farm-data', state.data).catch(() => {}); };

  function showToast(message, tone = 'success') {
    const host = root.querySelector('#toast-root');
    if (!host) return;
    const toneClass = tone === 'error' ? 'border border-[#f2d9d4] bg-[#fff5f3] text-[#9f3b2f]' : tone === 'warning' ? 'border border-[#f0dfbf] bg-[#fff8eb] text-[#8d632c]' : 'border border-[#d8e7f5] bg-[#edf5fd] text-[#365f83]';
    const node = document.createElement('div');
    node.className = `toast pointer-events-auto flex items-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold shadow-lg ${toneClass}`;
    const mark = document.createElement('span'); mark.className = 'toast-mark'; mark.textContent = tone === 'success' ? '✓' : tone === 'warning' ? '!' : '×';
    const text = document.createElement('span'); text.textContent = message;
    node.append(mark,text);
    host.append(node);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.remove(), 3800);
  }

  async function refreshPending() {
    state.pending = (await queueAll().catch(() => [])).length;
    render();
  }

  function render() {
    if (!state.session?.user) {
      root.innerHTML = loginView({ setup: state.setup, error: state.error });
      return;
    }
    const child = pageView(state.page, state.data, state.session.user, state);
    root.innerHTML = renderShell({ page: state.page, user: state.session.user, pending: state.pending, online: state.online, child });
  }

  function persistSession() {
    if (state.session) localStorage.setItem('jodyang-session', JSON.stringify(state.session));
    else localStorage.removeItem('jodyang-session');
  }

  async function loadSetupState() {
    try {
      const status = await api('status');
      state.setup = Boolean(status.needsSetup);
      await cacheSet('needs-setup', state.setup).catch(() => {});
      state.checking = false;
    } catch {
      state.setup = Boolean(await cacheGet('needs-setup').catch(() => false));
      state.checking = false;
      state.error = 'เชื่อมต่อระบบไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
    }
    render();
  }

  function normalizeData(data) {
    const normalized = { ...EMPTY_DATA, ...(data || {}) };
    normalized.settings = normalized.settings || {};
    for (const key of ['plots','tappings','sales','expenses','shares','users','audit']) {
      if (!Array.isArray(normalized[key])) normalized[key] = [];
    }
    return normalized;
  }

  async function enterSession(session) {
    state.session = session;
    state.error = '';
    persistSession();
    state.data = normalizeData(session.data || EMPTY_DATA);
    render();
    if (navigator.onLine) {
      const token = session.token;
      void (async () => {
        if (!session.data) await pullFresh();
        if (state.session?.token !== token) return;
        await flushQueue();
        if (state.data.settings?.latitude && state.data.settings?.longitude) loadWeather();
      })();
    }
    void refreshPending();
  }

  async function pullFresh() {
    if (!state.session?.token || !navigator.onLine) return;
    try {
      const result = await api('pull', { token: state.session.token });
      state.data = normalizeData(result.data);
      await cacheData();
      state.error = '';
      render();
    } catch (error) {
      if (/session|เซสชัน|หมดอายุ|disabled/i.test(error.message)) {
        state.session = null;
        persistSession();
        state.error = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง';
        render();
        return;
      }
      showToast('ยังดึงข้อมูลล่าสุดไม่ได้ จะแสดงข้อมูลที่บันทึกไว้ในเครื่อง', 'warning');
    }
  }

  async function flushQueue() {
    if (syncing || !navigator.onLine || !state.session?.token) return;
    const changes = await queueAll().catch(() => []);
    if (!changes.length) { state.pending = 0; render(); return; }
    syncing = true;
    let retryPending = false;
    try {
      const batch = changes.slice(0, 60);
      const result = await api('mutate', { token: state.session.token, changes: batch });
      await queueRemove(batch.map((change) => change.id));
      if (result.data) state.data = normalizeData(result.data);
      await cacheData();
      state.pending = (await queueAll()).length;
      render();
      retryDelay = 2000;
      retryPending = state.pending > 0;
      showToast('ซิงก์ข้อมูลที่ค้างไว้เรียบร้อย');
    } catch (error) {
      if (/conflict|ชนกับข้อมูล/i.test(error.message)) showToast('มีรายการถูกแก้ไขจากอุปกรณ์อื่น กรุณาซิงก์ก่อนแก้ต่อ', 'warning');
      else if (/session|เซสชัน|หมดอายุ/i.test(error.message)) {
        state.session = null;
        persistSession();
        state.error = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง';
        render();
      } else if (error.api) showToast(error.message, 'error');
      else { retryPending = true; retryDelay = Math.min(60000,retryDelay*2); }
    } finally {
      syncing = false;
      state.pending = (await queueAll().catch(() => [])).length;
      render();
      if (retryTimer) clearTimeout(retryTimer);
      if (retryPending && state.pending && navigator.onLine && state.session?.token) retryTimer=setTimeout(flushQueue,retryDelay);
    }
  }

  async function saveChange(table, record, deleted = false) {
    const rows = Array.isArray(state.data[table]) ? state.data[table] : [];
    const change = {
      id: id(),
      table,
      type: deleted ? 'delete' : 'upsert',
      record: { ...record, updatedAt: new Date().toISOString() },
      recordId: record.id,
      actorId: state.session.user.id,
      happenedAt: new Date().toISOString(),
    };
    if (table === 'settings') state.data.settings = change.record;
    else {
      const index = rows.findIndex((row) => row.id === record.id);
      if (index >= 0) rows[index] = change.record;
      else rows.push(change.record);
      state.data[table] = rows;
    }
    const previous = (await queueAll()).filter((queued)=>queued.table===table&&queued.recordId===record.id);
    if(previous.length) await queueRemove(previous.map((queued)=>queued.id));
    await cacheData();
    await queueAdd(change);
    state.pending = (await queueAll()).length;
    render();
    if (navigator.onLine) await flushQueue();
  }

  async function handleAuth(form) {
    const values = Object.fromEntries(new FormData(form));
    const action = form.dataset.form;
    try {
      state.error = '';
      if (action === 'login') {
        const result = await api('login', values);
        await enterSession({ token: result.token, user: result.user, data: result.data });
        showToast('เข้าสู่ระบบแล้ว กำลังโหลดข้อมูลสวน');
      } else {
        const result = await api('bootstrap', values);
        state.setup = false;
        await cacheSet('needs-setup', false).catch(() => {});
        await enterSession({ token: result.token, user: result.user, data: result.data });
        showToast('สร้างบัญชีผู้ดูแลแล้ว กำลังโหลดข้อมูลสวน');
      }
    } catch (error) {
      state.error = error.message;
      render();
    }
  }

  async function fileToDataUrl(file) {
    if (!file) return null;
    if (file.size > 5 * 1024 * 1024) throw new Error('ไฟล์แนบต้องมีขนาดไม่เกิน 5 MB');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, mimeType: file.type || 'application/octet-stream', dataUrl: reader.result });
      reader.onerror = () => reject(new Error('อ่านไฟล์แนบไม่สำเร็จ'));
      reader.readAsDataURL(file);
    });
  }

  function allocationsFrom(formData, plots, prefix) {
    return plots.map((plot) => ({ plotId: plot.id, [prefix === 'kg' ? 'kg' : 'amount']: Number(formData.get(`${prefix}_${plot.id}`) || 0) }))
      .filter((allocation) => Number(allocation[prefix === 'kg' ? 'kg' : 'amount']) > 0);
  }

  async function handleRecord(form) {
    const kind = form.dataset.kind;
    const table = form.dataset.table;
    const existingId = form.dataset.id;
    const current = (state.data[table] || []).find((row) => row.id === existingId);
    const raw = Object.fromEntries(new FormData(form));
    if (['tapping','sale','expense'].includes(kind) && !raw.date) return showToast('เลือกวันที่ก่อนบันทึก', 'error');
    const record = { ...(current || {}), id: existingId || id(), createdAt: current?.createdAt || new Date().toISOString(), createdBy: current?.createdBy || state.session.user.id };
    let ownerShare = null;

    if (kind === 'tapping') {
      Object.assign(record, { date: raw.date, plotId: raw.plotId, plotName: state.data.plots.find((p)=>p.id===raw.plotId)?.name || '', tapperName: raw.tapperName, rounds: Number(raw.rounds), acidStatus:raw.acidStatus, note: raw.note || '' });
    }
    if (kind === 'plot') {
      Object.assign(record, { name: raw.name.trim(), ownerName: raw.ownerName.trim(), area: Number(raw.area), trees: Number(raw.trees), latitude: raw.latitude === '' ? '' : Number(raw.latitude), longitude: raw.longitude === '' ? '' : Number(raw.longitude) });
      if (!current && !state.data.shares.some((share)=>share.plotId===record.id)) ownerShare = { id: id(), plotId: record.id, personName: record.ownerName, role: 'owner', percent: 100, createdAt: new Date().toISOString(), createdBy: state.session.user.id };
    }
    if (kind === 'sale') {
      const allocations = allocationsFrom(new FormData(form), active(state.data.plots), 'kg');
      const totalKg = allocations.reduce((sum,row)=>sum+row.kg,0);
      if (!totalKg) return showToast('กรอกน้ำหนักขายอย่างน้อยหนึ่งแปลง', 'error');
      Object.assign(record, { date: raw.date, buyer: raw.buyer.trim(), grade: raw.grade, priceKg: Number(raw.priceKg), deductions: Number(raw.deductions||0), note: raw.note||'', allocations, totalKg });
    }
    if (kind === 'expense') {
      const allocations = allocationsFrom(new FormData(form), active(state.data.plots), 'amount');
      if (!allocations.length) return showToast('ระบุยอดค่าใช้จ่ายให้แปลงอย่างน้อยหนึ่งแปลง', 'error');
      Object.assign(record, { date: raw.date, category: raw.category, description: raw.description||'', vendor: raw.vendor||'', allocations });
    }
    if (kind === 'share') {
      Object.assign(record, { plotId: raw.plotId, personName: raw.personName.trim(), role: raw.role, percent: Number(raw.percent) });
      const plotShares = active(state.data.shares||[]).filter((row)=>row.plotId===record.plotId&&row.id!==record.id);
      const total = plotShares.reduce((sum,row)=>sum+Number(row.percent||0),0)+record.percent;
      if (total > 100.001) return showToast(`สัดส่วนของแปลงนี้รวม ${money(total,1)}% เกิน 100%`, 'error');
    }

    const receiptFile = new FormData(form).get('receipt');
    if (receiptFile instanceof File && receiptFile.size) {
      try { record.receiptDraft = await fileToDataUrl(receiptFile); record.receiptId = ''; record.receiptName = receiptFile.name; }
      catch (error) { return showToast(error.message, 'error'); }
    }
    document.querySelector('#modal-root').innerHTML = '';
    await saveChange(table, record);
    if (ownerShare) await saveChange('shares', ownerShare);
    if (kind === 'plot' && record.latitude && record.longitude && !state.data.settings?.latitude) {
      const settings = { ...(state.data.settings||{}), id: 'main', latitude: record.latitude, longitude: record.longitude, locationName: record.name };
      await saveChange('settings', settings);
      loadWeather();
    }
    showToast(current ? 'แก้ไขข้อมูลเรียบร้อย' : 'บันทึกข้อมูลเรียบร้อย');
  }

  async function openForm(kind, record = null) {
    if (kind === 'tapping' && state.session.user.role === 'viewer') return;
    if (['plot','sale','expense','share','user'].includes(kind) && state.session.user.role !== 'admin') return;
    document.querySelector('#modal-root').innerHTML = formModal({ kind, data: state.data, user: state.session.user, record });
  }

  async function removeRecord(table, recordId) {
    const record = (state.data[table] || []).find((row) => row.id === recordId);
    if (!record) return;
    if (table === 'users') return;
    if (table === 'tappings' && state.session.user.role === 'viewer') return;
    if (table !== 'tappings' && state.session.user.role !== 'admin') return;
    const item=record.name||record.plotName||record.buyer||record.category||record.personName||LABELS[table];
    const confirmed=await new Promise((resolve)=>{
      resolveConfirmation=resolve;
      document.querySelector('#modal-root').innerHTML=confirmDeleteModal({item,detail:record.date?dateLabel(record.date):''});
    });
    if (!confirmed) return;
    await saveChange(table, { ...record, deleted: true }, true);
    showToast('ลบรายการแล้ว และบันทึกประวัติไว้ในระบบ');
  }

  async function loadWeather() {
    const settings = state.data.settings || {};
    const lat = Number(settings.latitude); const lon = Number(settings.longitude);
    if (!lat || !lon) return;
    try {
      const days = Math.min(7, Math.max(1, Number(settings.forecastDays || 7)));
      const hours = Math.min(72, Math.max(24, Number(settings.hourlyHours || 24)));
      const params = new URLSearchParams({
        latitude: String(lat), longitude: String(lon), timezone: 'auto', forecast_days: String(days), forecast_hours: String(hours),
        current: 'temperature_2m,precipitation,weather_code,wind_speed_10m',
        hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!response.ok) throw new Error('weather');
      const raw = await response.json();
      const hourly = raw.hourly.time.map((time,index)=>({time,temperature_2m:raw.hourly.temperature_2m[index],temperature:raw.hourly.temperature_2m[index],precipitation_probability:raw.hourly.precipitation_probability[index],rainChance:raw.hourly.precipitation_probability[index],precipitation:raw.hourly.precipitation[index],rain:raw.hourly.precipitation[index],weather_code:raw.hourly.weather_code[index],wind_speed_10m:raw.hourly.wind_speed_10m[index]}));
      const daily = raw.daily.time.map((date,index)=>({date,min:raw.daily.temperature_2m_min[index],max:raw.daily.temperature_2m_max[index],rainChance:raw.daily.precipitation_probability_max[index],rain:raw.daily.precipitation_sum[index],weatherCode:raw.daily.weather_code[index]}));
      const threshold = Number(settings.rainThreshold || 60);
      const alert = hourly.find((row)=>row.rainChance >= threshold);
      const currentHour = Math.max(0, hourly.findIndex((row)=>new Date(row.time).getTime() >= new Date(raw.current.time).getTime()));
      const current = { ...raw.current, precipitation_probability: hourly[currentHour]?.rainChance ?? 0 };
      state.weather = { current, hourly, daily, summary: weatherText(raw.current.weather_code) };
      state.rainAlert = alert ? new Date(alert.time).toLocaleString('th-TH',{weekday:'short',hour:'2-digit',minute:'2-digit'}) : '';
      await cacheSet('weather', state.weather).catch(()=>{});
      render();
    } catch {
      state.weather = state.weather || await cacheGet('weather').catch(()=>null);
      if (!state.weather) showToast('โหลดพยากรณ์อากาศไม่ได้ ตรวจสอบอินเทอร์เน็ต', 'warning');
      render();
    }
  }

  function weatherText(code) {
    if (code === 0) return 'ท้องฟ้าแจ่มใส';
    if ([1,2,3].includes(code)) return 'มีเมฆบางส่วน';
    if ([45,48].includes(code)) return 'มีหมอก';
    if (code >= 51 && code <= 67) return 'มีฝนเล็กน้อย';
    if (code >= 71 && code <= 77) return 'มีหิมะ';
    if (code >= 80 && code <= 82) return 'มีฝน';
    if (code >= 95) return 'อาจมีพายุฝนฟ้าคะนอง';
    return 'สภาพอากาศทั่วไป';
  }

  function locationInto(form) {
    if (!navigator.geolocation) return showToast('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง', 'error');
    navigator.geolocation.getCurrentPosition((position)=>{
      const lat=form.querySelector('[name="latitude"]');const lon=form.querySelector('[name="longitude"]');
      if(lat)lat.value=position.coords.latitude.toFixed(6);if(lon)lon.value=position.coords.longitude.toFixed(6);
      showToast('ระบุตำแหน่งแล้ว อย่าลืมบันทึกข้อมูล');
    },()=>showToast('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง กรุณากรอกพิกัดเอง','warning'),{enableHighAccuracy:true,timeout:10000});
  }

  async function exportReport() {
    const plots = state.reportPlots === null ? active(state.data.plots||[]).map((p)=>p.id) : state.reportPlots;
    const ledger = plotLedger(state.data,state.range).filter((row)=>plots.includes(row.plotId));
    const people = shareTotals(ledger);
    const transactions = [['สรุปรายแปลง','น้ำหนักขาย (กก.)','ยอดก่อนหัก (บาท)','รายการหัก (บาท)','ค่าใช้จ่าย (บาท)','ยอดสุทธิ (บาท)','รอบกรีด']];
    ledger.forEach((row)=>transactions.push([row.plotName,row.kg,row.gross,row.deductions,row.expenses,row.net,row.rounds]));
    const shareRows=[['ผู้รับส่วนแบ่ง','ประเภท','แปลงที่รวม','รายได้ก่อนหัก','รายการหัก','ค่าใช้จ่าย','ยอดสุทธิ']];
    people.forEach((row)=>shareRows.push([row.personName,row.role==='owner'?'เจ้าของสวน':'คนกรีด',row.plots.join(', '),row.gross,row.deductions,row.expenses,row.net]));
    const sales=[['วันที่','ผู้ซื้อ','แปลง','น้ำหนักกก.','ราคา/กก.','ยอดก่อนหัก','รายการหัก','สุทธิ']];
    active(state.data.sales||[]).filter((row)=>inRange(row.date,state.range)).forEach((row)=>(row.allocations||[]).filter((a)=>plots.includes(a.plotId)).forEach((allocation)=>{
      const plot=state.data.plots.find((p)=>p.id===allocation.plotId);const gross=allocation.kg*row.priceKg;const deduction=row.totalKg?row.deductions*allocation.kg/row.totalKg:0;
      sales.push([row.date,row.buyer,plot?.name||'',allocation.kg,row.priceKg,gross,deduction,gross-deduction]);
    }));
    const expenses=[['วันที่','หมวด','รายละเอียด','แปลง','ค่าใช้จ่าย']];
    active(state.data.expenses||[]).filter((row)=>inRange(row.date,state.range)).forEach((row)=>(row.allocations||[]).filter((a)=>plots.includes(a.plotId)).forEach((allocation)=>{
      expenses.push([row.date,row.category,row.description||'',state.data.plots.find((p)=>p.id===allocation.plotId)?.name||'',allocation.amount]);
    }));
    const tappings=[['วันที่','แปลง','คนกรีด','จำนวนรอบ','หมายเหตุ']];
    active(state.data.tappings||[]).filter((row)=>inRange(row.date,state.range)&&plots.includes(row.plotId)).forEach((row)=>tappings.push([row.date,row.plotName,row.tapperName,row.rounds,row.note||'']));
    downloadWorkbook(`Jodyang-รายงาน-${dateKey()}.xlsx`,[
      {name:'สรุปแปลง',rows:transactions},
      {name:'ส่วนแบ่ง',rows:shareRows},
      {name:'การขาย',rows:sales},
      {name:'ค่าใช้จ่าย',rows:expenses},
      {name:'รอบกรีด',rows:tappings},
    ]);
  }

  function inRange(date, range) { return (!range.from || date >= range.from) && (!range.to || date <= range.to); }

  async function handleFormSubmit(event) {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    const action=form.dataset.form;
    if (action==='login'||action==='bootstrap') return handleAuth(form);
    if (action==='record') return handleRecord(form);
    if (action==='settings') {
      const raw=Object.fromEntries(new FormData(form));
      const settings={...(state.data.settings||{}),id:'main',locationName:raw.locationName,latitude:raw.latitude?Number(raw.latitude):'',longitude:raw.longitude?Number(raw.longitude):'',forecastDays:Number(raw.forecastDays),hourlyHours:Number(raw.hourlyHours),rainThreshold:Number(raw.rainThreshold)};
      await saveChange('settings',settings);showToast('บันทึกการตั้งค่าแล้ว');loadWeather();return;
    }
    if (action==='user') {
      const values=Object.fromEntries(new FormData(form));
      if(state.session.user.role!=='admin')return showToast('เฉพาะแอดมินเพิ่มบัญชีได้','error');
      values.username=String(values.username||'').trim().toLowerCase();
      if(state.data.users.some((person)=>String(person.username||'').trim().toLowerCase()===values.username))return showToast('ชื่อผู้ใช้นี้มีอยู่แล้ว แม้บัญชีเดิมจะปิดใช้งานอยู่', 'error');
      if(form.dataset.submitting==='true')return;
      form.dataset.submitting='true';const submit=form.querySelector('[type="submit"]');if(submit){submit.disabled=true;submit.textContent='กำลังสร้างบัญชี…';}
      try { await api('createUser',{token:state.session.token,...values});document.querySelector('#modal-root').innerHTML='';await pullFresh();showToast('สร้างบัญชีเรียบร้อย'); }
      catch(error){showToast(error.message,'error');}
      finally {if(form.isConnected){delete form.dataset.submitting;if(submit){submit.disabled=false;submit.textContent='บันทึก';}}}
      return;
    }
    if (action==='rename-user') {
      if(state.session.user.role!=='admin')return showToast('เฉพาะแอดมินเปลี่ยนชื่อผู้ใช้ได้','error');
      const values=Object.fromEntries(new FormData(form));values.username=String(values.username||'').trim().toLowerCase();
      if(state.data.users.some((person)=>person.id!==form.dataset.id&&String(person.username||'').trim().toLowerCase()===values.username))return showToast('มีชื่อผู้ใช้นี้แล้ว กรุณาเลือกชื่ออื่น','error');
      try {await api('renameUser',{token:state.session.token,userId:form.dataset.id,username:values.username});document.querySelector('#modal-root').innerHTML='';await pullFresh();showToast('เปลี่ยนชื่อผู้ใช้แล้ว');}
      catch(error){showToast(error.message,'error');}
      return;
    }
    if (action==='change-password') {
      const values=Object.fromEntries(new FormData(form));
      if(values.newPassword!==values.confirmPassword)return showToast('รหัสผ่านใหม่ไม่ตรงกัน','error');
      try { await api('changePassword',{token:state.session.token,currentPassword:values.currentPassword,newPassword:values.newPassword});document.querySelector('#modal-root').innerHTML='';showToast('เปลี่ยนรหัสผ่านแล้ว'); }
      catch(error){showToast(error.message,'error');}
    }
  }

  async function handleClick(event) {
    const button=event.target.closest('[data-action]');
    if(!event.target.closest('[data-date-picker]'))root.querySelectorAll('.date-picker-panel:not([hidden])').forEach((panel)=>{panel.hidden=true;panel.closest('.date-picker')?.querySelector('[data-date-open]')?.setAttribute('aria-expanded','false');});
    if(!button)return;
    const action=button.dataset.action;
    if(action==='backdrop'&&event.target===button){document.querySelector('#modal-root').innerHTML='';if(resolveConfirmation){const resolve=resolveConfirmation;resolveConfirmation=null;resolve(false);}return;}
    if(action==='close'){document.querySelector('#modal-root').innerHTML='';if(resolveConfirmation){const resolve=resolveConfirmation;resolveConfirmation=null;resolve(false);}return;}
    if(action==='confirm-delete'){document.querySelector('#modal-root').innerHTML='';if(resolveConfirmation){const resolve=resolveConfirmation;resolveConfirmation=null;resolve(true);}return;}
    if(action==='date-open'){
      const picker=button.closest('[data-date-picker]');const panel=picker.querySelector('[data-date-panel]');
      root.querySelectorAll('.date-picker-panel').forEach((other)=>{if(other!==panel){other.hidden=true;other.closest('.date-picker')?.querySelector('[data-date-open]')?.setAttribute('aria-expanded','false');}});
      panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));
      if(!panel.hidden)panel.innerHTML=dateCalendarMarkup(Number(picker.dataset.viewYear),Number(picker.dataset.viewMonth),picker.querySelector('[data-date-value]').value);
      return;
    }
    if(action==='date-month'){
      const picker=button.closest('[data-date-picker]');const moved=new Date(Number(picker.dataset.viewYear),Number(picker.dataset.viewMonth)+Number(button.dataset.delta),1);
      picker.dataset.viewYear=moved.getFullYear();picker.dataset.viewMonth=moved.getMonth();
      picker.querySelector('[data-date-panel]').innerHTML=dateCalendarMarkup(moved.getFullYear(),moved.getMonth(),picker.querySelector('[data-date-value]').value);return;
    }
    if(action==='date-select'||action==='date-today'){
      const picker=button.closest('[data-date-picker]');const value=action==='date-today'?dateKey():button.dataset.dateValue;
      const input=picker.querySelector('[data-date-value]');input.value=value;
      picker.querySelector('[data-date-label]').textContent=dateLabel(value);
      const date=new Date(`${value}T00:00:00`);picker.dataset.viewYear=date.getFullYear();picker.dataset.viewMonth=date.getMonth();
      const panel=picker.querySelector('[data-date-panel]');panel.hidden=true;picker.querySelector('[data-date-open]').setAttribute('aria-expanded','false');
      if(input.matches('[data-range]'))input.dispatchEvent(new Event('change',{bubbles:true}));return;
    }
    if(action==='go'){state.page=button.dataset.page;state.query='';render();return;}
    if(action==='new'){return openForm(button.dataset.kind);}
    if(action==='mobile-menu'){document.querySelector('#modal-root').innerHTML=mobileMenu(state.data,state.session.user,state.page);return;}
    if(action==='user-menu'){showToast(`${state.session.user.displayName||state.session.user.username} · ${state.session.user.role==='admin'?'แอดมิน':state.session.user.role==='tapper'?'คนกรีด':'ผู้ดูข้อมูล'}`);return;}
    if(action==='edit'){
      const row=(state.data[button.dataset.table]||[]).find((item)=>item.id===button.dataset.id);if(!row)return;
      const kind={tappings:'tapping',plots:'plot',sales:'sale',expenses:'expense',shares:'share'}[button.dataset.table];return openForm(kind,row);
    }
    if(action==='rename-user'){
      const row=state.data.users.find((item)=>item.id===button.dataset.id);if(!row)return;
      document.querySelector('#modal-root').innerHTML=formModal({kind:'rename-user',data:state.data,user:state.session.user,record:row});return;
    }
    if(action==='delete-user'){
      if(state.session.user.role!=='admin')return showToast('เฉพาะแอดมินลบบัญชีได้','error');
      const person=state.data.users.find((item)=>item.id===button.dataset.id);
      if(!person||person.id===state.session.user.id)return showToast('ไม่สามารถลบบัญชีที่กำลังใช้งานได้','warning');
      const confirmed=await new Promise((resolve)=>{
        resolveConfirmation=resolve;
        document.querySelector('#modal-root').innerHTML=confirmDeleteModal({item:`${person.displayName||person.username} (${person.username})`,detail:person.role==='admin'?'แอดมิน':person.role==='tapper'?'คนกรีด':'ผู้ดูข้อมูล',title:'ลบบัญชีนี้ถาวร?',note:'บัญชีนี้จะเข้าสู่ระบบไม่ได้ ข้อมูลสวนและประวัติการทำรายการเดิมจะยังคงอยู่',confirmText:'ลบบัญชี'});
      });
      if(!confirmed)return;
      try{await api('deleteUser',{token:state.session.token,userId:person.id});await pullFresh();showToast('ลบบัญชีแล้ว ข้อมูลสวนและประวัติเดิมยังอยู่');}
      catch(error){showToast(error.message,'error');}
      return;
    }
    if(action==='plot-filter-toggle'){
      const key=button.dataset.filterKey==='share'?'sharePlots':'reportPlots';
      const all=active(state.data.plots||[]).map((plot)=>plot.id);const current=state[key]===null?all:[...state[key]];const id=button.dataset.plotId;
      state[key]=current.includes(id)?current.filter((item)=>item!==id):[...current,id];render();return;
    }
    if(action==='plot-filter-all'){state[button.dataset.filterKey==='share'?'sharePlots':'reportPlots']=null;render();return;}
    if(action==='plot-filter-none'){state[button.dataset.filterKey==='share'?'sharePlots':'reportPlots']=[];render();return;}
    if(action==='delete')return removeRecord(button.dataset.table,button.dataset.id);
    if(action==='sync'){await flushQueue();await pullFresh();showToast('ตรวจสอบการซิงก์เรียบร้อย');return;}
    if(action==='logout'){
      const token=state.session?.token;
      state.session=null;state.setup=false;state.data=normalizeData(EMPTY_DATA);state.pending=0;persistSession();render();showToast('ออกจากระบบแล้ว');
      if(token&&navigator.onLine)void api('logout',{token}).catch(()=>{});
      return;
    }
    if(action==='weather-refresh'){await loadWeather();return;}
    if(action==='edit-weather'){if(state.session.user.role==='admin'){state.page='settings';render();}else showToast('ให้แอดมินตั้งค่าพิกัดสวน','warning');return;}
    if(action==='geolocate'){
      if(state.session.user.role!=='admin')return showToast('ให้แอดมินตั้งค่าพิกัดสวน','warning');
      if(!navigator.geolocation)return showToast('อุปกรณ์นี้ไม่รองรับการระบุตำแหน่ง','error');
      navigator.geolocation.getCurrentPosition(async(position)=>{
        const settings={...(state.data.settings||{}),id:'main',latitude:position.coords.latitude,longitude:position.coords.longitude,locationName:state.data.settings?.locationName||'ตำแหน่งปัจจุบัน'};
        await saveChange('settings',settings);loadWeather();showToast('บันทึกพิกัดสวนแล้ว');
      },()=>showToast('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง กรุณากรอกพิกัดเอง','warning'),{enableHighAccuracy:true,timeout:10000});return;
    }
    if(action==='form-geolocate'){
      const form=button.closest('form');if(form)locationInto(form);return;
    }
    if(action==='receipt'){
      try {const result=await api('receipt',{token:state.session.token,fileId:button.dataset.id});document.querySelector('#modal-root').innerHTML=receiptModal({name:result.name,dataUrl:result.dataUrl});}
      catch(error){showToast(error.message,'error');}return;
    }
    if(action==='export'){await exportReport();return;}
    if(action==='print'){window.print();return;}
    if(action==='change-password'){document.querySelector('#modal-root').innerHTML=formModal({kind:'change-password',data:state.data,user:state.session.user});return;}
    if(action==='toggle-user'){
      const person=state.data.users.find((u)=>u.id===button.dataset.id);if(!person||person.id===state.session.user.id)return showToast('บัญชีที่กำลังใช้งานไม่สามารถปิดได้','warning');
      try{await api('setUserActive',{token:state.session.token,userId:person.id,active:!person.active});await pullFresh();showToast(person.active?'ปิดบัญชีแล้ว':'เปิดบัญชีแล้ว');}
      catch(error){showToast(error.message,'error');}return;
    }
  }

  function handleInput(event) {
    if(event.target.matches('[data-search]')){
      const query=event.target.value.toLowerCase();
      root.querySelectorAll('[data-searchable]').forEach((row)=>{row.hidden=!row.dataset.searchable.includes(query);});
      return;
    }
  }

  async function handleChange(event) {
    const target=event.target;
    if(target.matches('[data-acid-status]')){
      const row=state.data.tappings.find((item)=>item.id===target.dataset.id);
      if(!row||!ACID_STATUS_LABELS[target.value])return;
      await saveChange('tappings',{...row,acidStatus:target.value});
      showToast(`อัปเดตสถานะเป็น “${ACID_STATUS_LABELS[target.value]}” แล้ว`);
      return;
    }
    if(target.matches('[data-filter="year"]')){state.year=Number(target.value);render();return;}
    if(target.matches('[data-filter="forecast-days"]')){
      const settings={...(state.data.settings||{}),id:'main',forecastDays:Number(target.value)};await saveChange('settings',settings);loadWeather();return;
    }
    if(target.matches('[data-filter="hourly-hours"]')){
      const settings={...(state.data.settings||{}),id:'main',hourlyHours:Number(target.value)};await saveChange('settings',settings);loadWeather();return;
    }
    if(target.matches('[data-range]')){state.range={...state.range,[target.dataset.range]:target.value};render();return;}
  }

  root.addEventListener('click',handleClick);
  root.addEventListener('submit',handleFormSubmit);
  root.addEventListener('input',handleInput);
  root.addEventListener('change',handleChange);
  window.addEventListener('online',()=>{state.online=true;render();flushQueue();pullFresh();loadWeather();});
  window.addEventListener('offline',()=>{state.online=false;render();showToast('ออฟไลน์แล้ว รายการใหม่จะรอซิงก์','warning');});

  async function start() {
    state.data=normalizeData(await cacheGet('farm-data').catch(()=>EMPTY_DATA));
    state.weather=await cacheGet('weather').catch(()=>null);
    try { state.session=JSON.parse(localStorage.getItem('jodyang-session')||'null'); } catch { state.session=null; }
    if(state.session?.token&&state.session?.user){
      state.page='dashboard';
      state.pending=(await queueAll().catch(()=>[])).length;
      render();
      if(navigator.onLine){await flushQueue();await pullFresh();loadWeather();}
      return;
    }
    state.session=null;
    await loadSetupState();
  }

  start();
}
