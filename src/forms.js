import { active } from './lib/calculations.js';
import { dateKey, escapeHtml as e, number } from './lib/format.js';
import { datePickerField, icon } from './views.js';

const label = (title, name, value = '', type = 'text', extra = '') => `<label class="block text-sm font-medium">${title}<input class="field mt-1.5" name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const select = (title, name, options, value = '', extra = '') => `<label class="block text-sm font-medium">${title}<select class="field mt-1.5" name="${name}" ${extra}>${options.map(([v,t])=>`<option value="${e(v)}" ${String(value)===String(v)?'selected':''}>${e(t)}</option>`).join('')}</select></label>`;
const textarea = (title,name,value='') => `<label class="block text-sm font-medium">${title}<textarea class="field mt-1.5 min-h-20" name="${name}">${e(value)}</textarea></label>`;

function plotAllocations(data, source, allocations = [], field = 'kg') {
  const selected = new Map(allocations.map((row)=>[row.plotId,Number(row[field]||row.amount||0)]));
  return `<div class="rounded-2xl bg-paper p-4"><div class="mb-3 text-sm font-semibold">ระบุ${field==='kg'?'น้ำหนักขาย':'ค่าใช้จ่าย'}แยกตามแปลง</div>${source.length?`<div class="space-y-2">${source.map((plot)=>`<label class="grid grid-cols-[1fr_130px] items-center gap-3 rounded-xl bg-white p-3"><span><span class="block text-sm font-medium">${e(plot.name)}</span><span class="text-[11px] text-muted">${number(plot.area,2)} ไร่ · ${number(plot.trees,0)} ต้น</span></span><span class="relative"><input class="field !pr-12 text-right" name="${field}_${e(plot.id)}" type="number" min="0" step="${field==='kg'?'0.1':'0.01'}" value="${selected.get(plot.id)||''}" placeholder="0"><small class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">${field==='kg'?'กก.':'บาท'}</small></span></label>`).join('')}</div>`:`<div class="text-xs text-muted">เพิ่มข้อมูลแปลงก่อนบันทึก</div>`}</div>`;
}

function receiptField(record) {
  return `<label class="block text-sm font-medium">แนบสลิป/ใบเสร็จ (รูปหรือ PDF)<input class="field mt-1.5 !p-2" name="receipt" type="file" accept="image/*,application/pdf"><span class="mt-1 block text-[11px] font-normal text-muted">${record?.receiptName?`ไฟล์ปัจจุบัน: ${e(record.receiptName)} · เลือกไฟล์ใหม่เพื่อแทนที่`: 'ไฟล์จะจัดเก็บใน Google Drive ของบัญชีเจ้าของระบบ'}</span></label>`;
}

