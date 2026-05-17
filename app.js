// ════════════════════════════════════════════════════════════════════
// 🔥 FIREBASE CONFIG — استبدل القيم ببياناتك من Firebase Console
// ════════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
// ════════════════════════════════════════════════════════════════════

let db, firebaseReady = false;
const FB_CONFIGURED = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY';

if(FB_CONFIGURED) {
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    firebaseReady = true;
  } catch(e) { console.error('Firebase init failed:', e); }
}

if(window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ════════════════════════════════════════════════════════════════════
// USERS / ROLES
// ════════════════════════════════════════════════════════════════════
const DEFAULT_USERS = [
  { id:'admin', username:'admin', password:'admin123', role:'admin', displayName:'الأدمن الرئيسي', empId:null },
  { id:'hr', username:'hr', password:'hr123', role:'hr', displayName:'مسؤول HR', empId:null },
  { id:'employee', username:'employee', password:'emp123', role:'employee', displayName:'موظف', empId:null },
];
const ROLE_LABELS = { admin:'الأدمن الرئيسي', hr:'مسؤول HR', employee:'موظف' };
const ROLE_COLORS = { admin:'#1f8f9a', hr:'#1ec76a', employee:'#f0a020' };

let USERS = [];
let currentUser = null;

const LSK = 'rmg_hr_v5';
let LS = { users:[], employees:[], attendance:[], departments:[] };

function loadLS() {
  try { const r = localStorage.getItem(LSK); if(r) LS = JSON.parse(r); } catch(e) {}
  if(!LS.users || !LS.users.length) LS.users = JSON.parse(JSON.stringify(DEFAULT_USERS));
  if(!LS.departments || !LS.departments.length) LS.departments = defDepts();
  if(!LS.employees) LS.employees = [];
  if(!LS.attendance) LS.attendance = [];
  USERS = LS.users;
}
function saveLS() { try { localStorage.setItem(LSK, JSON.stringify(LS)); } catch(e) {} }

// ════════════════════════════════════════════════════════════════════
// FIRESTORE DATA LAYER (real-time sync)
// ════════════════════════════════════════════════════════════════════
let unsubscribers = [];

async function setDoc(coll, id, data) {
  const safeId = String(id);
  const payload = {...data, id: safeId};
  if(firebaseReady) {
    try { await db.collection(coll).doc(safeId).set(payload); return; }
    catch(e) { console.error(`setDoc ${coll}/${safeId}:`, e); showSyncErr(); }
  }
  const arr = LS[coll] || [];
  const idx = arr.findIndex(x => x.id === safeId);
  if(idx >= 0) arr[idx] = payload; else arr.push(payload);
  LS[coll] = arr; saveLS();
}

async function delDoc(coll, id) {
  const safeId = String(id);
  if(firebaseReady) {
    try { await db.collection(coll).doc(safeId).delete(); return; }
    catch(e) { console.error(`delDoc:`, e); showSyncErr(); }
  }
  LS[coll] = (LS[coll] || []).filter(x => x.id !== safeId);
  saveLS();
}

async function setManyDocs(coll, items) {
  if(!items.length) return;
  if(firebaseReady) {
    const chunks = [];
    for(let i = 0; i < items.length; i += 450) chunks.push(items.slice(i, i + 450));
    for(const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(item => {
        const id = String(item.id || uid());
        batch.set(db.collection(coll).doc(id), {...item, id});
      });
      try { await batch.commit(); }
      catch(e) { console.error('batch:', e); showSyncErr(); }
    }
    return;
  }
  items.forEach(item => {
    const id = item.id || uid();
    const arr = LS[coll] || [];
    const idx = arr.findIndex(x => x.id === id);
    if(idx >= 0) arr[idx] = {...item, id}; else arr.push({...item, id});
    LS[coll] = arr;
  });
  saveLS();
}

function setupRealtimeSync() {
  if(!firebaseReady) return;
  stopRealtimeSync();
  ['users', 'employees', 'attendance', 'departments'].forEach(coll => {
    const unsub = db.collection(coll).onSnapshot(snap => {
      LS[coll] = snap.docs.map(d => ({...d.data(), id: d.id}));
      saveLS();
      if(coll === 'users') USERS = LS.users;
      reRenderCurrent();
      setSyncStatus(true);
    }, err => { console.error(`Sync ${coll}:`, err); setSyncStatus(false); });
    unsubscribers.push(unsub);
  });
}

function stopRealtimeSync() {
  unsubscribers.forEach(u => { try { u(); } catch(e) {} });
  unsubscribers = [];
}

function reRenderCurrent() {
  const active = document.querySelector('.page.active');
  if(!active) return;
  const id = active.id.replace('page-', '');
  const r = {dashboard:renderDashboard, birthdays:renderBirthdays, daily:buildBulk, records:renderRecords, monthly:renderMonthly, halfyear:renderHalfYear, annual:renderAnnual, employees:renderEmployees, departments:renderDepts, users:renderUsers, myprofile:renderMyProfile, myattendance:renderMyAttendance};
  if(r[id]) try { r[id](); } catch(e) { console.error(e); }
}

function setSyncStatus(ok) {
  const el = document.getElementById('rb-sync');
  const t = document.getElementById('rb-sync-t');
  if(!el) return;
  if(!firebaseReady) { el.classList.add('off'); t.textContent = 'محلي فقط'; return; }
  el.classList.toggle('off', !ok);
  t.textContent = ok ? 'متزامن' : 'انقطع الاتصال';
}
function showSyncErr() { setSyncStatus(false); }

async function migrateToFirestore() {
  if(!firebaseReady) return;
  if(localStorage.getItem('rmg_migrated_v5')) return;
  try {
    const snap = await db.collection('employees').limit(1).get();
    if(!snap.empty) { localStorage.setItem('rmg_migrated_v5', '1'); return; }
    console.log('Migrating to Firestore...');
    await setManyDocs('departments', LS.departments || []);
    await setManyDocs('users', LS.users || []);
    await setManyDocs('employees', LS.employees || []);
    await setManyDocs('attendance', LS.attendance || []);
    localStorage.setItem('rmg_migrated_v5', '1');
  } catch(e) { console.warn('Migration:', e); }
}

// ════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════
const COLORS=['#1f8f9a','#0b3a5f','#9b79fa','#1ec76a','#f0a020','#f03a5a','#22d3ee','#f472b6','#34d399','#fb923c'];
const SCLR={نشط:'xg',موقوف:'xa',استقال:'xr',منتهية_خدمته:'xr',إجازة_طويلة:'xp'};
const SLBL={نشط:'نشط',موقوف:'موقوف',استقال:'استقال',منتهية_خدمته:'منتهية الخدمة',إجازة_طويلة:'إجازة طويلة'};
const ACLR={حاضر:'xg','غائب باذن':'xp','غائب بدون اذن':'xr','إجازة سنوية':'xb','إجازة مرضية':'xa','إجازة أمومة':'xk','إجازة أبوة':'xk'};
const MN=['','يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function defDepts(){return[
  {id:'d1',name:'الإدارة العليا',jobs:['رئيس مجلس الإدارة','المدير العام','مدير المكتب','مستشار']},
  {id:'d2',name:'الإنتاج الإعلامي',jobs:['مدير الإنتاج','منتج','مساعد منتج','المخرج','مساعد مخرج','مدير إبداعي','كاتب محتوى','مصور فيديو','فني إضاءة','مونتير','موشن جرافيك','مهندس صوت','مصمم جرافيك','مصور']},
  {id:'d3',name:'الشؤون الإدارية والمالية',jobs:['مدير الشؤون الإدارية والمالية','موظف شؤون إدارية','سكرتير تنفيذي','مسؤول أرشفة']},
  {id:'d4',name:'الموارد البشرية',jobs:['مدير الموارد البشرية','مسؤول المتابعة والتقييم','أخصائي موارد بشرية']},
  {id:'d5',name:'التسويق والإعلام الرقمي',jobs:['مدير تسويق','أخصائي تسويق رقمي','مدير سوشيال ميديا']},
  {id:'d6',name:'العلاقات العامة',jobs:['مدير علاقات عامة','أخصائي علاقات عامة','منسق لوجستي','مسؤول الحركة والنقل']},
  {id:'d7',name:'تقنية المعلومات',jobs:['مسؤول تقنية المعلومات','مسؤول شبكات','دعم فني','مختص أمن سيبراني','مطور مواقع']},
];}

const CAN = {
  admin:    ['dashboard','birthdays','daily','records','monthly','halfyear','annual','employees','departments','users','addEmp','editEmp','deleteEmp','addDept','editDept','deleteDept','addAtt','deleteAtt','changeUserPw','exportCSV','import'],
  hr:       ['dashboard','birthdays','daily','records','monthly','halfyear','annual','employees','departments','addEmp','editEmp','addAtt','exportCSV','import'],
  employee: ['myprofile','myattendance'],
};
function can(action) { return currentUser && CAN[currentUser.role]?.includes(action); }

// ════════════════════════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════════════════════════
let loginAttempts = 0, lockUntil = 0;

function togglePw(){const i=document.getElementById('l-pw');const s=document.getElementById('eye-svg');if(i.type==='password'){i.type='text';s.innerHTML='<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';}else{i.type='password';s.innerHTML='<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';}}

async function doLogin() {
  if(Date.now() < lockUntil) return;
  const username = document.getElementById('l-user').value.trim().toLowerCase();
  const password = document.getElementById('l-pw').value;
  const err = document.getElementById('l-err');
  const user = USERS.find(u => u.username === username && u.password === password);
  if(user) {
    loginAttempts = 0;
    currentUser = user;
    sessionStorage.setItem('rmg_session', JSON.stringify({username:user.username}));
    document.getElementById('login-screen').classList.remove('show');
    document.getElementById('app').classList.add('on');
    document.getElementById('role-bar').classList.add('show');
    setupRoleBar(); setupNav(); setupSidebar();
    setSyncStatus(firebaseReady);
    if(firebaseReady) { await migrateToFirestore(); setupRealtimeSync(); }
    nav(CAN[user.role][0]);
  } else {
    loginAttempts++;
    const rem = 5 - loginAttempts;
    err.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة';
    if(rem <= 2 && rem > 0) err.textContent += ` (${rem} محاولات متبقية)`;
    if(loginAttempts >= 5) {
      lockUntil = Date.now() + 30000;
      const btn = document.getElementById('l-btn'); btn.disabled=true; btn.textContent='محظور 30 ثانية';
      setTimeout(()=>{lockUntil=0;loginAttempts=0;btn.disabled=false;btn.textContent='دخول إلى النظام';err.textContent='';},30000);
    }
    document.getElementById('l-pw').value='';
  }
}

function doLogout() {
  stopRealtimeSync();
  currentUser = null;
  sessionStorage.removeItem('rmg_session');
  document.getElementById('app').classList.remove('on');
  document.getElementById('role-bar').classList.remove('show');
  document.getElementById('login-screen').classList.add('show');
  document.getElementById('l-user').value=''; document.getElementById('l-pw').value=''; document.getElementById('l-err').textContent='';
}

function setupRoleBar() {
  document.getElementById('rb-dot').style.background = ROLE_COLORS[currentUser.role];
  document.getElementById('rb-role-name').textContent = ROLE_LABELS[currentUser.role];
  document.getElementById('rb-username').textContent = currentUser.displayName;
}

function setupSidebar() {
  const av = document.getElementById('sb-av');
  const c = ROLE_COLORS[currentUser.role];
  av.style.background = c+'22'; av.style.color = c;
  av.textContent = currentUser.displayName.split(' ').map(p=>p[0]).slice(0,2).join('');
  document.getElementById('sb-name').textContent = currentUser.displayName;
  document.getElementById('sb-role').textContent = ROLE_LABELS[currentUser.role];
}

