const root = document.getElementById('root');
const DB_NAME = 'book-scanner-db';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const PAGES = 'pages';
const A4 = { width: 595.28, height: 841.89 };
const encoder = new TextEncoder();

const state = {
  view: 'home', session: null, pages: [], stream: null, wakeLock: null,
  cameraError: '', saving: false, flash: false, captureMode: null,
  viewerPageId: null, pdf: null, pdfProgress: null, pdfError: '',
  storageWarning: '', dragId: null, dragTargetId: null,
};
let dbPromise = null;
let objectUrls = [];

const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmtDate = ms => new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(ms));
const fmtBytes = n => n < 1024*1024 ? `${Math.max(1,Math.round(n/1024))} KB` : `${(n/1024/1024).toFixed(1)} MB`;
const icon = (name, size=22) => {
  const p = {
    camera:'<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="4"/>',
    book:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
    pages:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h6"/>',
    trash:'<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    back:'<path d="m15 18-6-6 6-6"/>',
    rotateL:'<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8"/><path d="M4 3v5h5"/>',
    rotateR:'<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/>',
    download:'<path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14"/>',
    share:'<path d="M8 12 16 7M8 12l8 5"/><circle cx="5" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    more:'<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
    grip:'<path d="M9 7h.01M15 7h.01M9 12h.01M15 12h.01M9 17h.01M15 17h.01" stroke-width="3" stroke-linecap="round"/>',
  }[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
};

function reqP(req){ return new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);}); }
function txDone(tx){ return new Promise((res,rej)=>{tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error||new Error('Transaction aborted'));}); }
function openDb(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((res,rej)=>{
    const r=indexedDB.open(DB_NAME,DB_VERSION);
    r.onupgradeneeded=()=>{
      const db=r.result;
      if(!db.objectStoreNames.contains(SESSIONS)){
        const s=db.createObjectStore(SESSIONS,{keyPath:'id'}); s.createIndex('updatedAt','updatedAt'); s.createIndex('status','status');
      }
      if(!db.objectStoreNames.contains(PAGES)){
        const p=db.createObjectStore(PAGES,{keyPath:'id'}); p.createIndex('sessionId','sessionId'); p.createIndex('sessionPage',['sessionId','pageNumber'],{unique:true});
      }
    };
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
  });
  return dbPromise;
}
async function pagesInTx(store,sessionId){ return (await reqP(store.index('sessionId').getAll(IDBKeyRange.only(sessionId)))).sort((a,b)=>a.pageNumber-b.pageNumber); }
async function createSession(title, enhancement){
  const db=await openDb(), now=Date.now();
  const s={id:crypto.randomUUID(),title:title.trim()||'Untitled Book',createdAt:now,updatedAt:now,status:'active',pageCount:0,enhancement:!!enhancement};
  const tx=db.transaction(SESSIONS,'readwrite'); tx.objectStore(SESSIONS).add(s); await txDone(tx); return s;
}
async function listSessions(){ const db=await openDb(),tx=db.transaction(SESSIONS,'readonly'); const x=await reqP(tx.objectStore(SESSIONS).getAll()); await txDone(tx); return x.sort((a,b)=>b.updatedAt-a.updatedAt); }
async function getSession(id){const db=await openDb(),tx=db.transaction(SESSIONS,'readonly');const s=await reqP(tx.objectStore(SESSIONS).get(id));await txDone(tx);return s;}
async function getPages(id){const db=await openDb(),tx=db.transaction(PAGES,'readonly');const x=await pagesInTx(tx.objectStore(PAGES),id);await txDone(tx);return x;}
async function addPage(sessionId,payload,insertAt){
  const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES),ss=tx.objectStore(SESSIONS);
  const pages=await pagesInTx(ps,sessionId), pos=Math.max(1,Math.min(insertAt??pages.length+1,pages.length+1));
  for(const p of [...pages].reverse()) if(p.pageNumber>=pos){p.pageNumber++;ps.put(p);}
  const p={id:crypto.randomUUID(),sessionId,pageNumber:pos,imageBlob:payload.imageBlob,thumbnailBlob:payload.thumbnailBlob,width:payload.width,height:payload.height,rotation:0,capturedAt:Date.now()};
  ps.add(p); const s=await reqP(ss.get(sessionId)); s.pageCount=pages.length+1;s.updatedAt=Date.now();s.status='active';ss.put(s);await txDone(tx);return p;
}
async function replacePage(id,payload){
  const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES),ss=tx.objectStore(SESSIONS),p=await reqP(ps.get(id)); if(!p) throw Error('Page not found');
  Object.assign(p,{imageBlob:payload.imageBlob,thumbnailBlob:payload.thumbnailBlob,width:payload.width,height:payload.height,rotation:0,capturedAt:Date.now()}); ps.put(p);
  const s=await reqP(ss.get(p.sessionId));s.updatedAt=Date.now();s.status='active';ss.put(s);await txDone(tx);return p;
}
async function deletePage(id){
  const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES),ss=tx.objectStore(SESSIONS),p=await reqP(ps.get(id)); if(!p){tx.abort();return;}
  ps.delete(id); const pages=(await pagesInTx(ps,p.sessionId)).filter(x=>x.id!==id).sort((a,b)=>a.pageNumber-b.pageNumber);
  for(const x of pages){x.pageNumber+=1000000;ps.put(x);} pages.forEach((x,i)=>{x.pageNumber=i+1;ps.put(x);});
  const s=await reqP(ss.get(p.sessionId));s.pageCount=pages.length;s.updatedAt=Date.now();s.status='active';ss.put(s);await txDone(tx);
}
async function rotatePage(id,delta){
  const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES),ss=tx.objectStore(SESSIONS),p=await reqP(ps.get(id));
  p.rotation=((p.rotation+delta)%360+360)%360;ps.put(p);const s=await reqP(ss.get(p.sessionId));s.updatedAt=Date.now();ss.put(s);await txDone(tx);return p;
}
async function reorderPages(sessionId,ids){
  const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES),ss=tx.objectStore(SESSIONS),pages=await pagesInTx(ps,sessionId),map=new Map(pages.map(p=>[p.id,p]));
  const ordered=ids.map(id=>map.get(id)).filter(Boolean);if(ordered.length!==pages.length) throw Error('Reorder mismatch');
  for(const p of ordered){p.pageNumber+=1000000;ps.put(p);} ordered.forEach((p,i)=>{p.pageNumber=i+1;ps.put(p);}); const s=await reqP(ss.get(sessionId));s.updatedAt=Date.now();ss.put(s);await txDone(tx);
}
async function deleteSession(id){const db=await openDb(),tx=db.transaction([PAGES,SESSIONS],'readwrite'),ps=tx.objectStore(PAGES);for(const p of await pagesInTx(ps,id))ps.delete(p.id);tx.objectStore(SESSIONS).delete(id);await txDone(tx);}
async function setFinished(id){const db=await openDb(),tx=db.transaction(SESSIONS,'readwrite'),ss=tx.objectStore(SESSIONS),s=await reqP(ss.get(id));if(s){s.status='finished';s.updatedAt=Date.now();ss.put(s);}await txDone(tx);}

