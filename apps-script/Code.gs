const TABLES = {
  Users: 'users',
  Sessions: 'sessions',
  Plots: 'plots',
  Tappings: 'tappings',
  Sales: 'sales',
  Expenses: 'expenses',
  Shares: 'shares',
  Settings: 'settings',
  AuditLog: 'audit',
  Mutations: 'mutations',
};
const PASSWORD_ITERATIONS = 12000;
const SESSION_HOURS = 12;
const MAX_BATCH = 60;
const DATA_TABS = ['Users','Sessions','Plots','Tappings','Sales','Expenses','Shares','Settings','AuditLog','Mutations'];

/** Run once from the bound spreadsheet's Apps Script editor. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('เปิด Apps Script จาก Google Sheet ที่ต้องการใช้เป็นฐานข้อมูล');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  DATA_TABS.forEach((name) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 2).setValues([['id', 'json']]);
    sheet.setFrozenRows(1);
  });
  if (!props.getProperty('PROXY_SECRET')) props.setProperty('PROXY_SECRET', randomSecret_());
  if (!props.getProperty('SETUP_KEY')) props.setProperty('SETUP_KEY', randomSecret_());
  if (!props.getProperty('RECEIPT_FOLDER_ID')) {
    const folder = DriveApp.createFolder('Jodyang receipts');
    props.setProperty('RECEIPT_FOLDER_ID', folder.getId());
  }
  if (!readById_('Settings', 'main')) {
    upsert_('Settings', { id: 'main', locationName: '', latitude: '', longitude: '', forecastDays: 7, hourlyHours: 24, rainThreshold: 60, expenseCategories: ['น้ำ','กรดยาง','ภาชนะ/น้ำยาง','มีดกรีดยาง','ลวด','ยากันยุง','อื่น ๆ'] });
  }
  Logger.log('Setup complete. Copy these values from the execution log to the matching Cloudflare secrets:');
  Logger.log('GAS_PROXY_SECRET=' + props.getProperty('PROXY_SECRET'));
  Logger.log('JODYANG_SETUP_KEY=' + props.getProperty('SETUP_KEY'));
}

function doGet() {
  return json_({ ok: true, service: 'Jodyang API' });
}

function doPost(event) {
  try {
    const body = JSON.parse((event && event.postData && event.postData.contents) || '{}');
    const proxySecret = PropertiesService.getScriptProperties().getProperty('PROXY_SECRET') || '';
    if (!proxySecret || !constantTimeEqual_(String(body.proxySecret || ''), proxySecret)) {
      return json_({ ok: false, error: 'คำขอไม่ได้รับอนุญาต' });
    }
    return json_(route_(body));
  } catch (error) {
    return json_({ ok: false, error: safeError_(error) });
  }
}

function route_(body) {
  switch (body.action) {
    case 'status': return status_();
    case 'bootstrap': return bootstrap_(body);
    case 'login': return login_(body);
    case 'pull': { const { user } = verifySession_(body.token); return { ok: true, data: pull_(user) }; }
    case 'mutate': return mutate_(body);
    case 'createUser': return createUser_(body);
    case 'renameUser': return renameUser_(body);
    case 'setUserActive': return setUserActive_(body);
    case 'deleteUser': return deleteUser_(body);
    case 'changePassword': return changePassword_(body);
    case 'logout': return logout_(body);
    case 'receipt': return receipt_(body);
    default: return { ok: false, error: 'ไม่รู้จักคำสั่งนี้' };
  }
}

function status_() {
  const users = rows_('Users');
  return { ok: true, needsSetup: users.length === 0, ready: Boolean(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')) };
}

function bootstrap_(body) {
  const props = PropertiesService.getScriptProperties();
  const supplied = String(body.setupKey || '');
  if (!constantTimeEqual_(supplied, props.getProperty('SETUP_KEY') || '')) return { ok: false, error: 'รหัสตั้งค่าเริ่มต้นไม่ถูกต้อง' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (rows_('Users').some((row) => row.role === 'admin')) return { ok: false, error: 'มีบัญชีแอดมินแล้ว กรุณาเข้าสู่ระบบ' };
    const user = newUser_(body.username, body.displayName, 'admin', body.password);
    append_('Users', user);
    props.deleteProperty('SETUP_KEY');
    appendAudit_({ id: user.id, displayName: user.displayName }, 'สร้างบัญชีแอดมิน', 'ผู้ใช้งาน', user.username);
    return issueSession_(user);
  } finally { lock.releaseLock(); }
}

function login_(body) {
  const username = String(body.username || '').trim().toLowerCase();
  const key = 'login:' + sha256_(username).slice(0, 32);
  const cache = CacheService.getScriptCache();
  const attempts = Number(cache.get(key) || 0);
  if (attempts >= 5) return { ok: false, error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่' };
  const user = rows_('Users').find((row) => String(row.username || '').toLowerCase() === username && row.active !== false);
  if (!user || !verifyPassword_(String(body.password || ''), user.passwordSalt, user.passwordHash)) {
    cache.put(key, String(attempts + 1), 900);
    return { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }
  cache.remove(key);
  return issueSession_(user);
}

function issueSession_(user) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  append_('Sessions', { id: sha256_(token), userId: user.id, expiresAt, revoked: false, createdAt: now.toISOString() });
  return { ok: true, token, user: publicUser_(user), data: pull_(user) };
}

function verifySession_(token) {
  if (!token) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
  const hash = sha256_(String(token));
  const session = rows_('Sessions').find((row) => row.id === hash && !row.revoked && new Date(row.expiresAt).getTime() > Date.now());
  if (!session) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
  const user = readById_('Users', session.userId);
  if (!user || user.active === false) throw new Error('บัญชีนี้ถูกปิดใช้งาน');
  return { session, user };
}

function pull_(viewer) {
  const result = {};
  Object.keys(TABLES).forEach((sheetName) => {
    if (['Sessions','Mutations'].includes(sheetName)) return;
    const key = TABLES[sheetName];
    const list = rows_(sheetName);
    if (sheetName === 'Settings') result.settings = list.find((row) => row.id === 'main') || { id:'main', forecastDays:7, hourlyHours:24, rainThreshold:60, expenseCategories:['น้ำ','กรดยาง','ภาชนะ/น้ำยาง','มีดกรีดยาง','ลวด','ยากันยุง','อื่น ๆ'] };
    else if (sheetName === 'Users') result[key] = viewer && viewer.role === 'admin' ? list.map(publicUser_) : [];
    else if (sheetName === 'AuditLog') result[key] = viewer && viewer.role === 'admin' ? list : [];
    else result[key] = list;
  });
  return result;
}

function mutate_(body) {
  const { user } = verifySession_(body.token);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!changes.length || changes.length > MAX_BATCH) return { ok: false, error: 'จำนวนรายการที่จะซิงก์ไม่ถูกต้อง' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const known = new Set(rows_('Mutations').map((row) => row.id));
    const failures = [];
    for (const change of changes) {
      if (!change || !change.id || !change.record || !change.table) { failures.push('รายการซิงก์ไม่สมบูรณ์'); continue; }
      if (known.has(change.id)) continue;
      if (change.actorId && change.actorId !== user.id) { failures.push('รายการที่รอซิงก์เป็นของบัญชีอื่น กรุณาเข้าสู่ระบบด้วยบัญชีเดิม'); continue; }
      const sheetName = Object.keys(TABLES).find((name) => TABLES[name] === change.table);
      if (!sheetName || ['Users','Sessions','AuditLog','Mutations'].includes(sheetName)) { failures.push('ไม่อนุญาตให้แก้ไขข้อมูลประเภทนี้'); continue; }
      if (!canMutate_(user.role, change.table)) { failures.push(`บัญชีนี้ไม่มีสิทธิ์แก้ไข${LABEL_FOR_(change.table)}`); continue; }
      const record = Object.assign({}, change.record, { updatedAt: change.happenedAt || new Date().toISOString(), updatedBy: user.id, updatedByName: user.displayName });
      if (change.table === 'settings') record.id = 'main';
      const current = readById_(sheetName, record.id);
      if (change.type !== 'delete' && change.type !== 'upsert') { failures.push('รูปแบบการแก้ไขไม่ถูกต้อง'); continue; }
      if (change.type === 'delete') record.deleted = true;
      else {
        const validationError = validateRecord_(change.table, record, current);
        if (validationError) { failures.push(validationError); continue; }
        if (record.receiptDraft) {
          try {
            const receipt = saveReceipt_(record.receiptDraft);
            record.receiptId = receipt.id;
            record.receiptName = receipt.name;
            delete record.receiptDraft;
          } catch (error) { failures.push('แนบใบเสร็จไม่สำเร็จ: ' + safeError_(error)); continue; }
        }
      }
      upsert_(sheetName, record);
      const summary = describe_(record, change.table);
      appendAudit_({ id: user.id, displayName: user.displayName }, change.type === 'delete' ? 'ลบ' : current ? 'แก้ไข' : 'เพิ่ม', LABEL_FOR_(change.table), summary);
      append_('Mutations', { id: change.id, appliedAt: new Date().toISOString() });
      known.add(change.id);
    }
    if (failures.length) return { ok: false, error: failures.join(' · '), data: pull_(user) };
    return { ok: true, data: pull_(user) };
  } finally { lock.releaseLock(); }
}

function canMutate_(role, table) {
  if (role === 'admin') return ['plots','tappings','sales','expenses','shares','settings'].includes(table);
  return role === 'tapper' && table === 'tappings';
}

function validateRecord_(table, record, current) {
  const plots = rows_('Plots').filter((plot) => !plot.deleted);
  const exists = (plotId) => plots.some((plot) => plot.id === plotId);
  const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''));
  const finiteNonnegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  if (table === 'plots') {
    if (!String(record.name || '').trim() || !String(record.ownerName || '').trim()) return 'กรอกชื่อแปลงและชื่อเจ้าของสวนให้ครบ';
    if (!finiteNonnegative(record.area) || !finiteNonnegative(record.trees)) return 'พื้นที่และจำนวนต้นต้องเป็นตัวเลขตั้งแต่ศูนย์ขึ้นไป';
    if (record.latitude !== '' && record.latitude != null && (Number(record.latitude) < -90 || Number(record.latitude) > 90)) return 'ละติจูดต้องอยู่ระหว่าง -90 ถึง 90';
    if (record.longitude !== '' && record.longitude != null && (Number(record.longitude) < -180 || Number(record.longitude) > 180)) return 'ลองจิจูดต้องอยู่ระหว่าง -180 ถึง 180';
  }
  if (table === 'tappings') {
    if (!exists(record.plotId)) return 'เลือกแปลงที่มีอยู่ในระบบ';
    if (!validDate(record.date) || !String(record.tapperName || '').trim()) return 'กรอกวันที่และชื่อคนกรีดให้ครบ';
    if (!Number.isInteger(Number(record.rounds)) || Number(record.rounds) < 1) return 'จำนวนรอบกรีดต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป';
    if (!['pending','applied','skipped'].includes(record.acidStatus)) return 'เลือกสถานะหยอดกรดให้ครบ';
  }
  if (table === 'sales') {
    if (!validDate(record.date) || !String(record.buyer || '').trim()) return 'กรอกวันที่ขายและชื่อผู้ซื้อให้ครบ';
    if (!finiteNonnegative(record.priceKg) || !finiteNonnegative(record.deductions || 0)) return 'ราคาและรายการหักต้องเป็นตัวเลขตั้งแต่ศูนย์ขึ้นไป';
    if (!Array.isArray(record.allocations) || !record.allocations.length || record.allocations.some((item) => !exists(item.plotId) || !finiteNonnegative(item.kg) || Number(item.kg) <= 0)) return 'ระบุน้ำหนักขายที่ถูกต้องแยกตามแปลง';
    const totalKg = record.allocations.reduce((sum,item)=>sum+Number(item.kg),0);
    if (Math.abs(totalKg-Number(record.totalKg||0)) > 0.001) return 'น้ำหนักรวมไม่ตรงกับน้ำหนักที่แยกตามแปลง';
    if (Number(record.deductions || 0) > totalKg * Number(record.priceKg || 0)) return 'รายการหักจากผู้ซื้อสูงกว่ายอดขาย';
  }
  if (table === 'expenses') {
    if (!validDate(record.date) || !String(record.category || '').trim()) return 'กรอกวันที่และหมวดค่าใช้จ่ายให้ครบ';
    if (!Array.isArray(record.allocations) || !record.allocations.length || record.allocations.some((item) => !exists(item.plotId) || !finiteNonnegative(item.amount) || Number(item.amount) <= 0)) return 'ระบุค่าใช้จ่ายเป็นจำนวนเงินแยกตามแปลง';
  }
  if (table === 'shares') {
    if (!exists(record.plotId) || !String(record.personName || '').trim()) return 'เลือกแปลงและกรอกชื่อผู้รับส่วนแบ่ง';
    if (!['owner','tapper'].includes(record.role) || !finiteNonnegative(record.percent) || Number(record.percent) > 100) return 'ประเภทหรือเปอร์เซ็นต์ส่วนแบ่งไม่ถูกต้อง';
    const existingTotal = rows_('Shares').filter((share) => share.plotId === record.plotId && !share.deleted && share.id !== record.id).reduce((sum,share)=>sum+Number(share.percent||0),0);
    if (existingTotal + Number(record.percent) > 100.001) return 'สัดส่วนผู้รับส่วนแบ่งในแปลงนี้รวมกันเกิน 100%';
  }
  if (table === 'settings') {
    if (record.latitude !== '' && record.latitude != null && (Number(record.latitude) < -90 || Number(record.latitude) > 90)) return 'ละติจูดต้องอยู่ระหว่าง -90 ถึง 90';
    if (record.longitude !== '' && record.longitude != null && (Number(record.longitude) < -180 || Number(record.longitude) > 180)) return 'ลองจิจูดต้องอยู่ระหว่าง -180 ถึง 180';
    if (![3,5,7].includes(Number(record.forecastDays || 7)) || ![24,48,72].includes(Number(record.hourlyHours || 24))) return 'ช่วงพยากรณ์อากาศไม่ถูกต้อง';
    if (Number(record.rainThreshold || 60) < 1 || Number(record.rainThreshold || 60) > 100) return 'เกณฑ์แจ้งเตือนฝนต้องอยู่ระหว่าง 1 ถึง 100';
  }
  return '';
}

function createUser_(body) {
  const { user } = verifySession_(body.token);
  requireAdmin_(user);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const username = String(body.username || '').trim().toLowerCase();
    if (username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) return { ok:false, error:'ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัว และใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง' };
    if (rows_('Users').some((row) => String(row.username || '').trim().toLowerCase() === username)) return { ok:false, error:'มีชื่อผู้ใช้นี้แล้ว รวมถึงบัญชีที่ปิดใช้งาน กรุณาเลือกชื่ออื่นหรือเปลี่ยนชื่อบัญชีเดิม' };
    if (!['admin','tapper','viewer'].includes(body.role)) return { ok:false, error:'role ไม่ถูกต้อง' };
    const created = newUser_(username, body.displayName, body.role, body.password);
    append_('Users', created);
    appendAudit_(user, 'สร้างบัญชี', 'ผู้ใช้งาน', username + ' (' + roleLabel_(created.role) + ')');
    return { ok:true, user:publicUser_(created) };
  } finally { lock.releaseLock(); }
}

function renameUser_(body) {
  const { user } = verifySession_(body.token);
  requireAdmin_(user);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const target = readById_('Users', String(body.userId || ''));
    if (!target) return { ok:false, error:'ไม่พบบัญชีนี้' };
    if (target.id === user.id) return { ok:false, error:'กรุณาออกจากระบบแล้วให้แอดมินอีกบัญชีเปลี่ยนชื่อบัญชีนี้' };
    const username = String(body.username || '').trim().toLowerCase();
    if (username.length < 3 || !/^[a-z0-9._-]+$/.test(username)) return { ok:false, error:'ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัว และใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง' };
    if (rows_('Users').some((row) => row.id !== target.id && String(row.username || '').trim().toLowerCase() === username)) return { ok:false, error:'มีชื่อผู้ใช้นี้แล้ว รวมถึงบัญชีที่ปิดใช้งาน' };
    const previous = target.username;
    target.username = username;
    target.updatedAt = new Date().toISOString();
    upsert_('Users', target);
    appendAudit_(user, 'เปลี่ยนชื่อผู้ใช้', 'ผู้ใช้งาน', previous + ' → ' + username);
    return { ok:true, user:publicUser_(target) };
  } finally { lock.releaseLock(); }
}

function setUserActive_(body) {
  const { user } = verifySession_(body.token);
  requireAdmin_(user);
  const target = readById_('Users', String(body.userId || ''));
  if (!target) return { ok:false, error:'ไม่พบบัญชีนี้' };
  if (target.id === user.id) return { ok:false, error:'ไม่สามารถปิดบัญชีที่กำลังใช้งานได้' };
  if (body.active && rows_('Users').some((row) => row.id !== target.id && row.active !== false && String(row.username || '').trim().toLowerCase() === String(target.username || '').trim().toLowerCase())) return { ok:false, error:'เปิดบัญชีไม่ได้ เพราะมีบัญชีที่ใช้ชื่อผู้ใช้นี้อยู่แล้ว กรุณาเปลี่ยนชื่อบัญชีที่ซ้ำก่อน' };
  if (target.role === 'admin' && target.active !== false && !body.active && !rows_('Users').some((row) => row.role === 'admin' && row.active !== false && row.id !== target.id)) return { ok:false, error:'ต้องมีแอดมินที่ใช้งานได้อย่างน้อยหนึ่งบัญชี' };
  target.active = Boolean(body.active);
  target.updatedAt = new Date().toISOString();
  upsert_('Users', target);
  if (!target.active) revokeUserSessions_(target.id);
  appendAudit_(user, target.active ? 'เปิดบัญชี' : 'ปิดบัญชี', 'ผู้ใช้งาน', target.username);
  return { ok:true };
}

function deleteUser_(body) {
  const { user } = verifySession_(body.token);
  requireAdmin_(user);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const target = readById_('Users', String(body.userId || ''));
    if (!target) return { ok:false, error:'ไม่พบบัญชีนี้ อาจถูกลบไปแล้ว' };
    if (target.id === user.id) return { ok:false, error:'ไม่สามารถลบบัญชีที่กำลังใช้งานได้' };
    if (target.role === 'admin' && !rows_('Users').some((row) => row.id !== target.id && row.role === 'admin' && row.active !== false)) return { ok:false, error:'ต้องเหลือบัญชีแอดมินที่ใช้งานได้อย่างน้อยหนึ่งบัญชี' };
    revokeUserSessions_(target.id);
    if (!deleteById_('Users', target.id)) return { ok:false, error:'ลบบัญชีไม่สำเร็จ กรุณาลองใหม่' };
    appendAudit_(user, 'ลบบัญชี', 'ผู้ใช้งาน', target.username + ' (' + roleLabel_(target.role) + ')');
    return { ok:true, userId:target.id };
  } finally { lock.releaseLock(); }
}

function changePassword_(body) {
  const { user } = verifySession_(body.token);
  const current = readById_('Users', user.id);
  if (!verifyPassword_(String(body.currentPassword || ''), current.passwordSalt, current.passwordHash)) return { ok:false, error:'รหัสผ่านปัจจุบันไม่ถูกต้อง' };
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8) return { ok:false, error:'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' };
  current.passwordSalt = Utilities.getUuid().replace(/-/g, '');
  current.passwordHash = passwordHash_(newPassword, current.passwordSalt);
  current.updatedAt = new Date().toISOString();
  upsert_('Users', current);
  appendAudit_(user, 'เปลี่ยนรหัสผ่าน', 'ผู้ใช้งาน', user.username);
  return { ok:true };
}

function logout_(body) {
  if (!body.token) return { ok:true };
  const hash = sha256_(String(body.token));
  const session = readById_('Sessions', hash);
  if (session) { session.revoked = true; session.revokedAt = new Date().toISOString(); upsert_('Sessions', session); }
  return { ok:true };
}

function receipt_(body) {
  const { user } = verifySession_(body.token);
  const fileId = String(body.fileId || '');
  if (!fileId) return { ok:false, error:'ไม่พบไฟล์ใบเสร็จ' };
  const referenced = ['Sales','Expenses'].some((sheetName) => rows_(sheetName).some((record) => !record.deleted && record.receiptId === fileId));
  if (!referenced) return { ok:false, error:'ไม่มีสิทธิ์เข้าถึงไฟล์นี้' };
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  return { ok:true, name:file.getName(), dataUrl:'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()), requestedBy:user.id };
}

function saveReceipt_(draft) {
  if (!draft || !draft.dataUrl || !draft.name) throw new Error('ข้อมูลไฟล์ไม่ครบ');
  const parts = String(draft.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!parts) throw new Error('ไฟล์ไม่ใช่รูปแบบที่รองรับ');
  const bytes = Utilities.base64Decode(parts[2]);
  if (bytes.length > 5 * 1024 * 1024) throw new Error('ไฟล์แนบต้องมีขนาดไม่เกิน 5 MB');
  const folderId = PropertiesService.getScriptProperties().getProperty('RECEIPT_FOLDER_ID');
  if (!folderId) throw new Error('ยังไม่ได้ตั้งค่าโฟลเดอร์ใบเสร็จ');
  const cleanName = String(draft.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, parts[1], cleanName));
  return { id:file.getId(), name:file.getName() };
}

function newUser_(username, displayName, role, password) {
  const name = String(displayName || '').trim();
  const pass = String(password || '');
  if (pass.length < 8) throw new Error('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (!name) throw new Error('กรอกชื่อที่แสดง');
  const salt = Utilities.getUuid().replace(/-/g, '');
  return { id:Utilities.getUuid(), username:String(username||'').trim().toLowerCase(), displayName:name, role, active:true, passwordSalt:salt, passwordHash:passwordHash_(pass,salt), createdAt:new Date().toISOString() };
}

function publicUser_(user) {
  const result = Object.assign({}, user);
  delete result.passwordHash;
  delete result.passwordSalt;
  return result;
}

function passwordHash_(password, salt) {
  const key = Utilities.newBlob(String(password)).getBytes();
  const message = Utilities.newBlob(String(salt) + '\u0000' + String(password)).getBytes();
  let block = message.concat([0,0,0,1]);
  let u = Utilities.computeHmacSha256Signature(block, key);
  const result = u.slice();
  for (let i = 1; i < PASSWORD_ITERATIONS; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < result.length; j++) result[j] = (result[j] ^ u[j]) & 255;
  }
  return Utilities.base64Encode(result);
}

function verifyPassword_(password, salt, expected) {
  if (!salt || !expected) return false;
  return constantTimeEqual_(passwordHash_(password, salt), String(expected));
}

function appendAudit_(user, action, table, summary) {
  append_('AuditLog', { id:Utilities.getUuid(), at:new Date().toISOString(), actorId:user.id, actorName:user.displayName || user.username || 'ผู้ดูแล', action, table, summary:String(summary||'').slice(0,240) });
}

function describe_(record, table) {
  return String(record.name || record.plotName || record.buyer || record.category || record.personName || record.username || record.locationName || LABEL_FOR_(table)).slice(0,180);
}

function LABEL_FOR_(table) {
  return ({ plots:'แปลงสวน', tappings:'รอบกรีด', sales:'การขาย', expenses:'ค่าใช้จ่าย', shares:'ส่วนแบ่ง', settings:'การตั้งค่า', users:'ผู้ใช้งาน' })[table] || 'ข้อมูล';
}

function roleLabel_(role) { return ({ admin:'แอดมิน', tapper:'คนกรีด', viewer:'ผู้ดูข้อมูล' })[role] || role; }

function requireAdmin_(user) { if (user.role !== 'admin') throw new Error('เฉพาะแอดมินเท่านั้นที่ทำรายการนี้ได้'); }

function revokeUserSessions_(userId) {
  rows_('Sessions').filter((row) => row.userId === userId && !row.revoked).forEach((row) => { row.revoked = true; row.revokedAt = new Date().toISOString(); upsert_('Sessions', row); });
}

function rows_(sheetName) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2,1,lastRow-1,2).getValues().map((row) => {
    try { return JSON.parse(row[1]); } catch { return null; }
  }).filter(Boolean);
}

function readById_(sheetName, id) { return rows_(sheetName).find((row) => String(row.id) === String(id)) || null; }

function append_(sheetName, record) {
  sheet_(sheetName).appendRow([String(record.id), JSON.stringify(record)]);
}

function upsert_(sheetName, record) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2,1,lastRow-1,1).getValues().flat();
    const index = ids.findIndex((value) => String(value) === String(record.id));
    if (index >= 0) { sheet.getRange(index + 2,1,1,2).setValues([[String(record.id),JSON.stringify(record)]]); return; }
  }
  append_(sheetName, record);
}

function deleteById_(sheetName, id) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const ids = sheet.getRange(2,1,lastRow-1,1).getValues().flat();
  const index = ids.findIndex((value) => String(value) === String(id));
  if (index < 0) return false;
  sheet.deleteRow(index + 2);
  return true;
}

function sheet_(sheetName) {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('ยังไม่ได้ตั้งค่าฐานข้อมูล กรุณารัน setup()');
  const sheet = SpreadsheetApp.openById(id).getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบแท็บ ' + sheetName + ' กรุณารัน setup()');
  return sheet;
}

function randomSecret_() { return Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,''); }

function sha256_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return digest.map((byte) => (byte & 255).toString(16).padStart(2,'0')).join('');
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function safeError_(error) {
  const text = String(error && error.message ? error.message : error);
  return text.length > 220 ? text.slice(0,220) : text;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