function setupNav() {
  const role = currentUser.role;
  const navArea = document.getElementById('nav-area');
  let h = '';
  if(role === 'admin' || role === 'hr') {
    h += `<div class="nav-sec">الرئيسية</div>
    <button class="nb" onclick="nav('dashboard')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>لوحة التحكم</button>
    <button class="nb" onclick="nav('birthdays')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>أعياد الميلاد<span class="nb-bdg" id="bd-nav-cnt">0</span></button>
    <div class="nav-sec">الحضور</div>
    <button class="nb" onclick="nav('daily')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>الإدخال اليومي</button>
    <button class="nb" onclick="nav('records')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>سجل الحضور</button>
    <div class="nav-sec">التقارير</div>
    <button class="nb" onclick="nav('monthly')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-6"/></svg>شهري</button>
    <button class="nb" onclick="nav('halfyear')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>نصف سنوي</button>
    <button class="nb" onclick="nav('annual')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>سنوي</button>
    <div class="nav-sec">الإدارة</div>
    <button class="nb" onclick="nav('employees')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>الموظفون</button>
    <button class="nb" onclick="nav('departments')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>الأقسام</button>`;
    if(role === 'admin') {
      h += `<button class="nb" onclick="nav('users')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>المستخدمون</button>`;
    }
  } else {
    h += `<div class="nav-sec">بياناتي</div>
    <button class="nb" onclick="nav('myprofile')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>بياناتي</button>
    <button class="nb" onclick="nav('myattendance')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>سجل حضوري</button>`;
  }
  navArea.innerHTML = h;
}

function nav(p) {
  if(!CAN[currentUser.role].includes(p)) { toast('ليس لديك صلاحية','var(--red)'); return; }
  document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  document.getElementById('page-'+p)?.classList.add('active');
  document.querySelectorAll('.nb').forEach(b=>{if(b.getAttribute('onclick')?.includes("'"+p+"'"))b.classList.add('on');});
  const r={dashboard:renderDashboard,birthdays:renderBirthdays,daily:renderDaily,records:renderRecords,monthly:renderMonthly,halfyear:renderHalfYear,annual:renderAnnual,employees:renderEmployees,departments:renderDepts,users:renderUsers,myprofile:renderMyProfile,myattendance:renderMyAttendance};
  if(r[p]) r[p]();
}

// ════════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════════
function uid(){return'x'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4)}
function todayStr(){return new Date().toISOString().slice(0,10)}
function fmtDate(d){if(!d)return'—';try{return new Date(d).toLocaleDateString('ar-LY',{year:'numeric',month:'short',day:'numeric'});}catch(e){return d;}}
function tDiff(t1,t2){if(!t1||!t2)return 0;const[h1,m1]=t1.split(':').map(Number),[h2,m2]=t2.split(':').map(Number);const d=(h2*60+m2)-(h1*60+m1);return d>0?d/60:0}
function lMin(tin){if(!tin)return 0;const[h1,m1]='09:00'.split(':').map(Number),[h2,m2]=tin.split(':').map(Number);const d=(h2*60+m2)-(h1*60+m1);return d>0?d:0}
function otH(tin,tout,req){const h=tDiff(tin,tout);return h>req?+(h-req).toFixed(2):0}
function getDept(id){return(LS.departments||[]).find(d=>d.id===id)||{name:'—',jobs:[]}}
function dN(id){return getDept(id).name}
function getEmp(id){return(LS.employees||[]).find(e=>String(e.id)===String(id))}
function reqH(emp){return Math.round(emp.days*4.33*emp.hours)}
function calcStats(emp,month,yr){
  const recs=(LS.attendance||[]).filter(a=>{if(String(a.empId)!==String(emp.id))return false;const d=new Date(a.date);return d.getMonth()+1===month&&d.getFullYear()===yr});
  const pr=recs.filter(r=>r.status==='حاضر');
  let hrs=0,ot=0,late=0;pr.forEach(r=>{hrs+=tDiff(r.timeIn,r.timeOut);ot+=otH(r.timeIn,r.timeOut,emp.hours);late+=lMin(r.timeIn);});
  const req=reqH(emp);const pct=req>0?+(hrs/req*100).toFixed(1):0;
  const absA=recs.filter(r=>r.status!=='حاضر'&&r.status!=='غائب بدون اذن').length;
  const absU=recs.filter(r=>r.status==='غائب بدون اذن').length;
  let rating='جيد';if(pct>=90)rating='ممتاز ⭐';else if(pct>=70)rating='جيد جداً';else if(pct>=50)rating='جيد';else rating='يحتاج متابعة ⚠️';
  return{present:pr.length,hours:+hrs.toFixed(2),ot:+ot.toFixed(2),late:Math.round(late),absA,absU,req,pct,rating};
}
function av(name,i){const ini=(name||'?').split(' ').map(p=>p[0]).slice(0,2).join('');const c=COLORS[i%COLORS.length];return`<div class="av" style="background:${c}22;color:${c}">${ini}</div>`;}
function sBadge(e){const s=e.status||'نشط';return`<span class="bx ${SCLR[s]||'xn'}">${SLBL[s]||s}</span>`}
function aBadge(s){return`<span class="bx ${ACLR[s]||'xn'}">${s}</span>`}
function rBadge(r){if(r.includes('ممتاز'))return`<span class="bx xg">${r}</span>`;if(r.includes('جيد جداً'))return`<span class="bx xb">${r}</span>`;if(r.includes('متابعة'))return`<span class="bx xr">${r}</span>`;return`<span class="bx xa">${r}</span>`}
function pBar(pct,c='var(--brand-teal)'){return`<div class="pfr"><div class="pb"><div class="pf" style="width:${Math.min(pct,100)}%;background:${c}"></div></div><span class="pfl">${pct}%</span></div>`}

function bdLeft(dob){if(!dob)return null;const t=new Date(),d=new Date(dob);const ny=new Date(t.getFullYear(),d.getMonth(),d.getDate());if(ny<t)ny.setFullYear(t.getFullYear()+1);return Math.floor((ny-t)/(864e5));}
function isToday(dob){if(!dob)return false;const t=new Date(),d=new Date(dob);return t.getMonth()===d.getMonth()&&t.getDate()===d.getDate();}
function fmtBd(dob){if(!dob)return'—';const d=new Date(dob);return`${d.getDate()} ${MN[d.getMonth()+1]}`;}
function calcAge(dob){if(!dob)return null;const t=new Date(),d=new Date(dob);let a=t.getFullYear()-d.getFullYear();if(t<new Date(t.getFullYear(),d.getMonth(),d.getDate()))a--;return a;}

let toastT;
function toast(msg,c='var(--grn)'){document.getElementById('toast-msg').textContent=msg;document.getElementById('toast-dot').style.background=c;const e=document.getElementById('toast');e.style.display='flex';clearTimeout(toastT);toastT=setTimeout(()=>e.style.display='none',3200);}
function openOv(id){document.getElementById(id).classList.add('open')}
function closeOv(id){document.getElementById(id).classList.remove('open')}
function confirm2(title,msg,cb){document.getElementById('del-t').textContent=title;document.getElementById('del-msg').textContent=msg;document.getElementById('del-ok').onclick=()=>{closeOv('ov-del');cb();};openOv('ov-del');}

// ════════════════════════════════════════════════════════════════════
// 📥 PDF / EXCEL IMPORT
// ════════════════════════════════════════════════════════════════════
async function extractPDFLines(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: new Uint8Array(buf)}).promise;
  const lines = [];
  for(let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lineMap = new Map();
    tc.items.forEach(item => {
      if(!item.str || !item.str.trim()) return;
      const y = Math.round(item.transform[5]);
      let key = null;
      for(const k of lineMap.keys()) { if(Math.abs(k - y) < 3) { key = k; break; } }
      if(key === null) { key = y; lineMap.set(y, []); }
      lineMap.get(key).push({x: item.transform[4], str: item.str});
    });
    const ys = [...lineMap.keys()].sort((a,b) => b - a);
    for(const y of ys) {
      const items = lineMap.get(y).sort((a,b) => a.x - b.x);
      const text = items.map(i => i.str).join('').replace(/\s+/g, ' ').trim();
      if(text) lines.push(text);
    }
  }
  return lines;
}

// Parses the attendance lines handling both PDF formats in the file
function parseAttendanceLines(lines) {
  const rows = [];
  const dateRe = /(\d{4}-\d{2}-\d{2})/;
  const weekdayRe = /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/;
  for(const line of lines) {
    const dateM = line.match(dateRe);
    const wdayM = line.match(weekdayRe);
    if(!dateM || !wdayM) continue;
    const times = [...line.matchAll(/(\d{2}:\d{2})/g)].map(m => m[0]);
    if(times.length < 3) continue;
    const datePos = line.indexOf(dateM[0]);
    const firstTimePos = line.search(/\d{2}:\d{2}/);
    let firstPunch, lastPunch, totalTime;
    if(firstTimePos < datePos) {
      // Format A (RTL-reversed): TotalTime LastPunch FirstPunch ... Date
      [totalTime, lastPunch, firstPunch] = times;
    } else {
      // Format B (jumbled): ... Date Weekday FirstPunch LastPunch TotalTime
      [firstPunch, lastPunch, totalTime] = times;
    }
    let rest = line
      .replace(dateM[0], ' ').replace(wdayM[0], ' ')
      .replace(/\d{2}:\d{2}/g, ' ')
      .replace(/Department/g, ' ').replace(/\bDep\b/g, ' ').replace(/\bartment\b/g, ' ')
      .replace(/Dep(?=[\u0600-\u06FF])/g, ' ')
      .replace(/(?<=[\u0600-\u06FF])artment/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const idMatch = rest.match(/\d{2,6}/);
    if(!idMatch) continue;
    const empId = idMatch[0];
    const name = rest.replace(empId, ' ').replace(/\s+/g, ' ').trim();
    rows.push({empId, name, date: dateM[0], firstPunch, lastPunch, totalTime, status: 'حاضر'});
  }
  return rows;
}

function normalizeExcelDate(v) {
  if(!v) return '';
  if(typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0,10);
  }
  const s = String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m) {
    let [_, a, b, c] = m;
    if(c.length === 2) c = '20' + c;
    return `${c.padStart(4,'0')}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`;
  }
  const d = new Date(s);
  if(!isNaN(d)) return d.toISOString().slice(0,10);
  return '';
}
function normalizeTime(v) {
  if(!v) return '';
  const s = String(v).trim();
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
}

async function parseExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type: 'array', cellDates: false});
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(sheet, {header: 1, raw: false, defval: ''});
  if(!json.length) return [];
  const headers = (json[0] || []).map(h => String(h || '').toLowerCase().trim());
  const findCol = (...keys) => { for(const k of keys) { const i = headers.findIndex(h => h.includes(k)); if(i >= 0) return i; } return -1; };
  const col = {
    id: findCol('employeeid', 'employee id', 'id', 'رقم'),
    name: findCol('first name', 'name', 'اسم'),
    date: findCol('date', 'تاريخ'),
    firstPunch: findCol('first punch', 'firstpunch', 'in', 'دخول'),
    lastPunch: findCol('last punch', 'lastpunch', 'out', 'خروج'),
    total: findCol('total', 'totaltime', 'إجمالي'),
  };
  const rows = [];
  for(let i = 1; i < json.length; i++) {
    const r = json[i];
    if(!r || !r.length) continue;
    const date = normalizeExcelDate(r[col.date]);
    const empId = String(r[col.id] || '').trim();
    if(!date || !empId) continue;
    rows.push({
      empId, name: String(r[col.name] || '').trim(), date,
      firstPunch: normalizeTime(r[col.firstPunch]),
      lastPunch: normalizeTime(r[col.lastPunch]),
      totalTime: normalizeTime(r[col.total]),
      status: 'حاضر'
    });
  }
  return rows;
}

let importData = null;

function openImport() {
  if(!can('import')) { toast('ليس لديك صلاحية','var(--red)'); return; }
  resetImportModal();
  openOv('ov-import');
}
function closeImport() { closeOv('ov-import'); setTimeout(resetImportModal, 200); }
function resetImportModal() {
  document.getElementById('imp-step1').style.display = 'block';
  document.getElementById('imp-loading').style.display = 'none';
  document.getElementById('imp-step2').style.display = 'none';
  document.getElementById('imp-confirm').style.display = 'none';
  document.getElementById('imp-file').value = '';
  document.getElementById('imp-unmatched-section').style.display = 'none';
  importData = null;
}

async function handleImportFile(ev) {
  const file = ev.target.files[0];
  if(!file) return;
  document.getElementById('imp-step1').style.display = 'none';
  document.getElementById('imp-loading').style.display = 'flex';
  document.getElementById('imp-loading-t').textContent = 'جاري قراءة الملف...';
  try {
    let rows;
    const name = file.name.toLowerCase();
    if(name.endsWith('.pdf')) {
      const lines = await extractPDFLines(file);
      rows = parseAttendanceLines(lines);
    } else if(name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      rows = await parseExcelFile(file);
    } else { throw new Error('نوع الملف غير مدعوم'); }
    if(!rows || !rows.length) {
      toast('لم أعثر على سجلات في الملف','var(--red)');
      resetImportModal();
      return;
    }
    showImportPreview(rows);
  } catch(e) {
    console.error('Import:', e);
    toast('فشل قراءة الملف: ' + (e.message || e), 'var(--red)');
    resetImportModal();
  }
}