function clearUrls(){ objectUrls.forEach(URL.revokeObjectURL); objectUrls=[]; }
function blobUrl(blob){ const u=URL.createObjectURL(blob); objectUrls.push(u); return u; }
async function storageCheck(){
  if(!navigator.storage?.estimate) return;
  try{const {usage=0,quota=0}=await navigator.storage.estimate();const free=quota-usage;state.storageWarning=(quota && (free<250*1024*1024 || usage/quota>.88))?'Device storage is getting low. Export or free space before scanning many more pages.':'';}catch{}
}
async function persistStorage(){try{await navigator.storage?.persist?.();}catch{}}

async function stopCamera(){
  state.stream?.getTracks().forEach(t=>t.stop());state.stream=null;
  try{await state.wakeLock?.release();}catch{} state.wakeLock=null;
}
async function startCamera(){
  await stopCamera(); state.cameraError=''; render();
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:4096},height:{ideal:2160}},audio:false});
    state.stream=stream;
    try{if('wakeLock' in navigator) state.wakeLock=await navigator.wakeLock.request('screen');}catch{}
    render();
  }catch(e){state.cameraError=e?.name==='NotAllowedError'?'Camera permission was denied. Allow camera access in the browser and try again.':'The camera could not start. Close other camera apps and try again.';render();}
}
function canvasBlob(canvas,type='image/jpeg',quality=.92){return new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(Error('Image encoding failed')),type,quality));}
async function capturePayload(){
  const video=document.getElementById('cameraVideo'); if(!video || !video.videoWidth) throw Error('Camera is not ready');
  const c=document.createElement('canvas');c.width=video.videoWidth;c.height=video.videoHeight;const ctx=c.getContext('2d',{alpha:false});ctx.drawImage(video,0,0,c.width,c.height);
  const imageBlob=await canvasBlob(c,'image/jpeg',.92);
  const max=420,scale=Math.min(1,max/Math.max(c.width,c.height)),t=document.createElement('canvas');t.width=Math.max(1,Math.round(c.width*scale));t.height=Math.max(1,Math.round(c.height*scale));t.getContext('2d',{alpha:false}).drawImage(c,0,0,t.width,t.height);
  const thumbnailBlob=await canvasBlob(t,'image/jpeg',.72); return {imageBlob,thumbnailBlob,width:c.width,height:c.height};
}
async function doCapture(){
  if(state.saving) return; state.saving=true; renderScannerControls();
  try{
    const payload=await capturePayload(), mode=state.captureMode;
    if(mode?.replaceId) await replacePage(mode.replaceId,payload); else await addPage(state.session.id,payload,mode?.insertAt);
    state.session=await getSession(state.session.id); state.pages=await getPages(state.session.id); state.flash=true; render(); setTimeout(()=>{state.flash=false;if(state.view==='scanner')render();},350);
    if(mode?.oneShot){state.captureMode=null;await stopCamera();state.view='pages';render();}
    if(state.session.pageCount%20===0) storageCheck();
  }catch(e){alert(e.message||'Could not save this page.');}finally{state.saving=false;renderScannerControls();}
}
function renderScannerControls(){const b=document.getElementById('shutter');if(b){b.disabled=state.saving;b.classList.toggle('saving',state.saving);}}