export function formModal({ kind, data, user, record = null, setupKey = '' }) {
  const plots=active(data.plots||[]);const isEdit=Boolean(record);let title='';let body='';let table='';
  if(kind==='tapping'){
    title=isEdit?'แก้ไขบันทึกรอบกรีด':'บันทึกรอบกรีด';table='tappings';
    const people=active(data.users||[]).filter((u)=>u.role==='tapper');
    const tapperOptions=[[user.displayName||user.username,user.displayName||user.username],...people.filter((u)=>u.id!==user.id).map((u)=>[u.displayName,u.displayName])];
    const acidStatuses=[['pending','รอหยอดกรด'],['applied','หยอดแล้ว'],['skipped','ไม่ได้หยอด']];
    const statusOptions=isEdit&&!record?.acidStatus?[['','เลือกสถานะหยอดกรด'],...acidStatuses]:acidStatuses;
    body=`<div class="grid gap-4 sm:grid-cols-2">${select('แปลง','plotId',plots.map((p)=>[p.id,p.name]),record?.plotId||plots[0]?.id)}${datePickerField('วันที่','date',record?.date||dateKey())}${user.role==='admin'?select('คนกรีด','tapperName',tapperOptions,record?.tapperName||user.displayName||user.username):label('คนกรีด','tapperName',user.displayName||user.username,'text','readonly')}${label('จำนวนรอบ','rounds',record?.rounds||1,'number','min="1" step="1" required')}${select('สถานะหยอดกรด','acidStatus',statusOptions,record?.acidStatus||(isEdit?'':'pending'),'required')}</div>${textarea('หมายเหตุ (ถ้ามี)','note',record?.note||'')}`;
  } else if(kind==='plot'){
    title=isEdit?'แก้ไขข้อมูลแปลง':'เพิ่มแปลงสวน';table='plots';
    body=`<div class="grid gap-4 sm:grid-cols-2">${label('ชื่อแปลง','name',record?.name||'','text','required')}${label('ชื่อเจ้าของสวน','ownerName',record?.ownerName||'','text','required')}${label('พื้นที่ (ไร่)','area',record?.area||'','number','min="0" step="0.01" required')}${label('จำนวนต้น','trees',record?.trees||'','number','min="0" step="1" required')}${label('ละติจูด','latitude',record?.latitude||'','number','step="any" placeholder="ใช้ระบุตำแหน่งอากาศได้"')}${label('ลองจิจูด','longitude',record?.longitude||'','number','step="any"')}</div><div class="mt-3 flex justify-end"><button class="btn btn-soft" type="button" data-action="form-geolocate">ใช้ตำแหน่งปัจจุบัน</button></div>`;
  } else if(kind==='sale'){
    title=isEdit?'แก้ไขรายการขาย':'บันทึกการขายยาง';table='sales';
    body=`<div class="grid gap-4 sm:grid-cols-2">${datePickerField('วันที่ขาย','date',record?.date||dateKey())}${label('ผู้ซื้อ','buyer',record?.buyer||'','text','required')}${label('ประเภทยาง','grade',record?.grade||'น้ำยางสด','text','required')}${label('ราคา/กก. (บาท)','priceKg',record?.priceKg||'','number','min="0" step="0.01" required')}${label('รายการหักจากผู้ซื้อ (บาท)','deductions',record?.deductions||0,'number','min="0" step="0.01"')}${label('รหัส/หมายเหตุ','note',record?.note||'')}</div><div class="mt-4">${plotAllocations(data,plots,record?.allocations||[],'kg')}</div><div class="mt-4">${receiptField(record)}</div>`;
  } else if(kind==='expense'){
    title=isEdit?'แก้ไขค่าใช้จ่าย':'เพิ่มค่าใช้จ่าย';table='expenses';
    const defaults=['น้ำ','กรดยาง','ภาชนะ/น้ำยาง','มีดกรีดยาง','ลวด','ยากันยุง','ค่าขนส่ง','อื่น ๆ'];
    const products=[...new Set([...defaults,...(data.settings?.expenseCategories||[]),...(data.expenses||[]).map((row)=>row.category).filter(Boolean)])];
    body=`<div class="grid gap-4 sm:grid-cols-2">${datePickerField('วันที่','date',record?.date||dateKey())}<label class="block text-sm font-medium">สินค้า / อุปกรณ์<input class="field mt-1.5" name="category" list="expense-product-options" value="${e(record?.category||'')}" placeholder="เลือกเดิมหรือพิมพ์รายการใหม่" required><datalist id="expense-product-options">${products.map((item)=>`<option value="${e(item)}"></option>`).join('')}</datalist><span class="mt-1 block text-[11px] font-normal text-muted">พิมพ์ชื่อสินค้าใหม่ได้ รายการที่บันทึกจะเป็นคำแนะนำครั้งถัดไป</span></label>${label('รายละเอียด / จำนวน','description',record?.description||'','text','placeholder="เช่น กรดยาง 2 แกลลอน"')}${label('ร้านค้า / ผู้รับเงิน','vendor',record?.vendor||'')}</div><div class="mt-4">${plotAllocations(data,plots,record?.allocations||[],'amount')}</div><div class="mt-4">${receiptField(record)}</div>`;
  } else if(kind==='share'){
    title=isEdit?'แก้ไขส่วนแบ่ง':'กำหนดส่วนแบ่ง';table='shares';
    const roles=[['owner','เจ้าของสวน'],['tapper','คนกรีด']];
    body=`<div class="grid gap-4 sm:grid-cols-2">${select('แปลง','plotId',plots.map((p)=>[p.id,p.name]),record?.plotId||plots[0]?.id)}${select('ประเภทผู้รับ','role',roles,record?.role||'tapper')}${label('ชื่อผู้รับ','personName',record?.personName||'','text','required')}${label('เปอร์เซ็นต์ (%)','percent',record?.percent??0,'number','min="0" max="100" step="0.01" required')}</div><p class="mt-3 rounded-xl bg-[#fff6e7] p-3 text-xs leading-5 text-[#8f6127]">กำหนดเปอร์เซ็นต์ของผู้รับทุกคนในแปลงเดียวกันให้รวม 100% ส่วนแบ่งจะคำนวณจากยอดสุทธิหลังหักรายการซื้อและค่าใช้จ่ายที่จัดสรรให้แปลงนั้น</p>`;
  } else if(kind==='user'){
    title='เพิ่มบัญชีผู้ใช้';table='users';
    body=`<div class="grid gap-4 sm:grid-cols-2">${label('ชื่อผู้ใช้','username','','text','required minlength="3" autocomplete="off"')}${label('ชื่อที่แสดง','displayName','','text','required')}${select('สิทธิ์การใช้งาน','role',[['tapper','คนกรีด'],['viewer','ผู้ดูข้อมูล'],['admin','แอดมิน']], 'tapper')}${label('รหัสผ่านเริ่มต้น','password','','password','required minlength="8" autocomplete="new-password"')}</div><p class="mt-3 text-xs text-muted">ผู้ใช้จะเปลี่ยนรหัสผ่านได้หลังเข้าสู่ระบบ</p>`;
  } else if(kind==='rename-user'){
    title='แก้ไขชื่อผู้ใช้';table='users';
    body=`<div class="rounded-xl bg-[#fff7e9] p-3 text-sm text-[#765c36]">เปลี่ยนชื่อบัญชีที่ซ้ำได้โดยไม่ลบบันทึกเดิม</div>${label('ชื่อผู้ใช้ใหม่','username',record?.username||'','text','required minlength="3" autocomplete="off"')}`;
  } else if(kind==='change-password'){
    title='เปลี่ยนรหัสผ่าน';table='password';
    body=`<div class="space-y-4">${label('รหัสผ่านปัจจุบัน','currentPassword','','password','required autocomplete="current-password"')}${label('รหัสผ่านใหม่','newPassword','','password','required minlength="8" autocomplete="new-password"')}${label('ยืนยันรหัสผ่านใหม่','confirmPassword','','password','required minlength="8" autocomplete="new-password"')}</div>`;
  }
  const formAction=kind==='user'?'user':kind==='rename-user'?'rename-user':kind==='change-password'?'change-password':'record';
  return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-panel card p-5 sm:p-6"><div class="mb-5 flex items-start justify-between gap-4"><div><h2 class="text-xl font-bold">${title}</h2><p class="mt-1 text-xs text-muted">${kind==='user'?'สร้างบัญชีใหม่สำหรับผู้ใช้':kind==='rename-user'?'ตรวจสอบชื่อผู้ใช้ก่อนบันทึก':isEdit?'แก้ไขข้อมูลแล้วบันทึกเพื่ออัปเดตระบบ':'ข้อมูลจะถูกเก็บในเครื่องก่อน และซิงก์เมื่อเชื่อมต่อได้'}</p></div><button class="btn btn-plain !p-2" type="button" data-action="close">×</button></div><form data-form="${formAction}" data-kind="${kind}" data-table="${table}" data-id="${e(record?.id||'')}"><div class="space-y-4">${body}</div><div class="mt-6 flex justify-end gap-2 border-t border-[#e8eef5] pt-4"><button class="btn btn-plain" type="button" data-action="close">ยกเลิก</button><button class="btn btn-primary" type="submit">บันทึก</button></div></form></section></div>`;
}

export function receiptModal({ name, dataUrl }) {
  const display=dataUrl?.startsWith('data:application/pdf')?`<iframe class="h-[70vh] w-full rounded-xl" src="${dataUrl}"></iframe>`:`<img class="max-h-[75vh] max-w-full rounded-xl object-contain" src="${dataUrl}" alt="${e(name||'ใบเสร็จ')}">`;
  return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-panel card p-4"><div class="mb-3 flex items-center justify-between"><div class="font-semibold">${e(name||'ใบเสร็จ')}</div><button class="btn btn-plain !p-2" data-action="close">×</button></div>${display}</section></div>`;
}

export function confirmDeleteModal({ item, detail, title='ยืนยันการลบรายการนี้?', note='รายการนี้จะไม่แสดงในสรุปและรายงานอีก', confirmText='ลบรายการ' }) {
  return `<div class="modal-backdrop" data-action="backdrop"><section class="modal-panel card confirm-delete-panel p-5 sm:p-6" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><div class="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#eaf3fc] text-[#517ca3]">${icon('trash',21)}</div><div class="mt-4 text-center"><h2 id="delete-title" class="text-lg font-bold">${e(title)}</h2><p class="mt-2 text-sm leading-6 text-muted">${e(item)}${detail?` · ${e(detail)}`:''}</p><p class="mt-2 text-xs text-muted">${e(note)}</p></div><div class="mt-6 flex justify-center gap-2 border-t border-[#e8eef5] pt-4"><button class="btn btn-soft" type="button" data-action="close">กลับไปตรวจสอบ</button><button class="btn btn-delete-confirm" type="button" data-action="confirm-delete">${e(confirmText)}</button></div></section></div>`;
}

export function mobileMenu(data,user,currentPage) {
  const sections=[
    {title:'สวนยาง',items:[['dashboard','ภาพรวมสวน','home'],['tapping','บันทึกรอบกรีด','tap'],['plots','แปลงสวน','plot'],['sales','การขายยาง','sale'],['expenses','ค่าใช้จ่าย','expense']]},
    {title:'ติดตามและสรุป',items:[['shares','ส่วนแบ่งผลผลิต','share'],['weather','สภาพอากาศ','weather'],['reports','รายงาน','report']]},
    ...(user.role==='admin'?[{title:'จัดการระบบ',items:[['users','ผู้ใช้งาน','users'],['audit','ประวัติการใช้งาน','audit'],['settings','ตั้งค่าระบบ','settings']]}]:[]),
  ];
  return `<div class="modal-backdrop mobile-menu-backdrop" data-action="backdrop"><section class="mobile-menu-panel card" role="dialog" aria-modal="true" aria-labelledby="mobile-menu-title"><div class="mobile-menu-handle"></div><header class="flex items-center justify-between border-b border-[#e8eef5] px-5 pb-4 pt-2"><div><div class="text-[11px] font-semibold uppercase tracking-[.16em] text-muted">Jodyang · Rubber farm</div><h2 id="mobile-menu-title" class="mt-1 text-lg font-bold">เมนูสวน</h2></div><button class="btn btn-plain !h-10 !min-h-10 !w-10 !p-0" data-action="close" aria-label="ปิดเมนู">${icon('close',19)}</button></header><div class="space-y-5 px-4 py-4">${sections.map((section)=>`<section><h3 class="px-2 pb-2 text-[11px] font-bold uppercase tracking-[.12em] text-muted">${section.title}</h3><div class="space-y-1">${section.items.map(([page,title,iconName])=>`<button class="mobile-menu-link ${currentPage===page?'is-current':''}" data-action="go" data-page="${page}"><span class="mobile-menu-icon">${icon(iconName,18)}</span><span class="min-w-0 flex-1 text-left">${title}</span>${currentPage===page?'<span class="mobile-menu-current">กำลังดู</span>':`<span class="mobile-menu-arrow">${icon('chevron',15)}</span>`}</button>`).join('')}</div></section>`).join('')}</div></section></div>`;
}
