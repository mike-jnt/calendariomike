import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBsW0DFK9-kDlgLmZDw8elHeuUPkVwKKRg",
  authDomain: "controlmike-a565c.firebaseapp.com",
  projectId: "controlmike-a565c",
  storageBucket: "controlmike-a565c.firebasestorage.app",
  messagingSenderId: "730567058773",
  appId: "1:730567058773:web:e5942a5fcfb700ef2b3bdc",
  measurementId: "G-TH5VT9BQBJ"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const CLOUD_KEYS = ['clients','projects','milestones','tasks','payments','reviews','resources','activities'];
let currentUser = null;
let lastSyncedState = null;
let syncTimer = null;
let syncInFlight = false;
let syncRequested = false;

const STORAGE_KEY='mi_control_freelance_c1';
let state=loadState();
let currentProjectId=null;

const PROJECT_STATUS_LABELS={planificacion:'Planificación',en_curso:'En curso',esperando_cliente:'Esperando cliente',revision:'En revisión',correcciones:'Correcciones',pausado:'Pausado',entregado:'Entregado',finalizado:'Finalizado',cancelado:'Cancelado'};
const TASK_STATUS_LABELS={pendiente:'Pendiente',en_proceso:'En proceso',bloqueada:'Bloqueada',completada:'Completada'};
const MILESTONE_STATUS_LABELS={pendiente:'Pendiente',en_proceso:'En proceso',revision:'En revisión',completado:'Completado'};
const REVIEW_STATUS_LABELS={pendiente:'Pendiente',en_proceso:'En proceso',resuelta:'Resuelta'};

function localISODate(date=new Date()){const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0');return `${y}-${m}-${d}`}
function addLocalDays(n,base=new Date()){const d=new Date(base);d.setHours(12,0,0,0);d.setDate(d.getDate()+n);return localISODate(d)}
function parseDate(s){return new Date(`${s}T12:00:00`)}
function todayISO(){return localISODate(new Date())}
function daysUntil(s){return Math.round((parseDate(s)-parseDate(todayISO()))/86400000)}
function fmtDate(s){return s?parseDate(s).toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'numeric'}):'Sin fecha'}
function fmtDateTime(s){return new Date(s).toLocaleString('es-CO',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}
function money(n){return new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(Number(n||0))}
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))}
function capitalize(s=''){return s.charAt(0).toUpperCase()+s.slice(1)}
function safeUrl(url=''){const t=String(url).trim();if(!t)return '#';try{const u=new URL(/^https?:\/\//i.test(t)?t:`https://${t}`);return ['http:','https:'].includes(u.protocol)?u.href:'#'}catch{return '#'}}

function projectProgressLegacy(parsed,id){const ts=(parsed.tasks||[]).filter(t=>t.projectId===id);if(!ts.length)return 0;return Math.round(ts.filter(t=>t.done).length/ts.length*100)}
function migrateClients(parsed){
  parsed.clients ||= [];
  parsed.projects.forEach(p=>{
    if(p.clientId&&parsed.clients.some(c=>c.id===p.clientId))return;
    const name=(p.client||'').trim(); if(!name)return;
    let c=parsed.clients.find(x=>x.name.trim().toLowerCase()===name.toLowerCase()||x.company?.trim().toLowerCase()===name.toLowerCase());
    if(!c){c={id:crypto.randomUUID(),name,company:'',phone:'',email:'',notes:'',createdAt:new Date().toISOString()};parsed.clients.push(c)}
    p.clientId=c.id;
  });
}
function normalizeStateObject(p){
  p ||= {};
  p.projects ||= []; p.tasks ||= []; p.activities ||= []; p.milestones ||= []; p.clients ||= []; p.payments ||= []; p.reviews ||= []; p.resources ||= [];
  p.projects.forEach(x=>x.workflowStatus||=(projectProgressLegacy(p,x.id)===100?'finalizado':'en_curso'));
  p.tasks.forEach(t=>{t.status||=(t.done?'completada':'pendiente');t.done=t.status==='completada';t.milestoneId||='';t.blockerReason||=''});
  migrateClients(p);
  return p;
}
function emptyState(){return {clients:[],projects:[],milestones:[],tasks:[],payments:[],reviews:[],resources:[],activities:[]}}
function cloneState(x){return JSON.parse(JSON.stringify(x))}
function cloudHasData(x){return CLOUD_KEYS.some(k=>(x[k]||[]).length>0)}
function setSyncStatus(mode,text){
  const dot=document.getElementById('syncDot'),title=document.getElementById('syncTitle'),label=document.getElementById('syncText');
  if(!dot||!title||!label)return;
  dot.className='status-dot '+(mode||''); title.textContent=mode==='error'?'Firebase':'Firebase'; label.textContent=text;
}
function scheduleCloudSync(){
  if(!currentUser)return;
  clearTimeout(syncTimer);
  setSyncStatus(navigator.onLine?'syncing':'offline',navigator.onLine?'Cambios pendientes…':'Sin conexión · guardado local');
  syncTimer=setTimeout(()=>syncStateToCloud(),550);
}
async function loadCloudState(uid){
  const out=emptyState();
  await Promise.all(CLOUD_KEYS.map(async key=>{
    const snap=await getDocs(collection(db,'users',uid,key));
    out[key]=snap.docs.map(d=>({id:d.id,...d.data()}));
  }));
  return normalizeStateObject(out);
}
async function syncStateToCloud(force=false){
  if(!currentUser)return;
  if(!navigator.onLine){setSyncStatus('offline','Sin conexión · guardado local');return}
  if(syncInFlight){syncRequested=true;return}
  syncInFlight=true; syncRequested=false;
  setSyncStatus('syncing','Sincronizando…');
  try{
    const before=force?emptyState():(lastSyncedState||emptyState());
    const operations=[];
    for(const key of CLOUD_KEYS){
      const oldMap=new Map((before[key]||[]).map(x=>[x.id,x]));
      const newMap=new Map((state[key]||[]).map(x=>[x.id,x]));
      for(const [id,item] of newMap){
        const old=oldMap.get(id);
        if(force||!old||JSON.stringify(old)!==JSON.stringify(item))operations.push(()=>setDoc(doc(db,'users',currentUser.uid,key,id),item));
      }
      for(const [id] of oldMap){if(!newMap.has(id))operations.push(()=>deleteDoc(doc(db,'users',currentUser.uid,key,id)))}
    }
    for(let i=0;i<operations.length;i+=75)await Promise.all(operations.slice(i,i+75).map(fn=>fn()));
    await setDoc(doc(db,'users',currentUser.uid),{schemaVersion:'2.0',updatedAt:serverTimestamp(),email:currentUser.email||''},{merge:true});
    lastSyncedState=cloneState(state);
    setSyncStatus('online',operations.length?`Sincronizado · ${new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'})}`:'Todo sincronizado');
  }catch(err){
    console.error('Error sincronizando Firebase:',err);
    setSyncStatus('error','Error de sincronización · datos guardados localmente');
  }finally{
    syncInFlight=false;
    if(syncRequested){syncRequested=false;scheduleCloudSync()}
  }
}

function loadState(){
  const raw=localStorage.getItem(STORAGE_KEY);
  if(raw){try{return normalizeStateObject(JSON.parse(raw))}catch(e){}}
  const clientId=crypto.randomUUID(),projectId=crypto.randomUUID(),milestoneId=crypto.randomUUID();
  return {clients:[{id:clientId,name:'Cliente demo',company:'Empresa de ejemplo',phone:'',email:'',notes:'Ficha creada para mostrar el módulo clientes.',createdAt:new Date().toISOString()}],projects:[{id:projectId,name:'Proyecto de ejemplo',client:'Cliente demo',clientId,startDate:addLocalDays(-2),dueDate:addLocalDays(7),priority:'alta',workflowStatus:'en_curso',value:1200000,notes:'Proyecto cargado como ejemplo para probar el sistema.',createdAt:new Date().toISOString()}],milestones:[{id:milestoneId,projectId,title:'Primera entrega',dueDate:addLocalDays(4),status:'en_proceso',notes:'Dejar lista una primera versión para revisión.',createdAt:new Date().toISOString()}],tasks:[{id:crypto.randomUUID(),projectId,milestoneId,title:'Definir alcance y entregables',dueDate:addLocalDays(1),priority:'alta',status:'completada',done:true,blockerReason:'',notes:'Confirmar con el cliente los puntos principales.',createdAt:new Date().toISOString()},{id:crypto.randomUUID(),projectId,milestoneId,title:'Preparar primera entrega',dueDate:addLocalDays(3),priority:'alta',status:'en_proceso',done:false,blockerReason:'',notes:'Dejar lista la versión para revisión.',createdAt:new Date().toISOString()}],payments:[],reviews:[],resources:[],activities:[{id:crypto.randomUUID(),type:'project_created',projectId,text:'Proyecto creado',at:new Date().toISOString()}]}
}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));renderAll();if(currentProjectId)renderProjectDetail(currentProjectId);scheduleCloudSync()}