function homeHtml(sessions){
  const active=sessions.filter(s=>s.status==='active'), finished=sessions.filter(s=>s.status==='finished');
  const card=s=>`<article class="session-card">
    <div class="session-top"><div><h3>${esc(s.title)}</h3><p>${s.pageCount} page${s.pageCount===1?'':'s'} · ${esc(fmtDate(s.updatedAt))}</p></div><button class="icon-button subtle" data-delete-session="${s.id}" aria-label="Delete">${icon('trash',18)}</button></div>
    <button class="primary-button big" data-resume="${s.id}">${s.status==='active'?'Continue Scanning':'Open Scan'}</button>
    ${s.pageCount?`<button class="secondary-button" data-pdf="${s.id}">Finish & Create PDF</button>`:''}
  </article>`;
  return `<main class="home-shell">
    <div class="brand-row"><div class="brand-mark">${icon('book')}</div><div><div class="eyebrow">LOCAL · PRIVATE</div><h1>Book Scanner</h1></div></div>
    ${state.storageWarning?`<div class="storage-warning">${esc(state.storageWarning)}</div>`:''}
    <button class="new-scan-button" id="newScan"><span>${icon('camera')}</span><div><strong>New Book Scan</strong><small>Photograph page after page</small></div></button>
    ${!sessions.length?`<section class="welcome-card"><div class="welcome-icon">${icon('pages',34)}</div><h2>Scan without stopping</h2><p>Every photo is saved automatically on this device. Close the app anytime and continue later.</p><button class="primary-button big" id="startFirst">Start New Scan</button></section>`:''}
    ${active.length?`<section class="section-block"><div class="section-heading"><span>Unfinished scans</span><span>${active.length}</span></div><div class="session-list">${active.map(card).join('')}</div></section>`:''}
    ${finished.length?`<section class="section-block muted-section"><div class="section-heading"><span>Finished</span><span>${finished.length}</span></div><div class="session-list">${finished.map(card).join('')}</div></section>`:''}
    <p class="privacy-note">Photos never leave this device.</p>
  </main>`;
}
function scannerHtml(){
  const last=state.pages.at(-1), thumb=last?blobUrl(last.thumbnailBlob):'';
  return `<main class="scanner-shell">
    ${state.stream?`<video id="cameraVideo" class="camera-video" autoplay playsinline muted></video>`:'<div class="camera-video"></div>'}
    <div class="camera-vignette"></div><div class="camera-guide"><span></span><span></span><span></span><span></span></div>
    <div class="scanner-topbar"><button class="camera-top-button" id="pauseBtn">Pause</button><div class="page-counter"><strong>Page ${state.captureMode?.insertAt||state.session.pageCount+1}</strong><small>${esc(state.session.title)}</small></div><button class="camera-top-button" id="finishBtn">Finish</button></div>
    ${state.storageWarning?`<div class="camera-warning">${esc(state.storageWarning)}</div>`:''}
    ${state.cameraError?`<div class="camera-error-card">${icon('camera',38)}<strong>Camera unavailable</strong><p>${esc(state.cameraError)}</p><button class="primary-button" id="retryCamera">Try Again</button></div>`:(!state.stream?`<div class="camera-status"><div class="spinner"></div><span>Starting camera…</span></div>`:'')}
    ${state.flash?`<div class="capture-flash">${icon('check',44)}</div>`:''}
    <div class="scanner-bottom">
      ${last?`<button class="last-thumb" id="undoLast" aria-label="Undo last page"><img src="${thumb}"><span>${last.pageNumber}</span></button>`:`<span></span>`}
      <button class="shutter ${state.saving?'saving':''}" id="shutter" ${!state.stream||state.saving?'disabled':''} aria-label="Take photo"><span></span></button>
      <button class="pages-button" id="pagesBtn">${icon('pages')}<span>Pages</span></button>
    </div>
  </main>`;
}
function pagesHtml(){
  return `<main class="pages-shell">
    <header class="standard-header"><button class="icon-button" id="backToScan">${icon('back')}</button><div><h1>Pages</h1><p>${esc(state.session.title)} · ${state.pages.length} pages</p></div><button class="header-done" id="finishPages">Finish</button></header>
    <div class="pages-toolbar"><button class="primary-button" id="continueScan">${icon('camera',18)} Continue Scanning</button><button class="secondary-button insert-start" data-insert="1">${icon('plus',18)} Insert at start</button></div>
    ${!state.pages.length?`<div class="empty-pages">${icon('pages',42)}<h2>No pages yet</h2><p>Start photographing your book.</p><button class="primary-button" id="emptyScan">Open Camera</button></div>`:`<div class="page-grid" id="pageGrid">${state.pages.map(p=>`<div class="page-grid-unit" data-page-id="${p.id}"><article class="page-tile"><button class="page-image-button" data-view-page="${p.id}"><div class="page-image-frame"><img data-thumb="${p.id}" style="transform:rotate(${p.rotation}deg)"></div></button><span class="page-number">${p.pageNumber}</span><button class="drag-handle" data-drag="${p.id}" aria-label="Drag to reorder">${icon('grip',18)}</button></article><button class="insert-between" data-insert="${p.pageNumber+1}"><span>+</span> insert after ${p.pageNumber}</button></div>`).join('')}</div>`}
  </main>`;
}
function pdfHtml(){
  if(state.pdfError) return `<main class="pdf-shell"><div class="pdf-progress-card error"><div class="pdf-icon">!</div><h2>PDF creation failed</h2><p>${esc(state.pdfError)}</p><button class="primary-button" id="retryPdf">Try Again</button><button class="secondary-button" id="pdfBack">Back to Scan</button></div></main>`;
  if(state.pdf) return `<main class="pdf-shell"><div class="pdf-result-card"><div class="success-ring">${icon('check',40)}</div><h2>PDF ready</h2><p class="pdf-name">${esc(state.pdf.filename)}</p><div class="pdf-meta"><span>${state.pages.length} pages</span><span>${fmtBytes(state.pdf.blob.size)}</span></div><button class="primary-button" id="downloadPdf">${icon('download',18)} Download PDF</button>${navigator.share?`<button class="secondary-button" id="sharePdf">${icon('share',18)} Share PDF</button>`:''}<button class="text-button" id="pdfBack">Back to Scan</button></div></main>`;
  const p=state.pdfProgress||{current:0,total:state.pages.length};const pct=p.total?Math.round(p.current/p.total*100):0;
  return `<main class="pdf-shell"><div class="pdf-progress-card"><div class="pdf-icon">${icon('pages',34)}</div><h2>Creating PDF</h2><p>Page ${p.current} / ${p.total}</p><div class="progress-track"><span style="width:${pct}%"></span></div><small>Your scan remains safely stored even if PDF creation fails.</small></div></main>`;
}
function modalHtml(){ return ''; }