function showImportPreview(rows) {
  importData = rows;
  document.getElementById('imp-loading').style.display = 'none';
  document.getElementById('imp-step2').style.display = 'block';
  document.getElementById('imp-confirm').style.display = 'inline-flex';
  const empIds = [...new Set(rows.map(r => r.empId))];
  const matched = empIds.filter(id => getEmp(id));
  const unmatched = empIds.filter(id => !getEmp(id));
  let conflicts = 0;
  rows.forEach(r => { if((LS.attendance || []).find(a => String(a.empId) === String(r.empId) && a.date === r.date)) conflicts++; });
  const dates = rows.map(r => r.date).sort();
  document.getElementById('imp-rows').textContent = rows.length;
  document.getElementById('imp-matched').textContent = matched.length;
  document.getElementById('imp-unmatched').textContent = unmatched.length;
  document.getElementById('imp-conflicts').textContent = conflicts;
  document.getElementById('imp-range').textContent = `${dates[0]} → ${dates[dates.length-1]}`;
  if(unmatched.length) {
    document.getElementById('imp-unmatched-section').style.display = 'block';
    const items = unmatched.slice(0, 30).map(id => {
      const r = rows.find(x => x.empId === id);
      return `<span class="job-chip mono" style="font-size:11px">#${id} ${r?.name ? '— ' + r.name : ''}</span>`;
    }).join('');
    document.getElementById('imp-unmatched-list').innerHTML = items + (unmatched.length > 30 ? `<span class="job-chip">+${unmatched.length - 30}</span>` : '');
  } else {
    document.getElementById('imp-unmatched-section').style.display = 'none';
  }
  let h = '';
  rows.slice(0, 100).forEach(r => {
    const emp = getEmp(r.empId);
    const nameCell = emp
      ? `<span style="color:var(--grn)">✓</span> ${emp.name}`
      : `<span style="color:var(--amb)">⚠</span> #${r.empId} ${r.name ? '— ' + r.name : ''}`;
    h += `<tr><td class="mono" style="font-size:11px">${r.date}</td><td>${nameCell}</td><td class="mono">${r.firstPunch||'—'}</td><td class="mono">${r.lastPunch||'—'}</td></tr>`;
  });
  if(rows.length > 100) h += `<tr><td colspan="4" style="text-align:center;color:var(--t3);font-size:11px;padding:8px">+${rows.length - 100} سجل آخر</td></tr>`;
  document.getElementById('imp-preview-rows').innerHTML = h;
}

async function confirmImport() {
  if(!importData || !importData.length) return;
  const createMissing = document.getElementById('imp-create-missing').checked;
  const overwrite = document.getElementById('imp-overwrite').checked;
  document.getElementById('imp-confirm').disabled = true;
  document.getElementById('imp-loading-t').textContent = 'جاري الحفظ...';
  document.getElementById('imp-step2').style.display = 'none';
  document.getElementById('imp-loading').style.display = 'flex';
  let created = 0, imported = 0, skipped = 0;
  if(createMissing) {
    const empIds = [...new Set(importData.map(r => r.empId))];
    const newEmps = [];
    for(const id of empIds) {
      if(!getEmp(id)) {
        const sample = importData.find(r => r.empId === id);
        newEmps.push({
          id: String(id),
          name: (sample.name && sample.name.length > 1) ? sample.name : `موظف ${id}`,
          dept: (LS.departments || [])[0]?.id || 'd1',
          title: 'موظف', hire: todayStr(),
          dob:'', pp:'', ppExp:'', nat:'', gender:'', phone:'',
          status:'نشط', type:'ثابت', days:5, hours:6,
          notes:'تم إنشاؤه تلقائياً من الاستيراد',
          endDate:'', endReason:''
        });
      }
    }
    if(newEmps.length) {
      await setManyDocs('employees', newEmps);
      created = newEmps.length;
      newEmps.forEach(e => { if(!getEmp(e.id)) LS.employees.push(e); });
    }
  }
  const recs = [];
  for(const r of importData) {
    if(!getEmp(r.empId)) { skipped++; continue; }
    const existing = (LS.attendance || []).find(a => String(a.empId) === String(r.empId) && a.date === r.date);
    if(existing && !overwrite) { skipped++; continue; }
    recs.push({
      id: existing?.id || uid(),
      empId: String(r.empId), date: r.date,
      timeIn: r.firstPunch || '', timeOut: r.lastPunch || '',
      status: r.status, note: existing?.note || ''
    });
  }
  if(recs.length) { await setManyDocs('attendance', recs); imported = recs.length; }
  closeImport();
  document.getElementById('imp-confirm').disabled = false;
  toast(`✓ تم استيراد ${imported} سجل${created ? ` — أُنشئ ${created} موظف` : ''}${skipped ? ` — تخطي ${skipped}` : ''}`);
  reRenderCurrent();
}

