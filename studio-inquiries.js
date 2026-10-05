'use strict';
const crypto = require('crypto');
const fs = require('fs');
const validator = require('validator');
const DAY = 86400000;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function mountStudio(app,{db,adminAuth,secret,protect,reveal,rateLimited,fingerprint,baseUrl,env=process.env,sendNotification,clock=Date.now,startWorker=true}) {
 db.exec(`CREATE TABLE IF NOT EXISTS studio_leads (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, token_enc TEXT NOT NULL, name_enc TEXT NOT NULL, contact_enc TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, is_test INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS studio_inquiries (id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, lead_id TEXT, payload_enc TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, provider_id TEXT);
 CREATE INDEX IF NOT EXISTS studio_queue ON studio_inquiries(state,next_attempt);`);
 const mac = s=>crypto.createHmac('sha256',secret).update('studio:'+s).digest('base64url');
 const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const adminCsrf=mac('admin');
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const originOK=req=> !req.headers.origin || req.headers.origin===new URL(baseUrl).origin;
 const fail=(res,status,message)=>res.status(status).json({error:message});
 const leadFor=token=>typeof token==='string'&&/^[a-zA-Z0-9_-]{32}$/.test(token)?db.prepare('SELECT * FROM studio_leads WHERE token_hash=? AND revoked=0 AND expires_at>?').get(hash(token),clock()):undefined;
 function createLead({name,contact,isTest=false}) {
  name=String(name||'').trim();contact=String(contact||'').trim();
  if(!name||name.length>60||!contact||contact.length>254)throw Error('이름과 회신할 연락처를 입력해 주세요.');
  const token=crypto.randomBytes(24).toString('base64url'),id=crypto.randomUUID(),expires=clock()+90*DAY;
  db.prepare('INSERT INTO studio_leads (id,token_hash,token_enc,name_enc,contact_enc,created_at,expires_at,is_test) VALUES (?,?,?,?,?,?,?,?)').run(id,hash(token),protect(token),protect(name),protect(contact),clock(),expires,isTest?1:0);
  return {id,url:baseUrl+'/for/'+token,expires_at:expires};
 }
 function cleanup(){db.prepare('DELETE FROM studio_inquiries WHERE created_at<?').run(clock()-90*DAY);db.prepare('DELETE FROM studio_leads WHERE expires_at<=?').run(clock());}
 app.get('/for/:token',(req,res)=>{res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'});if(!leadFor(req.params.token))return res.status(404).type('html').send('<html lang="ko"><meta charset="utf-8"><p>만료되었거나 사용할 수 없는 링크입니다.</p><a href="/">홈페이지로 이동</a></html>');res.type('html').send(fs.readFileSync(__dirname+'/landing.html','utf8'));});
 app.get('/api/studio/context',(req,res)=>{
  res.set('Cache-Control','no-store');if(rateLimited('studio-context:'+fingerprint(req),60,60000))return fail(res,429,'잠시 후 다시 시도해 주세요.');
  const token=req.query.token||'',lead=token?leadFor(token):null;if(token&&!lead)return fail(res,404,'만료되었거나 사용할 수 없는 링크입니다.');
  const payload=Buffer.from(JSON.stringify({lead:lead?.id||null,exp:clock()+3600000,nonce:crypto.randomBytes(16).toString('hex')})).toString('base64url');
  res.json({name:lead?reveal(lead.name_enc):null,personalized:!!lead,form_key:payload+'.'+mac(payload)});
 });
 app.post('/api/studio/inquiries',(req,res)=>{
  res.set('Cache-Control','no-store');if(!originOK(req)||!req.is('application/json'))return fail(res,403,'요청을 확인할 수 없습니다.');
  if(rateLimited('studio-submit:'+fingerprint(req),10,3600000))return fail(res,429,'요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  const b=req.body||{};if(typeof b.form_key!=='string'||b.form_key.length>1000)return fail(res,400,'페이지를 새로고침해 주세요.');
  const [payload,sig]=b.form_key.split('.');if(!safeEqual(sig,mac(payload)))return fail(res,403,'페이지를 새로고침해 주세요.');
  let ctx;try{ctx=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{return fail(res,400,'잘못된 요청입니다.');}
  if(!ctx.exp||ctx.exp<clock()||typeof ctx.nonce!=='string')return fail(res,400,'페이지를 새로고침해 주세요.');
  let lead=ctx.lead?db.prepare('SELECT * FROM studio_leads WHERE id=? AND revoked=0 AND expires_at>?').get(ctx.lead,clock()):null;
  if(ctx.lead&&!lead)return fail(res,404,'만료되었거나 사용할 수 없는 링크입니다.');
  if(b.website)return fail(res,400,'요청을 확인할 수 없습니다.');
  if(b.consent!==true)return fail(res,400,'연락 요청 및 개인정보 안내를 확인해 주세요.');
  const email=typeof b.email==='string'?b.email.trim():'',phone=typeof b.phone==='string'?b.phone.trim():'';
  if(email&&(!validator.isEmail(email)||email.length>254))return fail(res,400,'이메일 주소를 확인해 주세요.');
  if(phone&&(!/^[+\d\s().-]{7,25}$/.test(phone)||phone.replace(/\D/g,'').length<7))return fail(res,400,'전화번호를 확인해 주세요.');
  if(!lead&&!email&&!phone)return fail(res,400,'연락받을 이메일 또는 전화번호를 남겨주세요.');
  const dedup=lead?'lead:'+lead.id:'form:'+ctx.nonce;
  const existing=db.prepare('SELECT id FROM studio_inquiries WHERE dedup=?').get(dedup);if(existing)return res.json({ok:true,id:existing.id,duplicate:true});
  const id=crypto.randomUUID();const data={name:lead?reveal(lead.name_enc):'일반 방문자',contact:lead?reveal(lead.contact_enc):email||phone,email,phone,isTest:!!lead?.is_test,via:lead?'고객별 링크 (본인 확인 아님)':'일반 문의'};
  db.prepare('INSERT INTO studio_inquiries (id,dedup,lead_id,payload_enc,created_at,next_attempt) VALUES (?,?,?,?,?,?)').run(id,dedup,lead?.id||null,protect(JSON.stringify(data)),clock(),clock());
  res.status(202).json({ok:true,id});
 });
 const send=sendNotification|| (async(job,data)=>{
  if(!env.RESEND_API_KEY)throw Error('mail_unconfigured');
  const response=await fetch(env.RESEND_API_URL||'https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+env.RESEND_API_KEY,'content-type':'application/json','idempotency-key':'studio-inquiry/'+job.id},body:JSON.stringify({from:env.EMAIL_FROM||'approvals@example.com',to:'sj@someonehastosayyes.com',subject:(data.isTest?'[테스트] ':'')+'[홈페이지 문의] '+data.name.replace(/[\r\n]/g,' '),text:`홈페이지에서 문의하기 버튼이 눌렸습니다.\n\n대상: ${data.name}\n기존 연락처: ${data.contact}\n남긴 이메일: ${data.email||'없음'}\n남긴 전화번호: ${data.phone||'없음'}\n구분: ${data.via}\n접수 ID: ${job.id}\n\n고객별 링크는 전달받은 다른 사람이 사용할 수도 있습니다. 연락 전 수신 대상을 확인해 주세요.\n관리: ${baseUrl}/admin/studio`})});
  if(!response.ok)throw Error('mail_failed_'+response.status);const result=await response.json();return result.id;
 });
 let running=false,stopping=false;
 async function flush(){if(running||stopping)return;running=true;try{cleanup();for(const row of db.prepare("SELECT * FROM studio_inquiries WHERE state='queued' AND next_attempt<=? ORDER BY created_at LIMIT 5").all(clock())){if(stopping)break;try{const providerId=await send(row,JSON.parse(reveal(row.payload_enc)));db.prepare("UPDATE studio_inquiries SET state='sent',provider_id=?,attempts=attempts+1 WHERE id=?").run(providerId||null,row.id);}catch{const attempts=row.attempts+1;db.prepare('UPDATE studio_inquiries SET state=?,attempts=?,next_attempt=? WHERE id=?').run(attempts>=8?'failed':'queued',attempts,clock()+Math.min(6*3600000,30000*2**attempts),row.id);}}}finally{running=false;}}
 const timer=startWorker?setInterval(()=>flush().catch(()=>console.warn('[studio] queue unavailable')),5000):null;timer?.unref();
 app.get('/admin/studio',adminAuth,(req,res)=>{
  cleanup();const leads=db.prepare('SELECT * FROM studio_leads ORDER BY created_at DESC LIMIT 200').all();const inquiries=db.prepare('SELECT * FROM studio_inquiries ORDER BY created_at DESC LIMIT 200').all();
  const rows=leads.map(l=>`<tr><td>${esc(reveal(l.name_enc))}${l.is_test?' (테스트)':''}</td><td>${esc(reveal(l.contact_enc))}</td><td>${l.revoked?'해제됨':`<input aria-label="${esc(reveal(l.name_enc))} 링크" readonly value="${esc(baseUrl+'/for/'+reveal(l.token_enc))}">`}</td><td><form method="post" action="/admin/studio/revoke"><input type="hidden" name="csrf" value="${adminCsrf}"><input type="hidden" name="id" value="${l.id}"><button>링크 해제</button></form></td></tr>`).join('');
  const requests=inquiries.map(r=>{const d=JSON.parse(reveal(r.payload_enc));return `<tr><td>${esc(new Date(r.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}</td><td>${esc(d.name)}</td><td>${esc(d.contact)}<br>${esc(d.email)}<br>${esc(d.phone)}</td><td>${esc(r.state)} (${r.attempts})</td></tr>`;}).join('');
  res.type('html').send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>홈페이지 문의 관리</title><style>body{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px}input,button{font:inherit;padding:10px;margin:6px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:12px;overflow-wrap:anywhere}td input{width:90%}small{color:#666}</style><h1>홈페이지 문의 관리</h1><form method="post" action="/admin/studio/leads"><input type="hidden" name="csrf" value="${adminCsrf}"><label>인사할 이름 <input name="name" maxlength="60" required placeholder="일주 담당자"></label><label>기존 연락처 <input name="contact" maxlength="254" required placeholder="이메일 또는 전화번호"></label><label><input type="checkbox" name="isTest" value="1">테스트</label><button>고객 링크 만들기</button></form><p><small>인사는 ‘안녕하세요, 입력한 이름님’으로 표시됩니다. 링크는 90일 유효하며, 열람만으로 알림을 보내지 않습니다. 클릭은 링크 기준으로 식별되며 본인 확인이 아닙니다.</small></p><h2>고객별 링크</h2><table><tr><th>이름</th><th>연락처</th><th>링크</th><th>관리</th></tr>${rows}</table><h2>연락 요청</h2><p><small>queued: 알림 대기 · sent: 메일 서비스 접수 · failed: 재시도 종료. 이메일 수신함 도착을 보장하는 상태는 아닙니다.</small></p><table><tr><th>접수 시각 (KST)</th><th>이름</th><th>연락처</th><th>알림 상태</th></tr>${requests}</table></html>`);
 });
 app.post('/admin/studio/leads',adminAuth,(req,res)=>{if(!originOK(req)||!safeEqual(req.body?.csrf,adminCsrf))return res.status(403).send('잘못된 요청');try{createLead({name:req.body.name,contact:req.body.contact,isTest:req.body.isTest==='1'});res.redirect(303,'/admin/studio');}catch(e){res.status(400).send(esc(e.message));}});
 app.post('/admin/studio/revoke',adminAuth,(req,res)=>{if(!originOK(req)||!safeEqual(req.body?.csrf,adminCsrf))return res.status(403).send('잘못된 요청');db.prepare('UPDATE studio_leads SET revoked=1 WHERE id=?').run(String(req.body.id||''));res.redirect(303,'/admin/studio');});
 return {createLead,flush,stop:async()=>{stopping=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,50))}};
}
module.exports={mountStudio};