async function render(){
  clearUrls();
  if(state.view==='home'){
    const sessions=await listSessions(); root.innerHTML=homeHtml(sessions); bindHome();
  } else if(state.view==='scanner'){
    root.innerHTML=scannerHtml(); bindScanner(); if(state.stream){const v=document.getElementById('cameraVideo');v.srcObject=state.stream;v.play().catch(()=>{});}
  } else if(state.view==='pages'){
    root.innerHTML=pagesHtml(); bindPages(); await hydrateThumbs(); if(state.viewerPageId) showViewer(state.viewerPageId);
  } else if(state.view==='pdf') {root.innerHTML=pdfHtml();bindPdf();}
}
function bindHome(){
  document.getElementById('newScan')?.addEventListener('click',showNewScan);document.getElementById('startFirst')?.addEventListener('click',showNewScan);
  root.querySelectorAll('[data-resume]').forEach(b=>b.onclick=()=>openSession(b.dataset.resume,b.textContent.includes('Continue')));
  root.querySelectorAll('[data-pdf]').forEach(b=>b.onclick=()=>openPdfSession(b.dataset.pdf));
  root.querySelectorAll('[data-delete-session]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this scan and all of its pages from this device?')){await deleteSession(b.dataset.deleteSession);render();}});
}
function showNewScan(){
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.innerHTML=`<div class="modal-card"><div class="modal-title-icon">${icon('book')}</div><h2>New Book Scan</h2><p class="modal-copy">Give it a name, then start photographing immediately.</p><label class="field-label">Book name <span>optional</span></label><input class="text-input" id="bookTitle" placeholder="Untitled Book" maxlength="100"><label class="enhancement-row"><span class="enhancement-icon">✦</span><span><strong>Document Enhancement</strong><small>Grayscale + gentle contrast during PDF export</small></span><input type="checkbox" id="enhance"></label><button class="primary-button big" id="createScan">Start Scanning</button><button class="text-button" id="cancelNew">Cancel</button></div>`;document.body.appendChild(wrap);
  document.getElementById('cancelNew').onclick=()=>wrap.remove();document.getElementById('createScan').onclick=async()=>{const s=await createSession(document.getElementById('bookTitle').value,document.getElementById('enhance').checked);await persistStorage();wrap.remove();state.session=s;state.pages=[];state.view='scanner';state.captureMode=null;await startCamera();};
}
async function openSession(id,scan=true){state.session=await getSession(id);state.pages=await getPages(id);state.captureMode=null;state.view=scan?'scanner':'pages';if(scan)await startCamera();else render();}
async function openPdfSession(id){state.session=await getSession(id);state.pages=await getPages(id);showFinishConfirm();}