function projectById(id){return state.projects.find(p=>p.id===id)}
function taskById(id){return state.tasks.find(t=>t.id===id)}
function milestoneById(id){return state.milestones.find(m=>m.id===id)}
function clientById(id){return state.clients.find(c=>c.id===id)}
function reviewById(id){return state.reviews.find(r=>r.id===id)}
function projectTasks(id){return state.tasks.filter(t=>t.projectId===id)}
function projectMilestones(id){return state.milestones.filter(m=>m.projectId===id).sort((a,b)=>parseDate(a.dueDate)-parseDate(b.dueDate))}
function milestoneTasks(id){return state.tasks.filter(t=>t.milestoneId===id)}
function projectActivities(id){return state.activities.filter(a=>a.projectId===id).sort((a,b)=>new Date(b.at)-new Date(a.at))}
function projectPayments(id){return state.payments.filter(x=>x.projectId===id).sort((a,b)=>parseDate(b.date)-parseDate(a.date))}
function projectReviews(id){return state.reviews.filter(x=>x.projectId===id).sort((a,b)=>parseDate(b.date)-parseDate(a.date))}
function projectResources(id){return state.resources.filter(x=>x.projectId===id)}
function clientProjects(id){return state.projects.filter(p=>p.clientId===id)}
function isTaskComplete(t){return t.status==='completada'||t.done===true}
function isProjectClosed(p){return ['finalizado','cancelado'].includes(p.workflowStatus)}
function projectProgress(id){const ts=projectTasks(id);if(ts.length)return Math.round(ts.filter(isTaskComplete).length/ts.length*100);const ms=projectMilestones(id);if(ms.length)return Math.round(ms.filter(m=>m.status==='completado').length/ms.length*100);return 0}
function milestoneProgress(id){const ts=milestoneTasks(id);if(!ts.length)return milestoneById(id)?.status==='completado'?100:0;return Math.round(ts.filter(isTaskComplete).length/ts.length*100)}
function projectPaid(id){return projectPayments(id).reduce((s,p)=>s+Number(p.amount||0),0)}
function projectBalance(id){const p=projectById(id);return Math.max(0,Number(p?.value||0)-projectPaid(id))}
function clientPaid(id){return clientProjects(id).reduce((s,p)=>s+projectPaid(p.id),0)}
function clientBilled(id){return clientProjects(id).reduce((s,p)=>s+Number(p.value||0),0)}
function clientBalance(id){return Math.max(0,clientBilled(id)-clientPaid(id))}
function projectClientName(p){const c=clientById(p.clientId);return c?(c.company||c.name):(p.client||'Sin cliente')}
function ensureClientForProject(p){const name=(p.client||'').trim();if(!name){p.clientId='';return}let c=state.clients.find(x=>x.name.trim().toLowerCase()===name.toLowerCase()||x.company?.trim().toLowerCase()===name.toLowerCase());if(!c){c={id:crypto.randomUUID(),name,company:'',phone:'',email:'',notes:'Creado automáticamente desde un proyecto.',createdAt:new Date().toISOString()};state.clients.push(c)}p.clientId=c.id}
function logActivity(projectId,type,text){state.activities.unshift({id:crypto.randomUUID(),type,projectId,text,at:new Date().toISOString()})}

function statusInfo(project){if(project.workflowStatus==='cancelado')return{text:'Cancelado',cls:'gray'};if(project.workflowStatus==='finalizado')return{text:'Finalizado',cls:'green'};if(project.workflowStatus==='pausado'||project.workflowStatus==='esperando_cliente')return{text:PROJECT_STATUS_LABELS[project.workflowStatus],cls:'blue'};const progress=projectProgress(project.id),d=daysUntil(project.dueDate);if(d<0)return{text:'Atrasado',cls:'red'};if(d<=2&&progress<80)return{text:'En riesgo',cls:'orange'};if(d<=5&&progress<90)return{text:'Atención',cls:'yellow'};return{text:'Al día',cls:'green'}}
function taskUrgency(t){if(isTaskComplete(t))return{text:'Completada',cls:'green',rank:99};if(t.status==='bloqueada')return{text:'Bloqueada',cls:'purple',rank:2};const d=daysUntil(t.dueDate);if(d<0)return{text:`Atrasada ${Math.abs(d)}d`,cls:'red',rank:0};if(d===0)return{text:'Hoy',cls:'red',rank:1};if(d===1)return{text:'Mañana',cls:'orange',rank:3};if(d<=3)return{text:`En ${d} días`,cls:'yellow',rank:4};return{text:fmtDate(t.dueDate),cls:'gray',rank:10+d}}