// ════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════
function renderDashboard(){
  const today=new Date();
  const dd=document.getElementById('dash-dt');if(dd)dd.textContent=today.toLocaleDateString('ar-LY',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const da=document.getElementById('dash-actions');
  if(da) da.innerHTML = can('exportCSV')?`<button class="btn bg" onclick="exportCSV()">تصدير CSV</button>`:'';
  const active=(LS.employees||[]).filter(e=>e.status==='نشط').length;const total=(LS.employees||[]).length;
  const tr=(LS.attendance||[]).filter(a=>a.date===todayStr());
  const pres=tr.filter(a=>a.status==='حاضر').length;const abs=tr.filter(a=>a.status!=='حاضر').length;const late=tr.filter(a=>lMin(a.timeIn)>0&&a.status==='حاضر').length;
  const mo=today.getMonth()+1;const yr=today.getFullYear();let mH=0;(LS.employees||[]).forEach(e=>{mH+=calcStats(e,mo,yr).hours;});
  document.getElementById('dash-stats').innerHTML=`
    <div class="sc cb"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div><div class="sv">${total}<small> موظف</small></div><div class="sl">الإجمالي</div><div class="ss">${active} نشط</div></div>
    <div class="sc cg"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg></div><div class="sv">${pres}<small> موظف</small></div><div class="sl">حضور اليوم</div><div class="ss">${active?Math.round(pres/active*100):0}%</div></div>
    <div class="sc cr"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/></svg></div><div class="sv">${abs}<small> موظف</small></div><div class="sl">غياب اليوم</div></div>
    <div class="sc ca"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="sv">${late}<small> موظف</small></div><div class="sl">تأخير اليوم</div></div>
    <div class="sc cp"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-6"/></svg></div><div class="sv">${mH.toFixed(0)}<small> ساعة</small></div><div class="sl">ساعات الشهر</div></div>`;
  const bdEl=document.getElementById('dash-bd');
  if(bdEl){const todayBd=(LS.employees||[]).filter(e=>e.status==='نشط'&&isToday(e.dob));const soon=(LS.employees||[]).filter(e=>e.status==='نشط'&&e.dob&&bdLeft(e.dob)>0&&bdLeft(e.dob)<=3);if(todayBd.length||soon.length){let h='<div style="margin-bottom:16px">';todayBd.forEach(e=>{h+=`<div class="bd-card"><div class="bd-emoji">🎂</div><div class="bd-info"><div class="bd-name">${e.name} — عيد ميلاد سعيد! 🎉</div><div class="bd-detail">${e.title}</div></div><span class="bx xk">اليوم</span></div>`;});soon.forEach(e=>{const d=bdLeft(e.dob);h+=`<div class="bd-card"><div class="bd-emoji">🎈</div><div class="bd-info"><div class="bd-name">${e.name}</div><div class="bd-detail">عيد ميلاده ${d===1?'غداً':'بعد '+d+' أيام'}</div></div><span class="bx xp">${d===1?'غداً':'قريباً'}</span></div>`;});bdEl.innerHTML=h+'</div>';}else bdEl.innerHTML='';}
  const cnt=document.getElementById('bd-nav-cnt');if(cnt){const n=(LS.employees||[]).filter(e=>e.status==='نشط'&&e.dob&&bdLeft(e.dob)<=7).length;cnt.style.display=n>0?'block':'none';if(n>0)cnt.textContent=n;}
  const rec=[...(LS.attendance||[])].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
  let rh=`<table><thead><tr><th>الموظف</th><th>التاريخ</th><th>دخول</th><th>خروج</th><th>الحالة</th></tr></thead><tbody>`;
  if(!rec.length)rh+=`<tr><td colspan="5"><div class="empty"><p>لا سجلات بعد — جرّب استيراد PDF أو إضافة يدوية</p></div></td></tr>`;
  rec.forEach((r,i)=>{const e=getEmp(r.empId);const nm=e?e.name:r.empId;rh+=`<tr><td><div style="display:flex;align-items:center;gap:7px">${av(nm,i)}<span style="font-weight:600">${nm}</span></div></td><td style="color:var(--t2);font-size:12px">${fmtDate(r.date)}</td><td class="mono">${r.timeIn||'—'}</td><td class="mono">${r.timeOut||'—'}</td><td>${aBadge(r.status)}</td></tr>`;});
  document.getElementById('dash-recent').innerHTML=rh+'</tbody></table>';
  const lr=(LS.attendance||[]).filter(a=>lMin(a.timeIn)>0&&a.status==='حاضر').sort((a,b)=>lMin(b.timeIn)-lMin(a.timeIn)).slice(0,7);
  let lh=`<table><thead><tr><th>الموظف</th><th>التاريخ</th><th>دخول</th><th>تأخير</th></tr></thead><tbody>`;
  if(!lr.length)lh+=`<tr><td colspan="4"><div class="empty"><p>لا تأخيرات</p></div></td></tr>`;
  lr.forEach((r,i)=>{const e=getEmp(r.empId);const nm=e?e.name:r.empId;lh+=`<tr><td><div style="display:flex;align-items:center;gap:7px">${av(nm,i)}<span style="font-weight:600">${nm}</span></div></td><td style="color:var(--t2);font-size:12px">${fmtDate(r.date)}</td><td class="mono">${r.timeIn}</td><td><span class="bx xa">${lMin(r.timeIn)} دق</span></td></tr>`;});
  document.getElementById('dash-late').innerHTML=lh+'</tbody></table>';
}

// ════════════════════════════════════════════════════════════════════
// MY PROFILE & ATTENDANCE (employee role)
// ════════════════════════════════════════════════════════════════════
function renderMyProfile(){
  const el = document.getElementById('my-profile-content');
  if(!currentUser.empId){el.innerHTML=`<div class="empty"><p>لم يتم ربط حسابك بموظف — تواصل مع الأدمن</p></div>`;return;}
  const emp = getEmp(currentUser.empId);
  if(!emp){el.innerHTML=`<div class="empty"><p>لم يتم العثور على بياناتك</p></div>`;return;}
  el.innerHTML=`<div class="card"><div class="ch"><div class="ct">بياناتي الشخصية</div></div>
  <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">الاسم</div><div style="font-weight:700">${emp.name}</div></div>
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">رقم الموظف</div><div class="mono">${emp.id}</div></div>
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">القسم</div><div>${dN(emp.dept)}</div></div>
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">المسمى</div><div>${emp.title}</div></div>
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">تاريخ الميلاد</div><div>${emp.dob?fmtBd(emp.dob):'—'}</div></div>
    <div><div style="font-size:11px;color:var(--t3);margin-bottom:4px">الحالة</div><div>${sBadge(emp)}</div></div>
  </div></div>`;
}

function renderMyAttendance(){
  const el = document.getElementById('my-att-table');
  if(!currentUser.empId){el.innerHTML=`<div class="empty"><p>لم يتم ربط حسابك بموظف</p></div>`;return;}
  const recs = [...(LS.attendance||[])].filter(a=>String(a.empId)===String(currentUser.empId)).sort((a,b)=>b.date.localeCompare(a.date));
  let h=`<table><thead><tr><th>التاريخ</th><th>دخول</th><th>خروج</th><th>الساعات</th><th>التأخير</th><th>الحالة</th></tr></thead><tbody>`;
  if(!recs.length)h+=`<tr><td colspan="6"><div class="empty"><p>لا سجلات</p></div></td></tr>`;
  recs.forEach(r=>{const hrs=r.status==='حاضر'?tDiff(r.timeIn,r.timeOut):0;const lt=r.status==='حاضر'?lMin(r.timeIn):0;h+=`<tr><td style="color:var(--t2);font-size:12px">${fmtDate(r.date)}</td><td class="mono">${r.timeIn||'—'}</td><td class="mono">${r.timeOut||'—'}</td><td>${hrs>0?hrs.toFixed(1)+' ساعة':'—'}</td><td>${lt>0?`<span class="bx xa">${lt}دق</span>`:'<span style="color:var(--grn)">✓</span>'}</td><td>${aBadge(r.status)}</td></tr>`;});
  el.innerHTML=h+'</tbody></table>';
}

// ════════════════════════════════════════════════════════════════════
// BIRTHDAYS
// ════════════════════════════════════════════════════════════════════
function renderBirthdays(){
  const empsD=(LS.employees||[]).filter(e=>e.dob);
  const up=empsD.filter(e=>{const d=bdLeft(e.dob);return d!==null&&d<=7;}).sort((a,b)=>bdLeft(a.dob)-bdLeft(b.dob));
  document.getElementById('bd-upcoming').innerHTML=up.length?up.map(e=>{const d=bdLeft(e.dob);const age=calcAge(e.dob);return`<div class="bd-card"><div class="bd-emoji">${d===0?'🎂':d===1?'🎁':'🎈'}</div><div class="bd-info"><div class="bd-name">${e.name}</div><div class="bd-detail">${e.title} — ${dN(e.dept)}</div><div class="bd-detail">${fmtBd(e.dob)}${age?` — ${age} سنة`:''}</div></div><span class="bx ${d===0?'xk':'xp'}">${d===0?'اليوم 🎉':d===1?'غداً':`بعد ${d} أيام`}</span></div>`;}).join(''):`<div class="empty"><p>لا أعياد ميلاد خلال 7 أيام</p></div>`;
  const t=new Date();const tm=empsD.filter(e=>new Date(e.dob).getMonth()===t.getMonth()).sort((a,b)=>new Date(a.dob).getDate()-new Date(b.dob).getDate());
  document.getElementById('bd-thismonth').innerHTML=tm.length?tm.map(e=>{const it=isToday(e.dob);return`<div class="bd-card"><div class="bd-emoji">${it?'🎂':'📅'}</div><div class="bd-info"><div class="bd-name">${e.name}</div><div class="bd-detail">${fmtBd(e.dob)}${calcAge(e.dob)?` — ${calcAge(e.dob)} سنة`:''}</div></div>${it?`<span class="bx xk">اليوم 🎉</span>`:''}</div>`;}).join(''):`<div class="empty"><p>لا أعياد ميلاد هذا الشهر</p></div>`;
  const sorted=[...empsD].sort((a,b)=>{const da=new Date(a.dob),db=new Date(b.dob);return(da.getMonth()*100+da.getDate())-(db.getMonth()*100+db.getDate());});
  let h=`<table><thead><tr><th>الموظف</th><th>القسم</th><th>تاريخ الميلاد</th><th>العمر</th><th>المتبقي</th></tr></thead><tbody>`;
  if(!sorted.length)h+=`<tr><td colspan="5"><div class="empty"><p>لا تواريخ ميلاد مسجلة</p></div></td></tr>`;
  sorted.forEach((e,i)=>{const d=bdLeft(e.dob);const age=calcAge(e.dob);const it=isToday(e.dob);h+=`<tr><td><div style="display:flex;align-items:center;gap:8px">${av(e.name,i)}<span style="font-weight:600">${e.name}</span></div></td><td style="font-size:12px;color:var(--t3)">${dN(e.dept)}</td><td class="mono">${fmtBd(e.dob)}</td><td>${age?age+' سنة':'—'}</td><td>${it?`<span class="bx xk">🎂 اليوم!</span>`:d===1?`<span class="bx xp">غداً</span>`:`<span class="bx xn">${d} يوم</span>`}</td></tr>`;});
  document.getElementById('bd-all').innerHTML=h+'</tbody></table>';
}

// ════════════════════════════════════════════════════════════════════
// DAILY BULK ENTRY
// ════════════════════════════════════════════════════════════════════
let bkDF='';
function renderDaily(){const d=document.getElementById('bk-date');if(d&&!d.value)d.value=todayStr();buildBulkTabs();buildBulk();}
function buildBulkTabs(){const t=document.getElementById('bk-tabs');if(!t)return;let h=`<button class="tab${bkDF===''?' on':''}" onclick="setBkDF('',this)">الكل</button>`;(LS.departments||[]).forEach(d=>{h+=`<button class="tab${bkDF===d.id?' on':''}" onclick="setBkDF('${d.id}',this)">${d.name}</button>`;});t.innerHTML=h;}
function setBkDF(id,el){bkDF=id;document.querySelectorAll('#bk-tabs .tab').forEach(t=>t.classList.remove('on'));el.classList.add('on');buildBulk();}
function buildBulk(){
  const date=document.getElementById('bk-date')?.value||todayStr();const sa=document.getElementById('bk-all')?.checked;
  let emps=(LS.employees||[]).filter(e=>sa||(e.status==='نشط'||e.status==='إجازة_طويلة'));
  if(bkDF)emps=emps.filter(e=>e.dept===bkDF);
  const grid=document.getElementById('bk-grid');if(!grid)return;
  if(!emps.length){grid.innerHTML=`<div class="empty"><p>لا موظفين</p></div>`;return;}
  let h='';
  emps.forEach((e,i)=>{
    const ex=(LS.attendance||[]).find(a=>String(a.empId)===String(e.id)&&a.date===date);
    const tin=ex?.timeIn||'09:00',tout=ex?.timeOut||'15:00',stat=ex?.status||'حاضر',note=ex?.note||'';
    h+=`<div class="bk-row"><div style="display:flex;align-items:center;gap:8px">${av(e.name,i)}<div><div style="font-size:13px;font-weight:600">${e.name}</div><div class="emp-meta">${e.title}</div></div></div><div style="font-size:11px;color:var(--t3)">${dN(e.dept)}</div><input class="bki" type="time" id="bi-${e.id}" value="${tin}" onchange="updLate('${e.id}')"><input class="bki" type="time" id="bo-${e.id}" value="${tout}"><select class="bks" id="bs-${e.id}" onchange="onBkS('${e.id}')"><option ${stat==='حاضر'?'selected':''}>حاضر</option><option ${stat==='غائب باذن'?'selected':''}>غائب باذن</option><option ${stat==='غائب بدون اذن'?'selected':''}>غائب بدون اذن</option><option ${stat==='إجازة سنوية'?'selected':''}>إجازة سنوية</option><option ${stat==='إجازة مرضية'?'selected':''}>إجازة مرضية</option><option ${stat==='إجازة أمومة'?'selected':''}>إجازة أمومة</option><option ${stat==='إجازة أبوة'?'selected':''}>إجازة أبوة</option></select><input class="bkn" type="text" id="bn-${e.id}" value="${note}" placeholder="ملاحظة..."><span class="late-i" id="bl-${e.id}"></span></div>`;
  });
  grid.innerHTML=h;emps.forEach(e=>{updLate(e.id);onBkS(e.id);});
}
function updLate(id){const i=document.getElementById(`bi-${id}`);const e=document.getElementById(`bl-${id}`);if(!i||!e)return;const lt=lMin(i.value);e.textContent=lt>0?`+${lt}دق`:'';}
function onBkS(id){const st=document.getElementById(`bs-${id}`)?.value;const isA=st&&st!=='حاضر';['bi-','bo-'].forEach(p=>{const el=document.getElementById(p+id);if(el){el.style.opacity=isA?.35:1;el.disabled=!!isA;}});}
function fillAllPresent(){const sa=document.getElementById('bk-all')?.checked;let emps=(LS.employees||[]).filter(e=>sa||(e.status==='نشط'));if(bkDF)emps=emps.filter(e=>e.dept===bkDF);emps.forEach(e=>{['bi-','bo-'].forEach((p,j)=>{const el=document.getElementById(p+e.id);if(el){el.value=j===0?'09:00':'15:00';el.style.opacity=1;el.disabled=false;}});const st=document.getElementById(`bs-${e.id}`);if(st)st.value='حاضر';const lt=document.getElementById(`bl-${e.id}`);if(lt)lt.textContent='';});}
async function saveBulk(){
  const date=document.getElementById('bk-date')?.value;if(!date){toast('اختر التاريخ','var(--red)');return;}
  const sa=document.getElementById('bk-all')?.checked;let emps=(LS.employees||[]).filter(e=>sa||(e.status==='نشط'||e.status==='إجازة_طويلة'));if(bkDF)emps=emps.filter(e=>e.dept===bkDF);
  // Delete existing records for this date+emp set
  const empIds = emps.map(e=>String(e.id));
  const toDel = (LS.attendance||[]).filter(a=>empIds.includes(String(a.empId))&&a.date===date);
  for(const d of toDel) await delDoc('attendance', d.id);
  const recs = [];
  emps.forEach(e=>{
    const st=document.getElementById(`bs-${e.id}`)?.value||'حاضر';
    const tin=document.getElementById(`bi-${e.id}`)?.value||'09:00';
    const tout=document.getElementById(`bo-${e.id}`)?.value||'15:00';
    const note=document.getElementById(`bn-${e.id}`)?.value||'';
    recs.push({id:uid(),empId:String(e.id),date,timeIn:st==='حاضر'?tin:'',timeOut:st==='حاضر'?tout:'',status:st,note});
  });
  await setManyDocs('attendance', recs);
  toast(`✓ تم حفظ ${recs.length} سجل — ${fmtDate(date)}`);
}

// ════════════════════════════════════════════════════════════════════
// RECORDS
// ════════════════════════════════════════════════════════════════════
function renderRecords(){
  const es=document.getElementById('rec-emp');if(es){const cv=es.value;es.innerHTML='<option value="">كل الموظفين</option>'+(LS.employees||[]).map(e=>`<option value="${e.id}" ${e.id===cv?'selected':''}>${e.name}</option>`).join('');}
  const ae=document.getElementById('at-emp');if(ae){const cv=ae.value;ae.innerHTML=(LS.employees||[]).map(e=>`<option value="${e.id}" ${e.id===cv?'selected':''}>${e.name} (#${e.id})</option>`).join('');}
  const btn=document.getElementById('btn-add-rec');if(btn)btn.style.display=can('addAtt')?'inline-flex':'none';
  const srch=(document.getElementById('rec-srch')?.value||'').toLowerCase();const dateF=document.getElementById('rec-date')?.value||'';const empF=document.getElementById('rec-emp')?.value||'';const statF=document.getElementById('rec-stat')?.value||'';
  let recs=[...(LS.attendance||[])].sort((a,b)=>b.date.localeCompare(a.date));
  recs=recs.filter(r=>{const e=getEmp(r.empId);const nm=e?e.name:'';if(srch&&!nm.toLowerCase().includes(srch)&&!String(r.empId).includes(srch))return false;if(dateF&&r.date!==dateF)return false;if(empF&&String(r.empId)!==empF)return false;if(statF&&r.status!==statF)return false;return true;});
  let h=`<table><thead><tr><th>التاريخ</th><th>الموظف</th><th>القسم</th><th>دخول</th><th>خروج</th><th>الساعات</th><th>التأخير</th><th>أوفرتايم</th><th>الحالة</th>${can('deleteAtt')?'<th></th>':''}</tr></thead><tbody>`;
  if(!recs.length)h+=`<tr><td colspan="${can('deleteAtt')?10:9}"><div class="empty"><p>لا نتائج</p></div></td></tr>`;
  recs.slice(0, 500).forEach((r,i)=>{const e=getEmp(r.empId);const nm=e?e.name:r.empId;const hrs=r.status==='حاضر'?tDiff(r.timeIn,r.timeOut):0;const lt=r.status==='حاضر'?lMin(r.timeIn):0;const ot=r.status==='حاضر'&&e?otH(r.timeIn,r.timeOut,e.hours):0;h+=`<tr><td style="color:var(--t2);font-size:12px;white-space:nowrap">${fmtDate(r.date)}</td><td><div style="display:flex;align-items:center;gap:7px">${av(nm,i)}<span style="font-weight:600">${nm}</span></div></td><td style="color:var(--t3);font-size:12px">${e?dN(e.dept):'—'}</td><td class="mono">${r.timeIn||'—'}</td><td class="mono">${r.timeOut||'—'}</td><td>${hrs>0?hrs.toFixed(1)+' ساعة':'—'}</td><td>${lt>0?`<span class="bx xa">${lt}دق</span>`:'<span style="color:var(--grn)">✓</span>'}</td><td>${ot>0?`<span class="bx xb">${ot.toFixed(1)}ساعة</span>`:'—'}</td><td>${aBadge(r.status)}</td>${can('deleteAtt')?`<td><button class="btn bd btn-xs" onclick="delRec('${r.id}')">حذف</button></td>`:''}</tr>`;});
  if(recs.length > 500) h += `<tr><td colspan="10" style="text-align:center;color:var(--t3);font-size:11px;padding:8px">عرض أول 500 من ${recs.length} سجل — استخدم الفلتر لتضييق النتائج</td></tr>`;
  document.getElementById('rec-table').innerHTML=h+'</tbody></table>';
}
async function saveAttRec(){
  if(!can('addAtt')){toast('ليس لديك صلاحية','var(--red)');return;}
  const empId=document.getElementById('at-emp')?.value;const date=document.getElementById('at-date')?.value;
  const status=document.getElementById('at-stat')?.value||'حاضر';const tin=document.getElementById('at-in')?.value||'09:00';const tout=document.getElementById('at-out')?.value||'15:00';const note=document.getElementById('at-note')?.value||'';
  if(!empId||!date){toast('يرجى اختيار الموظف والتاريخ','var(--red)');return;}
  await setDoc('attendance', uid(), {empId:String(empId),date,timeIn:status==='حاضر'?tin:'',timeOut:status==='حاضر'?tout:'',status,note});
  closeOv('ov-att');toast('✓ تم إضافة السجل');
}
function delRec(id){if(!can('deleteAtt')){toast('ليس لديك صلاحية','var(--red)');return;}confirm2('حذف السجل','هل تريد حذف هذا السجل؟',async()=>{await delDoc('attendance',id);toast('تم الحذف','var(--red)');});}

// ════════════════════════════════════════════════════════════════════
// MONTHLY / HALFYEAR / ANNUAL
// ════════════════════════════════════════════════════════════════════
function renderMonthly(){
  const mo=parseInt(document.getElementById('mo-m')?.value||new Date().getMonth()+1);const yr=parseInt(document.getElementById('mo-y')?.value||2026);
  const data=(LS.employees||[]).map(e=>({e,s:calcStats(e,mo,yr)}));
  const tP=data.reduce((a,x)=>a+x.s.present,0),tH=data.reduce((a,x)=>a+x.s.hours,0),tL=data.reduce((a,x)=>a+x.s.late,0),tOT=data.reduce((a,x)=>a+x.s.ot,0),tAbs=data.reduce((a,x)=>a+x.s.absA+x.s.absU,0);
  document.getElementById('mo-stats').innerHTML=`<div class="sc cg"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg></div><div class="sv">${tP}<small> يوم</small></div><div class="sl">أيام الحضور</div></div><div class="sc cb"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg></div><div class="sv">${tH.toFixed(0)}<small> ساعة</small></div><div class="sl">إجمالي الساعات</div></div><div class="sc ca"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></div><div class="sv">${tL}<small> دق</small></div><div class="sl">التأخير</div></div><div class="sc cp"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/></svg></div><div class="sv">${tOT.toFixed(1)}<small> ساعة</small></div><div class="sl">الأوفرتايم</div></div><div class="sc cr"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg></div><div class="sv">${tAbs}<small> يوم</small></div><div class="sl">الغياب</div></div>`;
  let h=`<table><thead><tr><th>الموظف</th><th>القسم</th><th>أيام حضور</th><th>ساعات</th><th>أوفرتايم</th><th>تأخير</th><th>غياب باذن</th><th>بدون اذن</th><th>نسبة</th><th>التقييم</th></tr></thead><tbody>`;
  data.forEach(({e,s},i)=>{const bc=s.pct>=90?'var(--grn)':s.pct>=60?'var(--amb)':'var(--red)';h+=`<tr><td><div style="display:flex;align-items:center;gap:8px">${av(e.name,i)}<div><span style="font-weight:600">${e.name}</span>${sBadge(e)}</div></div></td><td style="font-size:12px;color:var(--t3)">${dN(e.dept)}</td><td style="font-weight:700">${s.present}</td><td>${s.hours}</td><td style="color:var(--brand-teal)">${s.ot>0?s.ot+' س':'—'}</td><td>${s.late>0?`<span class="bx xa">${s.late}دق</span>`:'<span style="color:var(--grn)">✓</span>'}</td><td>${s.absA||'—'}</td><td>${s.absU>0?`<span class="bx xr">${s.absU}</span>`:'—'}</td><td>${pBar(s.pct,bc)}</td><td>${rBadge(s.rating)}</td></tr>`;});
  document.getElementById('mo-table').innerHTML=h+'</tbody></table>';
}

function renderHalfYear(){
  const half=parseInt(document.getElementById('hy-h')?.value||1);const yr=parseInt(document.getElementById('hy-y')?.value||2026);
  const months=half===1?[1,2,3,4,5,6]:[7,8,9,10,11,12];const halfLbl=half===1?'يناير — يونيو':'يوليو — ديسمبر';
  document.getElementById('hy-title').textContent=`${halfLbl} ${yr}`;
  let tP=0,tH=0,tL=0,tOT=0,tAbs=0;
  const ed=(LS.employees||[]).map(e=>{const ms=months.map(m=>({m,s:calcStats(e,m,yr)}));const sP=ms.reduce((a,x)=>a+x.s.present,0),sH=ms.reduce((a,x)=>a+x.s.hours,0),sL=ms.reduce((a,x)=>a+x.s.late,0),sOT=ms.reduce((a,x)=>a+x.s.ot,0),sAbs=ms.reduce((a,x)=>a+x.s.absA+x.s.absU,0);const req=reqH(e)*6;const pct=req>0?+(sH/req*100).toFixed(1):0;tP+=sP;tH+=sH;tL+=sL;tOT+=sOT;tAbs+=sAbs;return{e,ms,sP,sH:+sH.toFixed(1),sL,sOT:+sOT.toFixed(2),sAbs,pct};});
  document.getElementById('hy-stats').innerHTML=`<div class="sc cg"><div class="si"></div><div class="sv">${tP}<small> يوم</small></div><div class="sl">إجمالي الحضور</div></div><div class="sc cb"><div class="si"></div><div class="sv">${tH.toFixed(0)}<small> س</small></div><div class="sl">الساعات</div></div><div class="sc ca"><div class="si"></div><div class="sv">${tL}<small> دق</small></div><div class="sl">التأخير</div></div><div class="sc cp"><div class="si"></div><div class="sv">${tOT.toFixed(1)}<small> س</small></div><div class="sl">الأوفرتايم</div></div><div class="sc cr"><div class="si"></div><div class="sv">${tAbs}<small> يوم</small></div><div class="sl">الغياب</div></div>`;
  let h=`<div style="display:grid;grid-template-columns:2fr repeat(6,1fr) 90px 70px;gap:4px;padding:8px 14px;background:rgba(11,14,28,0.7);border-bottom:1px solid var(--b2);font-size:9.5px;font-weight:800;color:var(--t3)"><span>الموظف</span>${months.map(m=>`<span style="text-align:center">${MN[m]}</span>`).join('')}<span>إجمالي</span><span>نسبة</span></div>`;
  ed.forEach(({e,ms,sH,pct},i)=>{const bc=pct>=90?'var(--grn)':pct>=60?'var(--amb)':'var(--red)';h+=`<div style="display:grid;grid-template-columns:2fr repeat(6,1fr) 90px 70px;gap:4px;align-items:center;padding:8px 14px;border-bottom:1px solid var(--b1)"><div style="display:flex;align-items:center;gap:7px">${av(e.name,i)}<div><div style="font-weight:600;font-size:13px">${e.name}</div><div class="emp-meta">${dN(e.dept)}</div></div></div>${ms.map(({s})=>{const c=s.pct>=90?'var(--grn)':s.pct>=60?'var(--amb)':s.pct>0?'var(--red)':'var(--t3)';return`<div style="text-align:center"><div style="font-size:13px;font-weight:800;color:${c}">${s.present}</div><div style="font-size:9.5px;color:var(--t3)">${s.pct}%</div></div>`;}).join('')}<div style="font-weight:700;font-size:13px">${sH} س</div><div>${pBar(pct,bc)}</div></div>`;});
  document.getElementById('hy-wrap').innerHTML=h;
}

function renderAnnual(){
  const yr=parseInt(document.getElementById('an-y')?.value||2026);
  let h=`<table><thead><tr><th>الموظف</th><th>القسم</th><th>الحالة</th><th>الجواز</th><th>أيام</th><th>ساعات</th><th>OT</th><th>تأخير</th><th>غياب</th><th>نسبة</th></tr></thead><tbody>`;
  (LS.employees||[]).forEach((e,i)=>{let tP=0,tH=0,tOT=0,tL=0,tAbs=0;for(let m=1;m<=12;m++){const s=calcStats(e,m,yr);tP+=s.present;tH+=s.hours;tOT+=s.ot;tL+=s.late;tAbs+=s.absA+s.absU;}const req=reqH(e)*12;const pct=req>0?+(tH/req*100).toFixed(1):0;const bc=pct>=80?'var(--grn)':pct>=50?'var(--amb)':'var(--red)';let ppCell='—';if(e.pp){ppCell=`<span class="mono">${e.pp}</span>`;if(e.ppExp){const dl=Math.floor((new Date(e.ppExp)-new Date())/(864e5));if(dl<0)ppCell+=` <span class="bx xr" style="font-size:9px">منتهي</span>`;else if(dl<90)ppCell+=` <span class="bx xa" style="font-size:9px">⚠</span>`;}}h+=`<tr><td><div style="display:flex;align-items:center;gap:7px">${av(e.name,i)}<div><span style="font-weight:600">${e.name}</span><div class="emp-meta">#${e.id}</div></div></div></td><td style="font-size:12px;color:var(--t3)">${dN(e.dept)}</td><td>${sBadge(e)}</td><td>${ppCell}</td><td style="font-weight:700">${tP}</td><td>${tH.toFixed(1)} س</td><td style="color:var(--brand-teal)">${tOT.toFixed(2)} س</td><td>${tL>0?`<span class="bx xa">${tL}دق</span>`:'<span style="color:var(--grn)">✓</span>'}</td><td>${tAbs||'—'}</td><td>${pBar(pct,bc)}</td></tr>`;});
  document.getElementById('an-table').innerHTML=h+'</tbody></table>';
}

// ════════════════════════════════════════════════════════════════════
// EMPLOYEES
// ════════════════════════════════════════════════════════════════════
let empTab='all';let editEmpId=null;
function setEmpTab(v,el){empTab=v;document.querySelectorAll('#page-employees .tab').forEach(t=>t.classList.remove('on'));el.classList.add('on');renderEmployees();}
function renderEmployees(){
  const df=document.getElementById('emp-df');if(df){const cv=df.value;df.innerHTML='<option value="">كل الأقسام</option>'+(LS.departments||[]).map(d=>`<option value="${d.id}" ${d.id===cv?'selected':''}>${d.name}</option>`).join('');}
  const ea=document.getElementById('emp-actions');if(ea){ea.innerHTML=can('addEmp')?`<button class="btn bp" onclick="openEmpModal()">+ إضافة موظف</button>`:'';}
  const srch=(document.getElementById('emp-srch')?.value||'').toLowerCase();const deptF=df?.value||'';
  let emps=(LS.employees||[]).filter(e=>{if(empTab!=='all'&&e.status!==empTab)return false;if(deptF&&e.dept!==deptF)return false;if(srch&&!e.name.toLowerCase().includes(srch)&&!String(e.id).includes(srch))return false;return true;});
  document.getElementById('emp-sub').textContent=`${(LS.employees||[]).length} موظف في قاعدة البيانات`;
  const showDel=can('deleteEmp');
  let h=`<table><thead><tr><th>#</th><th>الموظف</th><th>القسم</th><th>المسمى</th><th>الجواز</th><th>الميلاد</th><th>الدوام</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>`;
  if(!emps.length)h+=`<tr><td colspan="9"><div class="empty"><p>لا نتائج</p></div></td></tr>`;
  emps.forEach((e,i)=>{const term=e.status==='استقال'||e.status==='منتهية_خدمته';let ppCell='—';if(e.pp){ppCell=`<span class="mono" style="font-size:11px">${e.pp}</span>`;if(e.ppExp){const dl=Math.floor((new Date(e.ppExp)-new Date())/(864e5));if(dl<0)ppCell+=` <span class="bx xr" style="font-size:9px">منتهي</span>`;else if(dl<90)ppCell+=` <span class="bx xa" style="font-size:9px">⚠</span>`;}}h+=`<tr style="${term?'opacity:.65':''}"><td style="color:var(--t3);font-family:'JetBrains Mono',monospace;font-size:11px">${e.id}</td><td><div style="display:flex;align-items:center;gap:8px">${av(e.name,i)}<div><div style="font-weight:700">${e.name}${isToday(e.dob)?' 🎂':''}</div><div class="emp-meta">${e.gender||''}</div></div></div></td><td style="font-size:12px;color:var(--t2)">${dN(e.dept)}</td><td style="font-size:12px;color:var(--t3)">${e.title}</td><td>${ppCell}</td><td style="font-size:12px;color:var(--t2)">${e.dob?fmtBd(e.dob):'—'}</td><td><span class="bx xn">${e.type}</span></td><td>${sBadge(e)}</td><td><div style="display:flex;gap:4px">${can('editEmp')?`<button class="btn bg btn-xs" onclick="openEmpEdit('${e.id}')">تعديل</button>`:''}${showDel?`<button class="btn bd btn-xs" onclick="delEmp('${e.id}')">حذف</button>`:''}</div></td></tr>`;});
  document.getElementById('emp-table').innerHTML=h+'</tbody></table>';
}
function openEmpModal(){if(!can('addEmp')){toast('ليس لديك صلاحية','var(--red)');return;}editEmpId=null;document.getElementById('emp-modal-t').textContent='إضافة موظف جديد';['ef-id','ef-name','ef-dob','ef-pp','ef-pp-exp','ef-nat','ef-phone'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});document.getElementById('ef-hire').value=todayStr();document.getElementById('ef-status').value='نشط';document.getElementById('ef-type').value='ثابت';document.getElementById('ef-days').value=5;document.getElementById('ef-hours').value=6;document.getElementById('ef-gender').value='';fillDeptOpts();fillTitles();openOv('ov-emp');}
function openEmpEdit(id){if(!can('editEmp')){toast('ليس لديك صلاحية','var(--red)');return;}const e=getEmp(id);if(!e)return;editEmpId=id;document.getElementById('emp-modal-t').textContent='تعديل بيانات الموظف';document.getElementById('ef-id').value=e.id;document.getElementById('ef-name').value=e.name;document.getElementById('ef-dob').value=e.dob||'';document.getElementById('ef-pp').value=e.pp||'';document.getElementById('ef-pp-exp').value=e.ppExp||'';document.getElementById('ef-nat').value=e.nat||'';document.getElementById('ef-phone').value=e.phone||'';document.getElementById('ef-gender').value=e.gender||'';document.getElementById('ef-hire').value=e.hire||'';document.getElementById('ef-status').value=e.status||'نشط';document.getElementById('ef-type').value=e.type||'ثابت';document.getElementById('ef-days').value=e.days||5;document.getElementById('ef-hours').value=e.hours||6;fillDeptOpts();document.getElementById('ef-dept').value=e.dept||'';fillTitles();document.getElementById('ef-title').value=e.title||'';openOv('ov-emp');}
function fillDeptOpts(){const s=document.getElementById('ef-dept');if(!s)return;s.innerHTML=(LS.departments||[]).map(d=>`<option value="${d.id}">${d.name}</option>`).join('');}
function fillTitles(){const dId=document.getElementById('ef-dept')?.value;const d=getDept(dId);const s=document.getElementById('ef-title');if(!s)return;s.innerHTML=(d.jobs||[]).map(j=>`<option value="${j}">${j}</option>`).join('');}
function customTitle(){const t=prompt('أدخل المسمى الوظيفي:');if(!t)return;const s=document.getElementById('ef-title');const o=document.createElement('option');o.value=t;o.textContent=t;o.selected=true;s.appendChild(o);}
async function saveEmp(){
  const id=document.getElementById('ef-id')?.value.trim();const name=document.getElementById('ef-name')?.value.trim();const dept=document.getElementById('ef-dept')?.value;
  if(!id||!name||!dept){toast('املأ الحقول المطلوبة','var(--red)');return;}
  const emp={id,name,dept,title:document.getElementById('ef-title')?.value||'',hire:document.getElementById('ef-hire')?.value||'',dob:document.getElementById('ef-dob')?.value||'',pp:document.getElementById('ef-pp')?.value||'',ppExp:document.getElementById('ef-pp-exp')?.value||'',nat:document.getElementById('ef-nat')?.value||'',gender:document.getElementById('ef-gender')?.value||'',phone:document.getElementById('ef-phone')?.value||'',status:document.getElementById('ef-status')?.value||'نشط',type:document.getElementById('ef-type')?.value||'ثابت',days:parseInt(document.getElementById('ef-days')?.value)||5,hours:parseInt(document.getElementById('ef-hours')?.value)||6};
  if(!editEmpId && getEmp(id)){toast('رقم الموظف مستخدم مسبقاً','var(--red)');return;}
  await setDoc('employees', id, emp);
  closeOv('ov-emp');
  toast(editEmpId?'✓ تم التحديث':'✓ تم إضافة الموظف');
}
function delEmp(id){if(!can('deleteEmp')){toast('ليس لديك صلاحية','var(--red)');return;}const e=getEmp(id);confirm2('حذف الموظف',`حذف "${e?.name}"؟ هذا سيحذف كل سجلات حضوره أيضاً.`,async()=>{const recs=(LS.attendance||[]).filter(a=>String(a.empId)===String(id));for(const r of recs) await delDoc('attendance', r.id);await delDoc('employees', id);toast('تم الحذف','var(--red)');});}