function bindScanner(){
  document.getElementById('shutter')?.addEventListener('click',doCapture);
  document.getElementById('pauseBtn')?.addEventListener('click',async()=>{await stopCamera();state.view='home';render();});
  document.getElementById('finishBtn')?.addEventListener('click',showFinishConfirm);
  document.getElementById('pagesBtn')?.addEventListener('click',async()=>{await stopCamera();state.view='pages';render();});
  document.getElementById('retryCamera')?.addEventListener('click',startCamera);
  document.getElementById('undoLast')?.addEventListener('click',async()=>{const p=state.pages.at(-1);if(!p)return;if(confirm(`Remove page ${p.pageNumber}?`)){await deletePage(p.id);state.session=await getSession(state.session.id);state.pages=await getPages(state.session.id);render();}});
}
function showFinishConfirm(){
  const wrap=document.createElement('div');wrap.className='modal-backdrop';wrap.innerHTML=`<div class="modal-card"><div class="modal-title-icon">${icon('pages')}</div><h2>${state.session.pageCount?`You captured ${state.session.pageCount} pages.`:'No pages captured yet.'}</h2><p class="modal-copy">${state.session.pageCount?'Create the PDF now? Your saved scan will remain editable.':'Capture at least one page before exporting.'}</p>${state.session.pageCount?'<button class="primary-button big" id="confirmPdf">Create PDF</button>':''}<button class="secondary-button" id="keepScanning">Continue Scanning</button></div>`;document.body.appendChild(wrap);
  document.getElementById('keepScanning').onclick=async()=>{wrap.remove();state.view='scanner';await startCamera();};
  document.getElementById('confirmPdf')?.addEventListener('click',async()=>{wrap.remove();await stopCamera();await beginPdf();});
}
async function hydrateThumbs(){for(const p of state.pages){const el=root.querySelector(`[data-thumb="${p.id}"]`);if(el)el.src=blobUrl(p.thumbnailBlob);}}
function bindPages(){
  const scan=async()=>{state.captureMode=null;state.view='scanner';await startCamera();};
  document.getElementById('backToScan')?.addEventListener('click',scan);document.getElementById('continueScan')?.addEventListener('click',scan);document.getElementById('emptyScan')?.addEventListener('click',scan);document.getElementById('finishPages')?.addEventListener('click',showFinishConfirm);
  root.querySelectorAll('[data-view-page]').forEach(b=>b.onclick=()=>showViewer(b.dataset.viewPage));
  root.querySelectorAll('[data-insert]').forEach(b=>b.onclick=async()=>{state.captureMode={insertAt:Number(b.dataset.insert),oneShot:true};state.view='scanner';await startCamera();});
  root.querySelectorAll('[data-drag]').forEach(h=>{
    h.onpointerdown=e=>{state.dragId=h.dataset.drag;h.setPointerCapture?.(e.pointerId);};
    h.onpointermove=e=>{if(!state.dragId)return;const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-page-id]');root.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target'));if(target&&target.dataset.pageId!==state.dragId){state.dragTargetId=target.dataset.pageId;target.classList.add('drop-target');}};
    h.onpointerup=async()=>{root.querySelectorAll('.drop-target').forEach(x=>x.classList.remove('drop-target'));if(state.dragId&&state.dragTargetId&&state.dragId!==state.dragTargetId){const ids=state.pages.map(p=>p.id),from=ids.indexOf(state.dragId),to=ids.indexOf(state.dragTargetId);const [m]=ids.splice(from,1);ids.splice(to,0,m);await reorderPages(state.session.id,ids);state.pages=await getPages(state.session.id);state.session=await getSession(state.session.id);state.dragId=null;state.dragTargetId=null;render();}else{state.dragId=null;state.dragTargetId=null;}};
    h.onpointercancel=()=>{state.dragId=null;state.dragTargetId=null;};
  });
}
function showViewer(id){
  state.viewerPageId=id;const p=state.pages.find(x=>x.id===id);if(!p)return;const wrap=document.createElement('div');wrap.className='modal-backdrop';const url=blobUrl(p.imageBlob);wrap.innerHTML=`<div class="modal-card modal-wide"><div class="viewer-head"><div><strong>Page ${p.pageNumber}</strong><small>${esc(fmtDate(p.capturedAt))}</small></div><button class="icon-button" id="closeViewer">×</button></div><div class="full-image-wrap"><img src="${url}" style="transform:rotate(${p.rotation}deg)"></div><div class="viewer-actions"><button id="rotL">${icon('rotateL')}<span>Rotate left</span></button><button id="rotR">${icon('rotateR')}<span>Rotate right</span></button><button id="retake">${icon('camera')}<span>Retake</span></button><button class="danger" id="deleteOne">${icon('trash')}<span>Delete</span></button></div></div>`;document.body.appendChild(wrap);
  const close=()=>{state.viewerPageId=null;wrap.remove();};document.getElementById('closeViewer').onclick=close;
  document.getElementById('rotL').onclick=async()=>{await rotatePage(id,-90);state.pages=await getPages(state.session.id);close();render();};document.getElementById('rotR').onclick=async()=>{await rotatePage(id,90);state.pages=await getPages(state.session.id);close();render();};
  document.getElementById('retake').onclick=async()=>{close();state.captureMode={replaceId:id,oneShot:true};state.view='scanner';await startCamera();};
  document.getElementById('deleteOne').onclick=async()=>{if(confirm(`Delete page ${p.pageNumber}?`)){await deletePage(id);state.pages=await getPages(state.session.id);state.session=await getSession(state.session.id);close();render();}};
}