function icon(name){const i={alert:'<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',clock:'<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',money:'<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 12h.01M17 12h.01"/>',priority:'<path d="M12 3v13M5 6h7l3 3-3 3H5z"/><circle cx="12" cy="19" r="2"/>',folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/>',tasks:'<path d="M9 11l2 2 4-4"/><rect x="4" y="4" width="16" height="16" rx="2"/>',history:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',note:'<path d="M5 3h11l3 3v15H5z"/><path d="M16 3v4h4M8 11h8M8 15h8"/>',arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>',plus:'<path d="M12 5v14M5 12h14"/>',layers:'<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',lock:'<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',play:'<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2"/><path d="M16 14a5 5 0 0 1 5 5"/>',link:'<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',message:'<path d="M4 5h16v11H8l-4 4z"/>',card:'<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>'};return `<span class="inline-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${i[name]||''}</svg></span>`}

const els={title:document.getElementById('viewTitle'),subtitle:document.getElementById('viewSubtitle'),dashboard:document.getElementById('dashboardView'),today:document.getElementById('todayView'),projects:document.getElementById('projectsView'),clients:document.getElementById('clientsView'),finances:document.getElementById('financesView'),tasks:document.getElementById('tasksView'),calendar:document.getElementById('calendarView'),detail:document.getElementById('projectDetailView'),backdrop:document.getElementById('modalBackdrop'),modal:document.getElementById('modal')};
function stat(iconName,label,value,hint,tone='blue'){const valueClass=String(value??'').length>8?' long-value':'';return `<div class="stat ${tone}"><div class="stat-icon">${icon(iconName)}</div><div class="stat-copy"><div class="label">${label}</div><div class="value${valueClass}">${value}</div><div class="hint">${hint}</div></div></div>`}
function renderAll(){renderDashboard();renderToday();renderProjects();renderClients();renderFinances();renderTasks();renderCalendar()}

function renderDashboard(){const active=state.projects.filter(p=>!isProjectClosed(p)),open=state.tasks.filter(t=>!isTaskComplete(t)),overdue=active.filter(p=>statusInfo(p).text==='Atrasado').length,dueToday=open.filter(t=>t.dueDate===todayISO()).length,blocked=open.filter(t=>t.status==='bloqueada').length,receivable=state.projects.reduce((s,p)=>s+projectBalance(p.id),0),urgent=[...open].sort((a,b)=>taskUrgency(a).rank-taskUrgency(b).rank).slice(0,6),risky=[...active].sort((a,b)=>daysUntil(a.dueDate)-daysUntil(b.dueDate)).slice(0,5);els.dashboard.innerHTML=`<div class="welcome-card"><div><span class="welcome-kicker">PANORAMA GENERAL</span><h2>Todo tu trabajo, clientes y cobros en un solo lugar.</h2><p>Controla avance, entregas, observaciones y dinero pendiente sin depender de la memoria.</p></div><div class="welcome-mark">MC</div></div><div class="stats stats-5">${stat('alert','Proyectos atrasados',overdue,'Requieren atención inmediata','red')}${stat('clock','Tareas para hoy',dueToday,'Pendientes con fecha de hoy','orange')}${stat('lock','Tareas bloqueadas',blocked,'Requieren destrabar algo','purple')}${stat('users','Clientes',state.clients.length,'Contactos registrados','blue')}${stat('money','Pendiente por cobrar',money(receivable),'Saldo total de proyectos','green')}</div><div class="grid-2"><div class="panel"><div class="section-head"><div><h2>${icon('priority')}Lo más urgente</h2><p>Atrasos, bloqueos y vencimientos</p></div><span>${open.length} abiertas</span></div>${urgent.length?urgent.map(t=>taskRow(t,true)).join(''):'<div class="empty">No tienes tareas pendientes.</div>'}</div><div class="panel"><div class="section-head"><div><h2>${icon('folder')}Proyectos activos</h2><p>Los próximos a requerir atención</p></div><span>${active.length} activos</span></div>${risky.length?risky.map(projectCard).join(''):'<div class="empty">Crea tu primer proyecto.</div>'}</div></div>`}
function taskRow(t,compact=false){const p=projectById(t.projectId),m=milestoneById(t.milestoneId),u=taskUrgency(t),status=t.status||'pendiente';return `<div class="task-row ${isTaskComplete(t)?'done ':''}${u.cls==='red'?'overdue ':u.cls==='orange'?'due-soon ':status==='bloqueada'?'blocked-task ':''}"><button class="task-state-dot state-${status}" onclick="cycleTaskStatus('${t.id}')" title="Cambiar estado"></button><div><div class="task-title">${escapeHtml(t.title)}</div><div class="meta">${escapeHtml(p?.name||'Sin proyecto')}${m?` · ${escapeHtml(m.title)}`:''} · <span class="priority-${t.priority}">${capitalize(t.priority)}</span> · ${TASK_STATUS_LABELS[status]}${t.blockerReason?` · Bloqueo: ${escapeHtml(t.blockerReason)}`:''}${t.notes&&!compact?` · ${escapeHtml(t.notes)}`:''}</div></div><div class="task-row-end"><span class="badge ${u.cls}">${u.text}</span>${compact?'':`<div class="row-actions"><button onclick="editTask('${t.id}')">Editar</button><button class="danger-text" onclick="deleteTask('${t.id}')">Eliminar</button></div>`}</div></div>`}
function projectCard(p){const progress=projectProgress(p.id),s=statusInfo(p),d=daysUntil(p.dueDate),pending=projectTasks(p.id).filter(t=>!isTaskComplete(t)).length,ms=projectMilestones(p.id).length,balance=projectBalance(p.id);return `<article class="project-card" onclick="openProject('${p.id}')"><div class="project-top"><div><div class="project-title">${escapeHtml(p.name)}</div><div class="meta">${escapeHtml(projectClientName(p))} · ${PROJECT_STATUS_LABELS[p.workflowStatus]}</div></div><span class="badge ${s.cls}">${s.text}</span></div><div class="project-data"><span>${fmtDate(p.dueDate)}</span><span>${ms} entregable${ms===1?'':'s'} · ${pending} tarea${pending===1?'':'s'} abierta${pending===1?'':'s'}</span></div><div class="progress"><span style="width:${progress}%"></span></div><div class="progress-line"><strong>${progress}% completado</strong><span>${d<0?`${Math.abs(d)} días atrasado`:d===0?'Vence hoy':`${d} días restantes`}</span></div><div class="project-finance-line"><span>Saldo</span><strong>${money(balance)}</strong></div><div class="card-open">Abrir proyecto ${icon('arrow')}</div></article>`}
function renderToday(){const open=state.tasks.filter(t=>!isTaskComplete(t)),critical=open.filter(t=>daysUntil(t.dueDate)<=1||t.status==='bloqueada').sort((a,b)=>taskUrgency(a).rank-taskUrgency(b).rank),next=open.filter(t=>!critical.includes(t)).sort((a,b)=>taskUrgency(a).rank-taskUrgency(b).rank).slice(0,8),now=new Date();els.today.innerHTML=`<div class="today-hero"><div><span>FOCO DEL DÍA</span><h2>${critical.length?`${critical.length} asunto${critical.length===1?'':'s'} requieren atención`:'Tu jornada está bajo control'}</h2><p>${critical.length?'Prioriza atrasos, bloqueos y lo que vence entre hoy y mañana.':'Puedes adelantar las siguientes tareas sin presión inmediata.'}</p></div><div class="hero-date">${now.toLocaleDateString('es-CO',{weekday:'long',day:'numeric',month:'long'})}</div></div><div class="grid-2"><div class="panel"><div class="section-head"><div><h2>${icon('alert')}Atención inmediata</h2><p>Atrasos, bloqueos, hoy y mañana</p></div></div>${critical.length?critical.map(t=>taskRow(t,true)).join(''):'<div class="empty">Nada crítico por ahora.</div>'}</div><div class="panel"><div class="section-head"><div><h2>${icon('arrow')}Siguiente en la fila</h2><p>Lo próximo que conviene adelantar</p></div></div>${next.length?next.map(t=>taskRow(t,true)).join(''):'<div class="empty">No hay tareas futuras registradas.</div>'}</div></div>`}
function renderProjects(){els.projects.innerHTML=`<div class="page-toolbar"><div><h2>Portafolio de proyectos</h2><p>Abre un proyecto para controlar tareas, entregables, revisiones, recursos y pagos.</p></div><span class="toolbar-chip">${state.projects.length} registrados</span></div><div class="projects-grid">${state.projects.length?state.projects.map(projectCard).join(''):'<div class="panel empty">Aún no hay proyectos.</div>'}</div>`}

function clientCard(c){const ps=clientProjects(c.id),active=ps.filter(p=>!isProjectClosed(p)).length,billed=clientBilled(c.id),balance=clientBalance(c.id);return `<div class="client-card"><div class="client-head"><div class="client-avatar">${escapeHtml((c.company||c.name||'C').slice(0,2).toUpperCase())}</div><div><h3>${escapeHtml(c.company||c.name)}</h3><p>${c.company?escapeHtml(c.name):'Cliente'}</p></div></div><div class="client-contact">${c.phone?`<span>${escapeHtml(c.phone)}</span>`:''}${c.email?`<span>${escapeHtml(c.email)}</span>`:''}${!c.phone&&!c.email?'<span>Sin datos de contacto</span>':''}</div><div class="client-metrics"><div><span>Proyectos</span><strong>${ps.length}</strong></div><div><span>Activos</span><strong>${active}</strong></div><div><span>Saldo</span><strong>${money(balance)}</strong></div></div><div class="client-actions"><button class="small-btn" onclick="editClient('${c.id}')">Editar</button>${ps[0]?`<button class="small-btn" onclick="openProject('${ps[0].id}')">Ver proyecto</button>`:''}</div></div>`}
function renderClients(){const totalBalance=state.clients.reduce((s,c)=>s+clientBalance(c.id),0);els.clients.innerHTML=`<div class="page-toolbar"><div><h2>Clientes</h2><p>Centraliza contactos, proyectos y saldos pendientes.</p></div><button class="btn primary compact" onclick="openClientModal()">${icon('plus')}Nuevo cliente</button></div><div class="mini-summary"><div><span>Clientes registrados</span><strong>${state.clients.length}</strong></div><div><span>Total facturado</span><strong>${money(state.projects.reduce((s,p)=>s+Number(p.value||0),0))}</strong></div><div><span>Pendiente por cobrar</span><strong>${money(totalBalance)}</strong></div></div><div class="clients-grid">${state.clients.length?state.clients.map(clientCard).join(''):'<div class="panel empty">Aún no hay clientes.</div>'}</div>`}
function renderFinances(){const billed=state.projects.reduce((s,p)=>s+Number(p.value||0),0),paid=state.payments.reduce((s,p)=>s+Number(p.amount||0),0),balance=Math.max(0,billed-paid),payments=[...state.payments].sort((a,b)=>parseDate(b.date)-parseDate(a.date));els.finances.innerHTML=`<div class="page-toolbar"><div><h2>Finanzas</h2><p>Controla lo contratado, lo recibido y lo que todavía debes cobrar.</p></div><button class="btn primary compact" onclick="openPaymentModal()">${icon('plus')}Registrar pago</button></div><div class="mini-summary"><div><span>Valor contratado</span><strong>${money(billed)}</strong></div><div><span>Total recibido</span><strong>${money(paid)}</strong></div><div><span>Pendiente por cobrar</span><strong>${money(balance)}</strong></div></div><div class="panel"><div class="section-head"><div><h2>${icon('money')}Movimientos</h2><p>Pagos y abonos registrados</p></div></div><div class="payment-list">${payments.length?payments.map(paymentRow).join(''):'<div class="empty">Aún no hay pagos registrados.</div>'}</div></div>`}
function paymentRow(x){const p=projectById(x.projectId);return `<div class="payment-row"><div><strong>${money(x.amount)}</strong><span>${escapeHtml(p?.name||'Proyecto eliminado')} · ${escapeHtml(x.method||'')}</span></div><div class="payment-row-end"><span>${fmtDate(x.date)}</span><button onclick="deletePayment('${x.id}')">Eliminar</button></div></div>`}
function renderTasks(){const ts=[...state.tasks].sort((a,b)=>Number(isTaskComplete(a))-Number(isTaskComplete(b))||taskUrgency(a).rank-taskUrgency(b).rank);els.tasks.innerHTML=`<div class="page-toolbar"><div><h2>Todas las tareas</h2><p>Edita, elimina o cambia el estado de cualquier tarea.</p></div><span class="toolbar-chip">${ts.filter(t=>!isTaskComplete(t)).length} abiertas</span></div><div class="panel task-list">${ts.length?ts.map(t=>taskRow(t,false)).join(''):'<div class="empty">Aún no hay tareas.</div>'}</div>`}
function renderCalendar(){const cells=[],start=parseDate(todayISO());for(let i=0;i<14;i++){const d=new Date(start);d.setDate(d.getDate()+i);const iso=localISODate(d),ts=state.tasks.filter(t=>t.dueDate===iso),ms=state.milestones.filter(m=>m.dueDate===iso);cells.push(`<div class="cal-cell ${iso===todayISO()?'today-cell':''}"><div class="cal-date">${d.toLocaleDateString('es-CO',{weekday:'short',day:'2-digit',month:'short'})}</div>${ms.map(m=>`<div class="cal-milestone">Entrega: ${escapeHtml(m.title)}</div>`).join('')}${ts.map(t=>`<div class="cal-task ${isTaskComplete(t)?'complete':''}">${escapeHtml(t.title)}</div>`).join('')}${!ts.length&&!ms.length?'<div class="cal-empty">Sin compromisos</div>':''}</div>`)}els.calendar.innerHTML=`<div class="panel"><div class="section-head"><div><h2>${icon('calendar')}Próximos 14 días</h2><p>Tareas y entregables en una sola vista</p></div></div><div class="calendar-grid">${cells.join('')}</div></div>`}

function milestoneCard(m){const ts=milestoneTasks(m.id),progress=milestoneProgress(m.id),pending=ts.filter(t=>!isTaskComplete(t)).length,d=daysUntil(m.dueDate);return `<div class="milestone-card"><div class="milestone-head"><div><span class="micro-label">ENTREGABLE</span><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.notes||'Sin descripción')}</p></div><span class="status-pill status-${m.status}">${MILESTONE_STATUS_LABELS[m.status]}</span></div><div class="milestone-meta"><span>${fmtDate(m.dueDate)}</span><span>${d<0?`${Math.abs(d)} días atrasado`:d===0?'Entrega hoy':`${d} días restantes`}</span><span>${pending} tareas abiertas</span></div><div class="progress"><span style="width:${progress}%"></span></div><div class="milestone-actions"><button class="small-btn" onclick="openTaskModal('${m.projectId}','${m.id}')">+ Tarea</button><button class="small-btn" onclick="editMilestone('${m.id}')">Editar</button><button class="small-btn danger-text" onclick="deleteMilestone('${m.id}')">Eliminar</button></div></div>`}
function reviewCard(r){return `<div class="review-card"><div class="review-head"><div><strong>${escapeHtml(r.title)}</strong><span>${fmtDate(r.date)} · ${escapeHtml(r.source)}</span></div><span class="status-pill status-${r.status==='resuelta'?'completado':r.status}">${REVIEW_STATUS_LABELS[r.status]}</span></div><p>${escapeHtml(r.feedback)}</p><div class="review-actions"><button class="small-btn" onclick="reviewToTask('${r.id}')">Crear tarea</button><button class="small-btn" onclick="toggleReview('${r.id}')">${r.status==='resuelta'?'Reabrir':'Marcar resuelta'}</button><button class="small-btn danger-text" onclick="deleteReview('${r.id}')">Eliminar</button></div></div>`}
function resourceCard(r){const url=safeUrl(r.url);return `<div class="resource-row"><div class="resource-icon">${icon('link')}</div><div><strong>${escapeHtml(r.label)}</strong><span>${escapeHtml(r.type)}${r.notes?` · ${escapeHtml(r.notes)}`:''}</span></div><div class="resource-actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Abrir</a><button onclick="deleteResource('${r.id}')">Eliminar</button></div></div>`}
function renderProjectDetail(id){const p=projectById(id);if(!p){showView('projects');return}currentProjectId=id;const tasks=projectTasks(id).sort((a,b)=>Number(isTaskComplete(a))-Number(isTaskComplete(b))||taskUrgency(a).rank-taskUrgency(b).rank),milestones=projectMilestones(id),activities=projectActivities(id),reviews=projectReviews(id),resources=projectResources(id),payments=projectPayments(id),progress=projectProgress(id),s=statusInfo(p),pending=tasks.filter(t=>!isTaskComplete(t)),inProgress=pending.find(t=>t.status==='en_proceso'),next=inProgress||pending.find(t=>t.status==='pendiente')||pending.find(t=>t.status==='bloqueada'),blocked=pending.filter(t=>t.status==='bloqueada'),lastProgress=activities.find(a=>a.type==='progress'),d=daysUntil(p.dueDate),paid=projectPaid(id),balance=projectBalance(id);els.detail.innerHTML=`<button class="back-btn" onclick="showView('projects')">← Volver a proyectos</button><div class="project-hero-detail"><div class="project-hero-main"><div class="project-icon-large">${icon('folder')}</div><div><div class="detail-label">PROYECTO · ${PROJECT_STATUS_LABELS[p.workflowStatus]}</div><h2>${escapeHtml(p.name)}</h2><p>${escapeHtml(projectClientName(p))}</p></div></div><div class="project-hero-actions"><span class="badge ${s.cls}">${s.text}</span><button class="btn secondary compact" onclick="editProject('${id}')">${icon('edit')}Editar</button><button class="btn secondary compact" onclick="openPaymentModal('${id}')">${icon('money')}Pago</button><button class="btn primary compact" onclick="openTaskModal('${id}')">${icon('plus')}Nueva tarea</button></div></div><div class="detail-stats detail-stats-5"><div class="detail-stat"><span>Progreso general</span><strong>${progress}%</strong><div class="progress"><span style="width:${progress}%"></span></div></div><div class="detail-stat"><span>Fecha de entrega</span><strong>${fmtDate(p.dueDate)}</strong><small>${d<0?`${Math.abs(d)} días de atraso`:d===0?'Entrega hoy':`${d} días restantes`}</small></div><div class="detail-stat"><span>Valor</span><strong>${money(p.value)}</strong><small>Contratado</small></div><div class="detail-stat"><span>Pagado</span><strong>${money(paid)}</strong><small>${payments.length} movimiento${payments.length===1?'':'s'}</small></div><div class="detail-stat"><span>Saldo</span><strong>${money(balance)}</strong><small>${balance?'Pendiente por cobrar':'Al día'}</small></div></div><div class="detail-grid"><div class="detail-main-column"><div class="panel resume-panel"><div class="section-head"><div><h2>${icon('play')}Continuar donde quedaste</h2><p>Contexto inmediato para retomar sin depender de la memoria</p></div></div><div class="resume-grid three"><div><span class="micro-label">ÚLTIMO AVANCE</span><p>${lastProgress?escapeHtml(lastProgress.text):'Aún no has registrado un avance manual.'}</p>${lastProgress?`<small>${fmtDateTime(lastProgress.at)}</small>`:''}</div><div><span class="micro-label">SIGUIENTE ACCIÓN</span><p>${next?escapeHtml(next.title):progress===100?'Proyecto completado.':'Agrega una tarea para definir el siguiente paso.'}</p>${next?`<small>${TASK_STATUS_LABELS[next.status]} · vence ${fmtDate(next.dueDate)}</small>`:''}</div><div><span class="micro-label">BLOQUEOS</span><p>${blocked.length?`${blocked.length} tarea${blocked.length===1?'':'s'} bloqueada${blocked.length===1?'':'s'}`:'Sin bloqueos registrados.'}</p>${blocked[0]?`<small>${escapeHtml(blocked[0].blockerReason||blocked[0].title)}</small>`:''}</div></div><button class="btn secondary full" onclick="logProgress('${id}')">${icon('history')}Registrar nuevo avance</button></div><div class="panel"><div class="section-head"><div><h2>${icon('layers')}Entregables / fases</h2><p>Divide el proyecto en hitos concretos</p></div><button class="small-btn" onclick="openMilestoneModal('${id}')">+ Nuevo entregable</button></div><div class="milestone-list">${milestones.length?milestones.map(milestoneCard).join(''):'<div class="empty">Aún no has creado entregables.</div>'}</div></div><div class="panel"><div class="section-head"><div><h2>${icon('tasks')}Tareas del proyecto</h2><p>${pending.length} abiertas de ${tasks.length}</p></div><button class="small-btn" onclick="openTaskModal('${id}')">+ Agregar tarea</button></div><div class="task-list">${tasks.length?tasks.map(t=>taskRow(t,false)).join(''):'<div class="empty">Este proyecto aún no tiene tareas.</div>'}</div></div><div class="panel"><div class="section-head"><div><h2>${icon('message')}Revisiones del cliente</h2><p>Observaciones, correcciones y solicitudes</p></div><button class="small-btn" onclick="openReviewModal('${id}')">+ Registrar revisión</button></div><div class="review-list">${reviews.length?reviews.map(reviewCard).join(''):'<div class="empty">No hay revisiones registradas.</div>'}</div></div></div><div class="detail-side-column"><div class="panel"><div class="section-head"><div><h2>${icon('link')}Recursos y enlaces</h2><p>Drive, GitHub, Firebase, Canva y más</p></div></div><div class="resource-list">${resources.length?resources.map(resourceCard).join(''):'<div class="empty small">Sin recursos guardados.</div>'}</div><button class="small-btn full-width" onclick="openResourceModal('${id}')">+ Agregar recurso</button></div><div class="panel"><div class="section-head"><div><h2>${icon('money')}Pagos</h2><p>Control financiero del proyecto</p></div></div><div class="finance-box"><span>Pagado</span><strong>${money(paid)}</strong><span>Saldo</span><strong class="${balance?'balance-due':'balance-ok'}">${money(balance)}</strong></div>${payments.slice(0,4).map(paymentRow).join('')}<button class="small-btn full-width" onclick="openPaymentModal('${id}')">Registrar pago</button></div><div class="panel"><div class="section-head"><div><h2>${icon('note')}Notas del proyecto</h2><p>Información que no debes olvidar</p></div></div><div class="project-notes">${p.notes?escapeHtml(p.notes).replace(/\n/g,'<br>'):'Sin notas registradas.'}</div><button class="small-btn full-width" onclick="editProject('${id}')">Editar información</button></div><div class="panel"><div class="section-head"><div><h2>${icon('history')}Historial</h2><p>Movimientos recientes</p></div></div><div class="timeline">${activities.length?activities.slice(0,18).map(activityItem).join(''):'<div class="empty small">Sin actividad registrada.</div>'}</div></div><button class="danger-zone" onclick="deleteProject('${id}')">Eliminar proyecto</button></div></div>`}
function activityItem(a){const labels={project_created:'Proyecto creado',project_updated:'Proyecto actualizado',project_status:'Estado del proyecto',task_created:'Tarea agregada',task_updated:'Tarea actualizada',task_status:'Estado de tarea',task_deleted:'Tarea eliminada',milestone_created:'Entregable creado',milestone_updated:'Entregable actualizado',milestone_deleted:'Entregable eliminado',progress:'Avance registrado',payment_created:'Pago registrado',payment_deleted:'Pago eliminado',review_created:'Revisión registrada',review_updated:'Revisión actualizada',review_deleted:'Revisión eliminada',resource_created:'Recurso agregado',resource_deleted:'Recurso eliminado'};return `<div class="timeline-item"><div class="timeline-dot"></div><div><strong>${labels[a.type]||'Actividad'}</strong><p>${escapeHtml(a.text)}</p><span>${fmtDateTime(a.at)}</span></div></div>`}