// ════════════════════════════════════════════════════════════════════
// DEPARTMENTS
// ════════════════════════════════════════════════════════════════════
let editDeptId=null;
function renderDepts(){
  const da=document.getElementById('dept-actions');
  if(da)da.innerHTML=can('addDept')?`<button class="btn bp" onclick="openOv('ov-dept-add')">+ إضافة قسم</button>`:'';
  const grid=document.getElementById('dept-grid');if(!grid)return;
  if(!(LS.departments||[]).length){grid.innerHTML=`<div style="grid-column:span 3"><div class="empty"><p>لا أقسام</p></div></div>`;return;}
  grid.innerHTML=(LS.departments||[]).map((d,i)=>{const c=COLORS[i%COLORS.length];const ec=(LS.employees||[]).filter(e=>e.dept===d.id).length;return`<div class="dc"><div class="dc-head" style="border-top:2px solid ${c}"><div><div style="font-weight:800;font-size:14px">${d.name}</div></div><div style="display:flex;gap:5px"><span class="bx xb" style="font-size:10px">${ec} موظف</span>${can('editDept')?`<button class="btn bg btn-xs" onclick="openDeptEdit('${d.id}')">تعديل</button>`:''}</div></div><div class="dc-body"><div style="display:flex;flex-wrap:wrap;gap:3px">${(d.jobs||[]).map(j=>`<span class="job-chip">${j}</span>`).join('')||'<span style="font-size:12px;color:var(--t3)">لا مسميات</span>'}</div></div></div>`;}).join('');
}
function addJobRow(cid){const c=document.getElementById(cid);if(!c)return;const row=document.createElement('div');row.style.cssText='display:flex;gap:6px';row.innerHTML=`<input class="fi" type="text" placeholder="اسم المسمى" style="flex:1"><button class="btn bd btn-xs" onclick="this.parentElement.remove()">✕</button>`;c.appendChild(row);row.querySelector('input').focus();}
async function saveDeptAdd(){if(!can('addDept')){toast('ليس لديك صلاحية','var(--red)');return;}const name=document.getElementById('da-name')?.value.trim();if(!name){toast('أدخل اسم القسم','var(--red)');return;}const jobs=[...document.getElementById('da-jobs').querySelectorAll('input')].map(i=>i.value.trim()).filter(Boolean);const id='d'+uid();await setDoc('departments',id,{name,jobs});closeOv('ov-dept-add');document.getElementById('da-name').value='';document.getElementById('da-jobs').innerHTML='';toast('✓ تم إضافة القسم');}
function openDeptEdit(id){if(!can('editDept')){toast('ليس لديك صلاحية','var(--red)');return;}const d=(LS.departments||[]).find(x=>x.id===id);if(!d)return;editDeptId=id;document.getElementById('dept-edit-t').textContent='تعديل: '+d.name;document.getElementById('de-name').value=d.name;const jl=document.getElementById('de-jobs');jl.innerHTML='';(d.jobs||[]).forEach(j=>{const row=document.createElement('div');row.style.cssText='display:flex;gap:6px';row.innerHTML=`<input class="fi" type="text" value="${j}" style="flex:1"><button class="btn bd btn-xs" onclick="this.parentElement.remove()">✕</button>`;jl.appendChild(row);});document.getElementById('dept-del-btn').onclick=()=>delDept(id);document.getElementById('dept-del-btn').style.display=can('deleteDept')?'inline-flex':'none';openOv('ov-dept-edit');}
async function saveDeptEdit(){if(!can('editDept')||!editDeptId)return;const name=document.getElementById('de-name')?.value.trim();if(!name)return;const jobs=[...document.getElementById('de-jobs').querySelectorAll('input')].map(i=>i.value.trim()).filter(Boolean);await setDoc('departments',editDeptId,{name,jobs});closeOv('ov-dept-edit');toast('✓ تم التحديث');}
function delDept(id){if(!can('deleteDept'))return;const d=(LS.departments||[]).find(x=>x.id===id);const ec=(LS.employees||[]).filter(e=>e.dept===id).length;confirm2('حذف القسم',`حذف "${d?.name}"؟${ec?` (${ec} موظف مرتبط)`:''}`,async()=>{await delDoc('departments',id);closeOv('ov-dept-edit');toast('تم الحذف','var(--red)');});}