function safeFilename(v){return v.normalize('NFKD').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'').trim().replace(/\s+/g,'_').slice(0,80)||'Book';}
function dateStamp(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
async function enhancedJpeg(page){const bm=await createImageBitmap(page.imageBlob);try{const c=document.createElement('canvas');c.width=bm.width;c.height=bm.height;const x=c.getContext('2d',{alpha:false});x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.filter='grayscale(1) contrast(1.16) brightness(1.04)';x.drawImage(bm,0,0);return {blob:await canvasBlob(c,'image/jpeg',.88),width:c.width,height:c.height};}finally{bm.close();}}
function placement(page,w,h){const rot=page.rotation===90||page.rotation===270,ew=rot?h:w,eh=rot?w:h,portrait=eh>=ew,pw=portrait?A4.width:A4.height,ph=portrait?A4.height:A4.width,scale=Math.min(pw/ew,ph/eh),dw=ew*scale,dh=eh*scale,x=(pw-dw)/2,y=(ph-dh)/2;let m;if(page.rotation===90)m=[0,-dh,dw,0,x,y+dh];else if(page.rotation===180)m=[-dw,0,0,-dh,x+dw,y+dh];else if(page.rotation===270)m=[0,dh,-dw,0,x+dw,y];else m=[dw,0,0,dh,x,y];return{pw,ph,m};}
async function createBookPdf(session,pages,onProgress){
  if(!pages.length)throw Error('There are no pages to export');const ordered=[...pages].sort((a,b)=>a.pageNumber-b.pageNumber),count=ordered.length,objCount=2+count*3,pageIds=ordered.map((_,i)=>3+i*3),parts=[],offsets=new Array(objCount+1).fill(0);let pos=0;
  const str=v=>{const b=encoder.encode(v);parts.push(b);pos+=b.byteLength;},blob=b=>{parts.push(b);pos+=b.size;},begin=id=>{offsets[id]=pos;str(`${id} 0 obj\n`);};
  str('%PDF-1.4\n%BookScanner\n');begin(1);str('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');begin(2);str(`<< /Type /Pages /Count ${count} /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] >>\nendobj\n`);
  for(let i=0;i<count;i++){const p=ordered[i];onProgress?.({current:i+1,total:count});const src=session.enhancement?await enhancedJpeg(p):{blob:p.imageBlob,width:p.width,height:p.height},pageObj=3+i*3,contentObj=pageObj+1,imageObj=pageObj+2,{pw,ph,m}=placement(p,src.width,src.height),[a,b,c,d,e,f]=m.map(n=>Number(n.toFixed(4))),content=`q\n${a} ${b} ${c} ${d} ${e} ${f} cm\n/Im0 Do\nQ\n`,len=encoder.encode(content).byteLength;
    begin(pageObj);str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`);begin(contentObj);str(`<< /Length ${len} >>\nstream\n${content}endstream\nendobj\n`);begin(imageObj);str(`<< /Type /XObject /Subtype /Image /Width ${src.width} /Height ${src.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${src.blob.size} >>\nstream\n`);blob(src.blob);str('\nendstream\nendobj\n');await new Promise(r=>setTimeout(r,0));}
  const xref=pos;str(`xref\n0 ${objCount+1}\n0000000000 65535 f \n`);for(let id=1;id<=objCount;id++)str(`${String(offsets[id]).padStart(10,'0')} 00000 n \n`);str(`trailer\n<< /Size ${objCount+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);return{blob:new Blob(parts,{type:'application/pdf'}),filename:`${safeFilename(session.title)}_${dateStamp()}.pdf`};
}
async function beginPdf(){
  state.pdf=null;state.pdfError='';state.pdfProgress={current:0,total:state.pages.length};state.view='pdf';render();
  try{state.pdf=await createBookPdf(state.session,state.pages,p=>{state.pdfProgress=p;render();});await setFinished(state.session.id);state.session=await getSession(state.session.id);render();}catch(e){state.pdfError=e.message||String(e);render();}
}
function bindPdf(){
  document.getElementById('retryPdf')?.addEventListener('click',beginPdf);document.getElementById('pdfBack')?.addEventListener('click',async()=>{state.pdf=null;state.pdfError='';state.view='pages';render();});
  document.getElementById('downloadPdf')?.addEventListener('click',()=>{const u=URL.createObjectURL(state.pdf.blob),a=document.createElement('a');a.href=u;a.download=state.pdf.filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000);});
  document.getElementById('sharePdf')?.addEventListener('click',async()=>{try{const f=new File([state.pdf.blob],state.pdf.filename,{type:'application/pdf'});if(navigator.canShare?.({files:[f]}))await navigator.share({files:[f],title:state.session.title});else await navigator.share({title:state.session.title,text:'Book scan PDF'});}catch(e){if(e.name!=='AbortError')alert('Sharing is not available for this PDF on this device. Use Download PDF instead.');}});
}

async function boot(){
  if(!('indexedDB' in window)){root.innerHTML='<main class="home-shell"><h1>Book Scanner</h1><p>This browser does not support IndexedDB.</p></main>';return;}
  await openDb();await storageCheck();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'&&state.view==='scanner'&&state.stream&&!state.wakeLock){try{state.wakeLock=await navigator.wakeLock.request('screen');}catch{}}});
  window.addEventListener('pagehide',()=>{state.stream?.getTracks().forEach(t=>t.stop());});
  render();
}
boot().catch(e=>{console.error(e);root.innerHTML=`<main class="home-shell"><h1>Book Scanner</h1><div class="storage-warning">Could not start: ${esc(e.message)}</div></main>`;});