function openModal(html){els.modal.innerHTML=html;els.backdrop.classList.remove('hidden');els.modal.querySelectorAll('[data-close]').forEach(b=>b.onclick=closeModal)}
function closeModal(){els.backdrop.classList.add('hidden');els.modal.innerHTML=''}
function prepareTaskForm(f,projectId='',milestoneId=''){const sel=f.elements.projectId,mSel=f.elements.milestoneId;sel.innerHTML=state.projects.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');if(projectId)sel.value=projectId;function refresh(selected=''){const ms=projectMilestones(sel.value);mSel.innerHTML='<option value="">Sin entregable específico</option>'+ms.map(m=>`<option value="${m.id}">${escapeHtml(m.title)}</option>`).join('');if(selected)mSel.value=selected}refresh(milestoneId);sel.onchange=()=>refresh('');const status=f.elements.status,reason=f.elements.blockerReason;function sync(){reason.disabled=status.value!=='bloqueada';if(reason.disabled)reason.value='';reason.closest('label').classList.toggle('field-muted',reason.disabled)}status.onchange=sync;sync()}
function openProjectModal(){openModal(document.getElementById('projectFormTemplate').innerHTML);const f=document.getElementById('projectForm');f.startDate.value=todayISO();f.dueDate.value=addLocalDays(7);f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f)),id=crypto.randomUUID(),p={id,...x,value:Number(x.value||0),createdAt:new Date().toISOString()};ensureClientForProject(p);state.projects.push(p);logActivity(id,'project_created','Proyecto creado.');save();closeModal();openProject(id)}}
function editProject(id){const p=projectById(id);if(!p)return;openModal(document.getElementById('projectFormTemplate').innerHTML);const f=document.getElementById('projectForm');document.getElementById('projectFormTitle').textContent='Editar proyecto';document.getElementById('projectSubmitBtn').textContent='Guardar cambios';['name','client','startDate','dueDate','priority','workflowStatus','value','notes'].forEach(k=>{if(f.elements[k])f.elements[k].value=p[k]??''});f.onsubmit=e=>{e.preventDefault();const old=p.workflowStatus,x=Object.fromEntries(new FormData(f));Object.assign(p,x,{value:Number(x.value||0)});ensureClientForProject(p);logActivity(id,'project_updated','Se actualizaron los datos del proyecto.');if(old!==p.workflowStatus)logActivity(id,'project_status',`Estado: ${PROJECT_STATUS_LABELS[old]} → ${PROJECT_STATUS_LABELS[p.workflowStatus]}.`);save();closeModal()}}
function openMilestoneModal(projectId){openModal(document.getElementById('milestoneFormTemplate').innerHTML);const f=document.getElementById('milestoneForm'),p=projectById(projectId);f.dueDate.value=p?.dueDate||addLocalDays(7);f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f)),id=crypto.randomUUID();state.milestones.push({id,projectId,...x,createdAt:new Date().toISOString()});logActivity(projectId,'milestone_created',`Entregable creado: ${x.title}.`);save();closeModal()}}
function editMilestone(id){const m=milestoneById(id);if(!m)return;openModal(document.getElementById('milestoneFormTemplate').innerHTML);const f=document.getElementById('milestoneForm');document.getElementById('milestoneFormTitle').textContent='Editar entregable';document.getElementById('milestoneSubmitBtn').textContent='Guardar cambios';['title','dueDate','status','notes'].forEach(k=>f.elements[k].value=m[k]??'');f.onsubmit=e=>{e.preventDefault();Object.assign(m,Object.fromEntries(new FormData(f)));logActivity(m.projectId,'milestone_updated',`Entregable actualizado: ${m.title}.`);save();closeModal()}}
function deleteMilestone(id){const m=milestoneById(id);if(!m)return;const linked=milestoneTasks(id).length;if(!confirm(`¿Eliminar el entregable "${m.title}"?${linked?` Sus ${linked} tarea(s) quedarán sin entregable.`:''}`))return;state.tasks.forEach(t=>{if(t.milestoneId===id)t.milestoneId=''});state.milestones=state.milestones.filter(x=>x.id!==id);logActivity(m.projectId,'milestone_deleted',`Entregable eliminado: ${m.title}.`);save()}
function openTaskModal(projectId='',milestoneId=''){if(!state.projects.length){alert('Primero crea un proyecto.');return}openModal(document.getElementById('taskFormTemplate').innerHTML);const f=document.getElementById('taskForm');prepareTaskForm(f,projectId,milestoneId);f.dueDate.value=milestoneId?milestoneById(milestoneId)?.dueDate||addLocalDays(1):addLocalDays(1);f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f));if(x.status==='bloqueada'&&!x.blockerReason.trim()){alert('Indica el motivo del bloqueo.');return}state.tasks.push({id:crypto.randomUUID(),...x,done:x.status==='completada',createdAt:new Date().toISOString(),completedAt:x.status==='completada'?new Date().toISOString():null});logActivity(x.projectId,'task_created',`Tarea creada: ${x.title}.`);save();closeModal()}}
function editTask(id){const t=taskById(id);if(!t)return;openModal(document.getElementById('taskFormTemplate').innerHTML);const f=document.getElementById('taskForm');document.getElementById('taskFormTitle').textContent='Editar tarea';document.getElementById('taskSubmitBtn').textContent='Guardar cambios';prepareTaskForm(f,t.projectId,t.milestoneId);['title','projectId','milestoneId','dueDate','priority','status','blockerReason','notes'].forEach(k=>{if(f.elements[k])f.elements[k].value=t[k]??''});f.elements.status.dispatchEvent(new Event('change'));f.onsubmit=e=>{e.preventDefault();const oldProject=t.projectId,oldStatus=t.status,x=Object.fromEntries(new FormData(f));if(x.status==='bloqueada'&&!x.blockerReason.trim()){alert('Indica el motivo del bloqueo.');return}Object.assign(t,x,{done:x.status==='completada',completedAt:x.status==='completada'?(t.completedAt||new Date().toISOString()):null});logActivity(t.projectId,'task_updated',`Tarea actualizada: ${t.title}.`);if(oldStatus!==t.status)logActivity(t.projectId,'task_status',`${t.title}: ${TASK_STATUS_LABELS[oldStatus]} → ${TASK_STATUS_LABELS[t.status]}.`);if(oldProject!==t.projectId)logActivity(oldProject,'task_updated',`La tarea "${t.title}" se movió a otro proyecto.`);save();closeModal()}}
function cycleTaskStatus(id){const t=taskById(id);if(!t)return;const order=['pendiente','en_proceso','completada'];let next=order[(order.indexOf(t.status)+1)%order.length];if(t.status==='bloqueada')next='pendiente';const old=t.status;t.status=next;t.done=next==='completada';t.completedAt=t.done?new Date().toISOString():null;if(next!=='bloqueada')t.blockerReason='';logActivity(t.projectId,'task_status',`${t.title}: ${TASK_STATUS_LABELS[old]} → ${TASK_STATUS_LABELS[next]}.`);save()}
function deleteTask(id){const t=taskById(id);if(!t||!confirm(`¿Eliminar la tarea "${t.title}"?`))return;state.tasks=state.tasks.filter(x=>x.id!==id);logActivity(t.projectId,'task_deleted',`Tarea eliminada: ${t.title}.`);save()}
function openClientModal(){openModal(document.getElementById('clientFormTemplate').innerHTML);const f=document.getElementById('clientForm');f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f));state.clients.push({id:crypto.randomUUID(),...x,createdAt:new Date().toISOString()});save();closeModal()}}
function editClient(id){const c=clientById(id);if(!c)return;openModal(document.getElementById('clientFormTemplate').innerHTML);const f=document.getElementById('clientForm');document.getElementById('clientFormTitle').textContent='Editar cliente';document.getElementById('clientSubmitBtn').textContent='Guardar cambios';['name','company','phone','email','notes'].forEach(k=>f.elements[k].value=c[k]||'');f.onsubmit=e=>{e.preventDefault();Object.assign(c,Object.fromEntries(new FormData(f)));save();closeModal()}}
function openPaymentModal(projectId=''){if(!state.projects.length){alert('Primero crea un proyecto.');return}openModal(document.getElementById('paymentFormTemplate').innerHTML);const f=document.getElementById('paymentForm'),sel=f.elements.projectId;sel.innerHTML=state.projects.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} · saldo ${money(projectBalance(p.id))}</option>`).join('');if(projectId)sel.value=projectId;f.date.value=todayISO();f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f)),amount=Number(x.amount||0);if(amount<=0){alert('Ingresa un valor válido.');return}state.payments.push({id:crypto.randomUUID(),...x,amount,createdAt:new Date().toISOString()});logActivity(x.projectId,'payment_created',`Pago registrado por ${money(amount)}.`);save();closeModal()}}
function deletePayment(id){const x=state.payments.find(p=>p.id===id);if(!x||!confirm('¿Eliminar este pago?'))return;state.payments=state.payments.filter(p=>p.id!==id);logActivity(x.projectId,'payment_deleted',`Pago eliminado por ${money(x.amount)}.`);save()}
function openReviewModal(projectId){openModal(document.getElementById('reviewFormTemplate').innerHTML);const f=document.getElementById('reviewForm');f.date.value=todayISO();f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f));state.reviews.push({id:crypto.randomUUID(),projectId,...x,createdAt:new Date().toISOString()});logActivity(projectId,'review_created',`Revisión registrada: ${x.title}.`);save();closeModal()}}
function toggleReview(id){const r=reviewById(id);if(!r)return;r.status=r.status==='resuelta'?'pendiente':'resuelta';logActivity(r.projectId,'review_updated',`${r.title}: ${REVIEW_STATUS_LABELS[r.status]}.`);save()}
function reviewToTask(id){const r=reviewById(id);if(!r)return;state.tasks.push({id:crypto.randomUUID(),projectId:r.projectId,milestoneId:'',title:`Atender revisión: ${r.title}`,dueDate:addLocalDays(1),priority:'alta',status:'pendiente',done:false,blockerReason:'',notes:r.feedback,createdAt:new Date().toISOString(),completedAt:null});r.status='en_proceso';logActivity(r.projectId,'task_created',`Tarea creada desde revisión: ${r.title}.`);save()}
function deleteReview(id){const r=reviewById(id);if(!r||!confirm(`¿Eliminar la revisión "${r.title}"?`))return;state.reviews=state.reviews.filter(x=>x.id!==id);logActivity(r.projectId,'review_deleted',`Revisión eliminada: ${r.title}.`);save()}
function openResourceModal(projectId){openModal(document.getElementById('resourceFormTemplate').innerHTML);const f=document.getElementById('resourceForm');f.onsubmit=e=>{e.preventDefault();const x=Object.fromEntries(new FormData(f));if(safeUrl(x.url)==='#'){alert('Ingresa un enlace válido.');return}state.resources.push({id:crypto.randomUUID(),projectId,...x,createdAt:new Date().toISOString()});logActivity(projectId,'resource_created',`Recurso agregado: ${x.label}.`);save();closeModal()}}
function deleteResource(id){const r=state.resources.find(x=>x.id===id);if(!r||!confirm(`¿Eliminar el recurso "${r.label}"?`))return;state.resources=state.resources.filter(x=>x.id!==id);logActivity(r.projectId,'resource_deleted',`Recurso eliminado: ${r.label}.`);save()}
function deleteProject(id){const p=projectById(id);if(!p||!confirm(`¿Eliminar el proyecto "${p.name}" junto con sus tareas, entregables, pagos, revisiones, recursos e historial?`))return;state.projects=state.projects.filter(x=>x.id!==id);state.tasks=state.tasks.filter(x=>x.projectId!==id);state.milestones=state.milestones.filter(x=>x.projectId!==id);state.payments=state.payments.filter(x=>x.projectId!==id);state.reviews=state.reviews.filter(x=>x.projectId!==id);state.resources=state.resources.filter(x=>x.projectId!==id);state.activities=state.activities.filter(x=>x.projectId!==id);currentProjectId=null;save();showView('projects')}
function logProgress(id){const p=projectById(id),text=prompt(`Registrar avance en ${p.name}:\nEj. Terminé el módulo clientes. Falta conectar edición.`);if(!text)return;logActivity(id,'progress',text);save()}

function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));const map={dashboard:['Resumen','Organiza proyectos, clientes y cobros desde un solo lugar.'],today:['Hoy','Concéntrate en lo más importante de tu jornada.'],projects:['Proyectos','Visualiza tu portafolio activo y abre cada proyecto en detalle.'],clients:['Clientes','Centraliza contactos, proyectos y saldos pendientes.'],finances:['Finanzas','Controla pagos recibidos y dinero pendiente por cobrar.'],tasks:['Tareas','Gestiona estados, bloqueos y fechas de todas tus tareas.'],calendar:['Agenda','Anticipa tareas y entregables próximos.']};if(name==='projectDetail'){els.detail.classList.add('active');els.title.textContent='Detalle del proyecto';els.subtitle.textContent='Retoma el trabajo exactamente donde lo dejaste.';return}currentProjectId=null;document.getElementById(name+'View').classList.add('active');els.title.textContent=map[name][0];els.subtitle.textContent=map[name][1]}
function openProject(id){currentProjectId=id;renderProjectDetail(id);showView('projectDetail')}

Object.assign(window,{openTaskModal,editTask,deleteTask,cycleTaskStatus,deleteProject,logProgress,openProject,editProject,openMilestoneModal,editMilestone,deleteMilestone,showView,openClientModal,editClient,openPaymentModal,deletePayment,openReviewModal,toggleReview,reviewToTask,deleteReview,openResourceModal,deleteResource});
document.getElementById('newProjectBtn').onclick=openProjectModal;
document.getElementById('quickTaskBtn').onclick=()=>openTaskModal();
els.backdrop.addEventListener('click',e=>{if(e.target===els.backdrop)closeModal()});
document.querySelectorAll('.nav-btn').forEach(btn=>btn.onclick=()=>showView(btn.dataset.view));

const authScreen=document.getElementById('authScreen');
const appShell=document.getElementById('appShell');
const authForm=document.getElementById('authForm');
const authEmail=document.getElementById('authEmail');
const authPassword=document.getElementById('authPassword');
const togglePasswordBtn=document.getElementById('togglePasswordBtn');
const authMessage=document.getElementById('authMessage');
const registerBtn=document.getElementById('registerBtn');
const resetPasswordBtn=document.getElementById('resetPasswordBtn');
const logoutBtn=document.getElementById('logoutBtn');
const userEmail=document.getElementById('userEmail');

function authMsg(text,type=''){authMessage.textContent=text||'';authMessage.className='auth-message '+type}
function setPasswordVisible(visible){
  authPassword.type=visible?'text':'password';
  togglePasswordBtn.classList.toggle('showing',visible);
  togglePasswordBtn.setAttribute('aria-label',visible?'Ocultar contraseña':'Mostrar contraseña');
  togglePasswordBtn.title=visible?'Ocultar contraseña':'Mostrar contraseña';
}
togglePasswordBtn.addEventListener('click',()=>setPasswordVisible(authPassword.type==='password'));
function firebaseErrorMessage(err){
  const code=err?.code||'';
  const map={
    'auth/invalid-credential':'Correo o contraseña incorrectos.',
    'auth/user-not-found':'No existe una cuenta con ese correo.',
    'auth/wrong-password':'Contraseña incorrecta.',
    'auth/email-already-in-use':'Ese correo ya está registrado.',
    'auth/weak-password':'La contraseña debe tener al menos 6 caracteres.',
    'auth/invalid-email':'El correo electrónico no es válido.',
    'auth/too-many-requests':'Demasiados intentos. Espera un momento y vuelve a intentarlo.',
    'auth/network-request-failed':'No fue posible conectar con Firebase. Revisa tu conexión.'
  };
  return map[code]||`No fue posible completar la operación${code?` (${code})`:''}.`;
}
function setAuthBusy(busy){
  [...authForm.querySelectorAll('button,input')].forEach(el=>el.disabled=busy);
  if(busy)authMsg('Conectando con Firebase…');
}
function showAuthenticatedApp(user){
  authScreen.classList.add('auth-hidden');
  appShell.classList.remove('app-hidden');
  userEmail.textContent=user.email||'Cuenta Firebase';
}
function showLogin(){
  appShell.classList.add('app-hidden');
  authScreen.classList.remove('auth-hidden');
  authPassword.value='';
  setPasswordVisible(false);
  authMsg('');
  setSyncStatus('', 'C2.0 · esperando sesión');
}

authForm.addEventListener('submit',async e=>{
  e.preventDefault();setAuthBusy(true);
  try{await signInWithEmailAndPassword(auth,authEmail.value.trim(),authPassword.value)}
  catch(err){authMsg(firebaseErrorMessage(err),'error')}
  finally{setAuthBusy(false)}
});
registerBtn.addEventListener('click',async()=>{
  if(!authEmail.reportValidity()||!authPassword.reportValidity())return;
  if(!confirm('¿Crear una nueva cuenta con este correo? Los datos locales actuales se subirán a esa cuenta si todavía no tiene información en la nube.'))return;
  setAuthBusy(true);
  try{await createUserWithEmailAndPassword(auth,authEmail.value.trim(),authPassword.value)}
  catch(err){authMsg(firebaseErrorMessage(err),'error')}
  finally{setAuthBusy(false)}
});
resetPasswordBtn.addEventListener('click',async()=>{
  const email=authEmail.value.trim();
  if(!email){authMsg('Escribe primero tu correo electrónico.','error');authEmail.focus();return}
  try{await sendPasswordResetEmail(auth,email);authMsg('Te enviamos un correo para restablecer la contraseña.','success')}
  catch(err){authMsg(firebaseErrorMessage(err),'error')}
});
logoutBtn.addEventListener('click',async()=>{if(confirm('¿Cerrar sesión en Mi Control Freelance?'))await signOut(auth)});

window.addEventListener('offline',()=>setSyncStatus('offline','Sin conexión · guardado local'));
window.addEventListener('online',()=>{setSyncStatus('syncing','Conexión recuperada · sincronizando…');scheduleCloudSync()});

onAuthStateChanged(auth,async user=>{
  currentUser=user||null;
  if(!user){lastSyncedState=null;showLogin();return}
  showAuthenticatedApp(user);
  setSyncStatus('syncing','Cargando datos de Firebase…');
  try{
    const cloud=await loadCloudState(user.uid);
    if(cloudHasData(cloud)){
      state=normalizeStateObject(cloud);
      lastSyncedState=cloneState(state);
      localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
      setSyncStatus('online','Datos cargados y sincronizados');
    }else{
      state=normalizeStateObject(state);
      lastSyncedState=emptyState();
      await syncStateToCloud(true);
    }
  }catch(err){
    console.error('No se pudo cargar Firestore:',err);
    state=normalizeStateObject(state);
    lastSyncedState=null;
    setSyncStatus('error','No se pudo leer la nube · usando copia local');
  }
  renderAll();
  showView('dashboard');
});