// ════════════════════════════════════════════════════════════════════
// USERS MANAGEMENT
// ════════════════════════════════════════════════════════════════════
function renderUsers(){
  document.getElementById('users-list').innerHTML=USERS.map(u=>{const c=ROLE_COLORS[u.role];return`<div class="user-card"><div class="user-card-av" style="background:${c}22;color:${c}">${u.displayName.split(' ').map(p=>p[0]).slice(0,2).join('')}</div><div class="user-card-info"><div class="user-card-name">${u.displayName}</div><div class="user-card-role">المستخدم: <strong>${u.username}</strong> — الدور: <span class="bx" style="background:${c}22;color:${c};font-size:10px">${ROLE_LABELS[u.role]}</span></div>${u.empId?`<div style="font-size:11px;color:var(--t3);margin-top:3px">مرتبط بـ: ${getEmp(u.empId)?.name||u.empId}</div>`:''}</div><div class="user-card-actions"><button class="btn bg btn-sm" onclick="openChangePw('${u.username}')">🔐 كلمة المرور</button><button class="btn ba btn-sm" onclick="openLinkEmp('${u.username}')">🔗 ربط بموظف</button></div></div>`;}).join('');
}
let changePwTarget = null;
function openChangePw(username){changePwTarget=username;document.getElementById('cpw-user').value=username;document.getElementById('cpw-new').value='';document.getElementById('cpw-con').value='';document.getElementById('cpw-err').textContent='';openOv('ov-changepw');}
async function saveChangePw(){
  const nw=document.getElementById('cpw-new').value;const cn=document.getElementById('cpw-con').value;const err=document.getElementById('cpw-err');
  if(nw.length<4){err.textContent='⚠️ كلمة المرور قصيرة';return;}
  if(nw!==cn){err.textContent='⚠️ غير متطابقة';return;}
  const u=USERS.find(x=>x.username===changePwTarget);if(u){u.password=nw;await setDoc('users',u.id,u);}
  closeOv('ov-changepw');toast(`✓ تم تغيير كلمة مرور ${changePwTarget}`);
}
async function openLinkEmp(username){
  const u=USERS.find(x=>x.username===username);
  const choice=prompt(`ربط "${username}" بموظف — أدخل رقم الموظف (فارغ لإزالة الربط):\n\n${(LS.employees||[]).map(e=>`${e.id}: ${e.name}`).join('\n')}`);
  if(choice===null)return;
  const newId = choice.trim();
  if(newId && !getEmp(newId)){toast('رقم الموظف غير موجود','var(--red)');return;}
  if(u){u.empId=newId||null;await setDoc('users',u.id,u);renderUsers();toast(newId?`✓ تم الربط بـ ${getEmp(newId).name}`:'تم إزالة الربط');}
}

// ════════════════════════════════════════════════════════════════════
// EXPORT CSV
// ════════════════════════════════════════════════════════════════════
function exportCSV(){
  if(!can('exportCSV'))return;
  const rows=[['التاريخ','رقم الموظف','الاسم','القسم','المسمى','دخول','خروج','الساعات','التأخير(دق)','أوفرتايم(س)','الحالة','ملاحظة']];
  (LS.attendance||[]).forEach(r=>{const e=getEmp(r.empId);const hrs=r.status==='حاضر'?tDiff(r.timeIn,r.timeOut).toFixed(2):0;const lt=r.status==='حاضر'?lMin(r.timeIn):0;const ot=r.status==='حاضر'&&e?otH(r.timeIn,r.timeOut,e.hours).toFixed(2):0;rows.push([r.date,r.empId,e?.name||'',e?dN(e.dept):'',e?.title||'',r.timeIn||'',r.timeOut||'',hrs,lt,ot,r.status,r.note||'']);});
  const csv='\uFEFF'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download=`rmg_hr_${todayStr()}.csv`;a.click();
  toast('✓ تم التصدير');
}

// ════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════
document.querySelectorAll('.ov').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open')}));

// ════════════════════════════════════════════════════════════════════
// 🎨 THEME SYSTEM — customizable accent color + mode
// ════════════════════════════════════════════════════════════════════
const THEME_PRESETS = [
  {name:'تركواز R.M.G', color:'#2aa3b1'},
  {name:'أزرق ملكي', color:'#1a5a8a'},
  {name:'أزرق سماوي', color:'#3b82f6'},
  {name:'بنفسجي', color:'#8b5cf6'},
  {name:'وردي', color:'#ec4899'},
  {name:'أخضر زمردي', color:'#10b981'},
  {name:'أمبر', color:'#f59e0b'},
  {name:'قرمزي', color:'#ef4444'},
  {name:'سماوي', color:'#06b6d4'},
  {name:'ليموني', color:'#84cc16'},
  {name:'برتقالي', color:'#f97316'},
  {name:'تركواز فاتح', color:'#14b8a6'},
];

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if(hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function applyTheme(color) {
  if(!/^#[0-9a-fA-F]{3,8}$/.test(color)) return;
  const [r, g, b] = hexToRgb(color);
  const root = document.documentElement;
  root.style.setProperty('--acc', color);
  root.style.setProperty('--brand-teal', color);
  root.style.setProperty('--acc-g', `rgba(${r},${g},${b},0.18)`);
  root.style.setProperty('--acc-b', `rgba(${r},${g},${b},0.08)`);
  root.style.setProperty('--acc-glow', `rgba(${r},${g},${b},0.35)`);
  localStorage.setItem('rmg_theme_color', color);
  const hex = document.getElementById('theme-hex');
  const cp = document.getElementById('theme-custom');
  if(hex) hex.value = color;
  if(cp) cp.value = color;
  // Highlight active swatch
  document.querySelectorAll('.tsw').forEach(s => {
    s.style.boxShadow = s.dataset.color === color ? `0 0 0 3px ${color}, 0 0 0 1px var(--bg)` : '';
  });
}

function resetTheme() {
  applyTheme('#2aa3b1');
  setAppMode('navy');
  toast('✓ تم الاسترجاع للافتراضي');
}

function setAppMode(mode) {
  localStorage.setItem('rmg_theme_mode', mode);
  const root = document.documentElement;
  if(mode === 'navy') {
    // 🌊 كحلي R.M.G — أزرق كحلي حقيقي
    root.style.setProperty('--bg', '#0c2046');
    root.style.setProperty('--bg2', '#112854');
    root.style.setProperty('--bg3', '#163161');
    root.style.setProperty('--bg4', '#1c3a6e');
    root.style.setProperty('--card', '#132a55');
    root.style.setProperty('--card2', '#193362');
    root.style.setProperty('--t1', '#e8eefa');
    root.style.setProperty('--t2', '#8b9cc9');
    root.style.setProperty('--t3', '#5267a0');
    root.style.setProperty('--b1', 'rgba(255,255,255,0.06)');
    root.style.setProperty('--b2', 'rgba(255,255,255,0.10)');
    root.style.setProperty('--b3', 'rgba(255,255,255,0.18)');
  } else if(mode === 'light') {
    // ☀️ فاتح — يناسب الشعار الملون
    root.style.setProperty('--bg', '#f1f5fb');
    root.style.setProperty('--bg2', '#e8eef7');
    root.style.setProperty('--bg3', '#dde5f1');
    root.style.setProperty('--bg4', '#cfdaeb');
    root.style.setProperty('--card', '#ffffff');
    root.style.setProperty('--card2', '#f7faff');
    root.style.setProperty('--t1', '#0b1b3a');
    root.style.setProperty('--t2', '#3d4f7a');
    root.style.setProperty('--t3', '#7689b0');
    root.style.setProperty('--b1', 'rgba(11,27,58,0.07)');
    root.style.setProperty('--b2', 'rgba(11,27,58,0.13)');
    root.style.setProperty('--b3', 'rgba(11,27,58,0.20)');
  } else {
    // 🌙 داكن خالص
    root.style.setProperty('--bg', '#07090f');
    root.style.setProperty('--bg2', '#0b0e1c');
    root.style.setProperty('--bg3', '#101427');
    root.style.setProperty('--bg4', '#161b30');
    root.style.setProperty('--card', '#0e1120');
    root.style.setProperty('--card2', '#131729');
    root.style.setProperty('--t1', '#e4eaf8');
    root.style.setProperty('--t2', '#7d8ab8');
    root.style.setProperty('--t3', '#465077');
    root.style.setProperty('--b1', 'rgba(255,255,255,0.05)');
    root.style.setProperty('--b2', 'rgba(255,255,255,0.09)');
    root.style.setProperty('--b3', 'rgba(255,255,255,0.16)');
  }
  // ⭐ تبديل الشعار تلقائياً: فاتح → ملون، داكن/كحلي → أبيض
  const logoSrc = mode === 'light' ? 'assets/Main-Logo.png' : 'assets/Logo-White.png';
  document.querySelectorAll('.rmg-logo').forEach(img => img.src = logoSrc);
  // تفعيل الزر النشط
  document.querySelectorAll('#mode-dark-btn, #mode-navy-btn, #mode-light-btn').forEach(b => { b.classList.remove('bp'); b.classList.add('bg'); });
  const active = document.getElementById('mode-' + mode + '-btn');
  if(active) { active.classList.remove('bg'); active.classList.add('bp'); }
}

function loadTheme() {
  const savedColor = localStorage.getItem('rmg_theme_color') || '#2aa3b1';
  const savedMode = localStorage.getItem('rmg_theme_mode') || 'navy';
  applyTheme(savedColor);
  setAppMode(savedMode);
}

function initSettings() {
  const grid = document.getElementById('theme-swatches');
  if(grid) {
    grid.innerHTML = THEME_PRESETS.map(p => `<button class="tsw" data-color="${p.color}" onclick="applyTheme('${p.color}')" title="${p.name}" style="aspect-ratio:1;border-radius:10px;border:1px solid var(--b2);background:${p.color};cursor:pointer;transition:all .15s;position:relative"></button>`).join('');
  }
  const cur = localStorage.getItem('rmg_theme_color') || '#2aa3b1';
  applyTheme(cur);
  setAppMode(localStorage.getItem('rmg_theme_mode') || 'navy');
  const dbEl = document.getElementById('set-db-status');
  if(dbEl) dbEl.textContent = firebaseReady ? '☁️ Firebase متصل' : '💾 محلي فقط';
}

// ════════════════════════════════════════════════════════════════════
// 📷 PASSPORT OCR — Tesseract.js + MRZ parser (ICAO 9303 TD3)
// ════════════════════════════════════════════════════════════════════
let passportData = null;

// ISO 3166-1 alpha-3 → Arabic country names (most common nationalities in Libya context)
const COUNTRY_MAP = {
  LBY:'ليبي', LIB:'ليبي', LBN:'لبناني', EGY:'مصري', SDN:'سوداني',
  TUN:'تونسي', DZA:'جزائري', MAR:'مغربي', MRT:'موريتاني',
  SAU:'سعودي', JOR:'أردني', SYR:'سوري', YEM:'يمني', IRQ:'عراقي',
  PSE:'فلسطيني', QAT:'قطري', OMN:'عماني', BHR:'بحريني', KWT:'كويتي', ARE:'إماراتي',
  TUR:'تركي', PAK:'باكستاني', IND:'هندي', BGD:'بنغلاديشي', PHL:'فلبيني',
  USA:'أمريكي', GBR:'بريطاني', FRA:'فرنسي', DEU:'ألماني', ITA:'إيطالي', ESP:'إسباني',
  CHN:'صيني', JPN:'ياباني', KOR:'كوري', RUS:'روسي',
  NGA:'نيجيري', GHA:'غاني', ETH:'إثيوبي', KEN:'كيني', TCD:'تشادي', NER:'نيجري', MLI:'مالي',
};

// Character ambiguity correction: MRZ has FIXED positions where chars must be digits OR letters
const TO_DIGIT = {O:'0', Q:'0', D:'0', I:'1', L:'1', T:'1', Z:'2', E:'2', A:'4', S:'5', G:'6', B:'8', U:'0'};
const TO_LETTER = {'0':'O', '1':'I', '2':'Z', '4':'A', '5':'S', '6':'G', '8':'B', '7':'T'};

function forceDigit(c) { return TO_DIGIT[c] || c; }
function forceLetter(c) { return TO_LETTER[c] || c; }

// ICAO 9303 MRZ check digit
function mrzCheckDigit(s) {
  const weights = [7, 3, 1];
  const charVal = c => {
    if(c >= '0' && c <= '9') return parseInt(c);
    if(c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
    return 0; // '<'
  };
  let sum = 0;
  for(let i = 0; i < s.length; i++) sum += charVal(s[i]) * weights[i % 3];
  return sum % 10;
}

// Enforce digit positions in MRZ line 2
function correctLine2(line) {
  if(line.length < 28) return line;
  const c = line.split('');
  c[9] = forceDigit(c[9]);                            // pp check
  for(let i = 10; i <= 12; i++) c[i] = forceLetter(c[i]);  // nationality
  for(let i = 13; i <= 18; i++) c[i] = forceDigit(c[i]);   // DOB
  c[19] = forceDigit(c[19]);                          // DOB check
  if(!/[MF<]/.test(c[20])) {
    if(c[20] === 'H' || c[20] === 'N') c[20] = 'M';
    else if(c[20] === 'E' || c[20] === 'P') c[20] = 'F';
  }
  for(let i = 21; i <= 26; i++) c[i] = forceDigit(c[i]);   // expiry
  c[27] = forceDigit(c[27]);                          // expiry check
  return c.join('');
}

function correctLine1(line) {
  if(line.length < 5) return line;
  const c = line.split('');
  if(c[0] !== 'P') c[0] = 'P';
  for(let i = 2; i <= 4; i++) if(c[i] !== '<') c[i] = forceLetter(c[i]);
  return c.join('');
}

// Fix passport number via check digit (try swapping ambiguous chars)
function fixPassportNumber(num, expectedCheck) {
  const padded = num.padEnd(9, '<');
  if(mrzCheckDigit(padded) === expectedCheck) return num;
  const swaps = [['0','O'],['O','0'],['1','I'],['I','1'],['8','B'],['B','8'],['5','S'],['S','5'],['2','Z'],['Z','2'],['6','G'],['G','6']];
  for(let i = 0; i < padded.length; i++) {
    for(const [a, b] of swaps) {
      if(padded[i] === a) {
        const cand = padded.slice(0,i) + b + padded.slice(i+1);
        if(mrzCheckDigit(cand) === expectedCheck) return cand.replace(/</g, '');
      }
    }
  }
  return num;
}

function parseMrzDate(s, isExpiry) {
  // YYMMDD format. For DOB: 00-30 → 2000s, 31-99 → 1900s. For expiry: always 2000s
  if(!/^\d{6}$/.test(s)) return '';
  const yy = parseInt(s.slice(0,2));
  const mm = s.slice(2,4);
  const dd = s.slice(4,6);
  let yyyy;
  if(isExpiry) yyyy = 2000 + yy;
  else yyyy = yy <= 30 ? 2000 + yy : 1900 + yy;
  // Validate
  const test = new Date(`${yyyy}-${mm}-${dd}`);
  if(isNaN(test)) return '';
  return `${yyyy}-${mm}-${dd}`;
}

function cleanMrzLine(line) {
  // Tesseract often confuses these in MRZ context
  return line.toUpperCase()
    .replace(/[^A-Z0-9<]/g, '')
    .replace(/\s/g, '');
}

function parseMRZ(text) {
  // Find the two MRZ lines (TD3 format = 44 chars each)
  const lines = text.split('\n').map(l => cleanMrzLine(l)).filter(l => l.length >= 30);
  // Look for the line starting with P< or P followed by 3 letters
  let line1 = null, line2 = null;
  for(let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i];
    const nxt = lines[i+1];
    if((cur.startsWith('P<') || /^P[A-Z<]/.test(cur)) && cur.length >= 30 && nxt.length >= 30) {
      line1 = cur; line2 = nxt;
      break;
    }
  }
  if(!line1 || !line2) {
    // Fallback: take the 2 longest <-containing lines
    const candidates = lines.filter(l => l.includes('<') && l.length >= 30).sort((a,b) => b.length - a.length);
    if(candidates.length >= 2) { line1 = candidates[0]; line2 = candidates[1]; }
  }
  if(!line1 || !line2) return null;

  // Pad to 44 chars
  line1 = (line1 + '<'.repeat(44)).slice(0, 44);
  line2 = (line2 + '<'.repeat(44)).slice(0, 44);

  // ↓ Apply position-based character corrections (fixes O↔0, I↔1, B↔8, S↔5 etc.)
  line1 = correctLine1(line1);
  line2 = correctLine2(line2);

  // Parse LINE 1: P<ISSUER<SURNAME<<GIVEN<NAMES<<<<
  const issuer = line1.slice(2, 5).replace(/</g, '');
  const namesPart = line1.slice(5);
  const nameSep = namesPart.indexOf('<<');
  let surname = '', given = '';
  if(nameSep > 0) {
    surname = namesPart.slice(0, nameSep).replace(/</g, ' ').trim();
    given = namesPart.slice(nameSep + 2).replace(/</g, ' ').replace(/\s+/g, ' ').trim();
  } else {
    surname = namesPart.replace(/</g, ' ').trim();
  }

  // Parse LINE 2: PassportNumber(9) CheckDigit(1) Nationality(3) DOB(6) Check(1) Sex(1) Expiry(6) Check(1) ...
  let ppNum = line2.slice(0, 9).replace(/</g, '');
  const ppCheck = parseInt(line2.slice(9, 10)) || 0;
  ppNum = fixPassportNumber(ppNum, ppCheck);  // ← uses check digit to repair OCR errors
  const nationality = line2.slice(10, 13).replace(/</g, '');
  const dobRaw = line2.slice(13, 19);
  const sexChar = line2.slice(20, 21);
  const expRaw = line2.slice(21, 27);

  const fullName = (given + ' ' + surname).replace(/\s+/g, ' ').trim();
  const dob = parseMrzDate(dobRaw, false);
  const exp = parseMrzDate(expRaw, true);
  let sex = '';
  if(sexChar === 'M') sex = 'ذكر';
  else if(sexChar === 'F') sex = 'أنثى';

  // Confidence checks
  const dobOK = mrzCheckDigit(dobRaw) === (parseInt(line2[19]) || -1);
  const expOK = mrzCheckDigit(expRaw) === (parseInt(line2[27]) || -1);
  const ppOK = mrzCheckDigit(ppNum.padEnd(9, '<')) === ppCheck;

  return {
    rawMrz: line1 + '\n' + line2,
    name: fullName, surname, given,
    passportNum: ppNum,
    nationality: COUNTRY_MAP[nationality] || nationality,
    nationalityCode: nationality,
    dob, exp, sex, issuer,
    checks: { dob: dobOK, exp: expOK, pp: ppOK }
  };
}

function openPassportScan() {
  // Reset modal state
  document.getElementById('pp-step1').style.display = 'block';
  document.getElementById('pp-loading').style.display = 'none';
  document.getElementById('pp-step2').style.display = 'none';
  document.getElementById('pp-apply').style.display = 'none';
  document.getElementById('pp-file').value = '';
  passportData = null;
  openOv('ov-passport');
}

async function handlePassportFile(ev) {
  const file = ev.target.files[0];
  if(!file) return;
  document.getElementById('pp-step1').style.display = 'none';
  document.getElementById('pp-loading').style.display = 'flex';
  document.getElementById('pp-loading-t').textContent = 'جاري تحضير الصورة...';
  document.getElementById('pp-progress').textContent = '';

  // Show preview of original
  const reader = new FileReader();
  reader.onload = e => { document.getElementById('pp-preview').src = e.target.result; };
  reader.readAsDataURL(file);

  try {
    if(typeof Tesseract === 'undefined') throw new Error('محرك OCR لم يُحمَّل');

    // Crop to bottom 35% (MRZ zone) + grayscale + contrast boost
    const processed = await preprocessForMrz(file);

    document.getElementById('pp-loading-t').textContent = 'جاري تحميل محرك القراءة...';

    const { data } = await Tesseract.recognize(processed, 'eng', {
      logger: m => {
        if(m.status === 'recognizing text') {
          document.getElementById('pp-loading-t').textContent = 'جاري قراءة الـ MRZ...';
          document.getElementById('pp-progress').textContent = `${Math.round(m.progress * 100)}%`;
        } else if(m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
          document.getElementById('pp-loading-t').textContent = 'تهيئة محرك القراءة...';
        } else if(m.status === 'loading language traineddata') {
          document.getElementById('pp-loading-t').textContent = 'تحميل بيانات اللغة...';
        }
      },
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
      tessedit_pageseg_mode: '6',      // single uniform block — better for MRZ
      preserve_interword_spaces: '0'
    });

    const parsed = parseMRZ(data.text);
    if(!parsed) {
      // Show raw text so user can fix manually
      showPassportPreview({
        rawMrz: data.text.trim() || '(لم يُقرأ شيء)',
        name:'', passportNum:'', nationality:'', nationalityCode:'',
        dob:'', exp:'', sex:'', checks:{}
      }, true);
      toast('قراءة جزئية — عدّل الـ MRZ يدوياً وأعد التحليل', 'var(--amb)');
      return;
    }
    showPassportPreview(parsed);
  } catch(e) {
    console.error('Passport OCR:', e);
    toast('فشل تحليل الجواز: ' + (e.message || e), 'var(--red)');
    document.getElementById('pp-step1').style.display = 'block';
    document.getElementById('pp-loading').style.display = 'none';
  }
}

// Crop to MRZ zone (bottom ~35%) + grayscale + boost contrast
async function preprocessForMrz(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const cropTop = Math.floor(img.height * 0.65);
      const cropH = img.height - cropTop;
      const scale = cropH < 200 ? 2 : 1;
      canvas.width = img.width * scale;
      canvas.height = cropH * scale;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, cropTop, img.width, cropH, 0, 0, canvas.width, canvas.height);
      // Grayscale + strong contrast
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = id.data;
      for(let i = 0; i < d.length; i += 4) {
        const gray = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        let v = (gray - 128) * 1.8 + 128;
        v = v < 100 ? 0 : v > 180 ? 255 : v;
        d[i] = d[i+1] = d[i+2] = v;
      }
      ctx.putImageData(id, 0, 0);
      canvas.toBlob(blob => resolve(blob), 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

function showPassportPreview(data, failedParse) {
  passportData = data;
  document.getElementById('pp-loading').style.display = 'none';
  document.getElementById('pp-step2').style.display = 'block';
  document.getElementById('pp-apply').style.display = 'inline-flex';
  // EDITABLE MRZ — user can fix OCR mistakes and re-parse
  const mrzEl = document.getElementById('pp-mrz');
  mrzEl.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.id = 'pp-mrz-input';
  ta.value = data.rawMrz || '';
  ta.style.cssText = 'width:100%;background:transparent;border:none;outline:none;color:var(--t1);font-family:JetBrains Mono,monospace;font-size:11px;line-height:1.7;direction:ltr;text-align:left;resize:vertical;min-height:60px';
  ta.rows = 3;
  ta.spellcheck = false;
  mrzEl.appendChild(ta);
  const btn = document.createElement('button');
  btn.className = 'btn bg btn-xs';
  btn.style.marginTop = '6px';
  btn.textContent = '↻ إعادة التحليل بعد التعديل';
  btn.onclick = reparseMrz;
  mrzEl.appendChild(btn);

  document.getElementById('pp-name').value = data.name || '';
  document.getElementById('pp-num').value = data.passportNum || '';
  document.getElementById('pp-nat').value = data.nationality || '';
  document.getElementById('pp-dob').value = data.dob || '';
  document.getElementById('pp-exp').value = data.exp || '';
  document.getElementById('pp-gender').value = data.sex || '';

  // Check-digit validation badges
  const stat = document.getElementById('pp-status');
  if(failedParse) {
    stat.innerHTML = '<span class="bx xr">✗ تعذّر التحليل</span> عدّل الـ MRZ ثم اضغط "إعادة التحليل"';
  } else {
    const c = data.checks || {};
    const passed = [c.pp && 'الرقم', c.dob && 'الميلاد', c.exp && 'الانتهاء'].filter(Boolean);
    const failed = [!c.pp && 'الرقم', !c.dob && 'الميلاد', !c.exp && 'الانتهاء'].filter(Boolean);
    let badge;
    if(passed.length === 3) badge = '<span class="bx xg">✓ قراءة مؤكدة 100%</span>';
    else if(passed.length >= 1) badge = '<span class="bx xa">⚠ قراءة جزئية</span>';
    else badge = '<span class="bx xr">✗ بحاجة تحقق</span>';
    const okTxt = passed.length ? ` تحقق: ${passed.join(' · ')}` : '';
    const failTxt = failed.length ? ` — راجع: <span style="color:var(--amb)">${failed.join(' · ')}</span>` : '';
    stat.innerHTML = badge + `<span style="color:var(--t3);font-size:11px;margin-right:5px">${okTxt}${failTxt}</span>`;
  }
}

function reparseMrz() {
  const ta = document.getElementById('pp-mrz-input');
  if(!ta) return;
  const parsed = parseMRZ(ta.value);
  if(!parsed) {
    toast('الـ MRZ غير صالح — يجب سطرين بطول 44 حرف لكل سطر', 'var(--red)');
    return;
  }
  showPassportPreview(parsed);
  toast('✓ تم إعادة التحليل');
}

function applyPassportData() {
  // Push edited values into the employee form
  const name = document.getElementById('pp-name').value.trim();
  if(name) document.getElementById('ef-name').value = name;
  const num = document.getElementById('pp-num').value.trim();
  if(num) document.getElementById('ef-pp').value = num;
  const nat = document.getElementById('pp-nat').value.trim();
  if(nat) document.getElementById('ef-nat').value = nat;
  const dob = document.getElementById('pp-dob').value;
  if(dob) document.getElementById('ef-dob').value = dob;
  const exp = document.getElementById('pp-exp').value;
  if(exp) document.getElementById('ef-pp-exp').value = exp;
  const sex = document.getElementById('pp-gender').value;
  if(sex) document.getElementById('ef-gender').value = sex;
  closeOv('ov-passport');
  toast('✓ تم تطبيق بيانات الجواز — أكمل الحقول الناقصة');
}

window.addEventListener('DOMContentLoaded', () => {
  loadLS();
  loadTheme();
  // Set firebase indicator on login
  const fbEl = document.getElementById('l-fb-status');
  const fbText = document.getElementById('l-fb-text');
  if(firebaseReady) {
    fbEl.classList.add('l-fb-on');
    fbText.textContent = 'متصل بقاعدة البيانات السحابية';
  } else {
    fbEl.classList.add('l-fb-off');
    fbText.textContent = FB_CONFIGURED ? 'فشل الاتصال' : 'وضع محلي — اضبط Firebase';
  }
  setTimeout(()=>{
    document.getElementById('loading-screen').style.display='none';
    document.getElementById('login-screen').classList.add('show');
    document.getElementById('l-user').focus();
  }, 800);
});
