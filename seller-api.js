'use strict';
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { preflight, validateInput } = require('./email-preflight');
const PATH='/api/agent/email-preflight';
const NETWORK='eip155:8453';
const ASSET='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DESCRIPTION='Email preflight: syntax, live MX/DNS evidence, disposable-list match, role/free-provider flags and typo suggestions. Single synchronous JSON response. No SMTP probe; mailbox existence and deliverability stay unknown.';
const inputSchema={type:'object',properties:{email:{type:'string',minLength:1,maxLength:320}},required:['email'],additionalProperties:false};
const sample=require('./email-preflight-example.json');
const outputExample=Object.fromEntries(Object.entries(sample).filter(([k])=>!['example_only','source'].includes(k)));
const nullableBoolean={type:['boolean','null']};
const outputSchema={type:'object',required:['schema_version','normalized_email','syntax_valid','mailbox_exists','deliverable','mail_route','action','risk_flags','evidence','checked_at','request_id'],properties:{
 schema_version:{const:'1.0'},normalized_email:{type:'string'},domain:{type:['string','null']},syntax_valid:{type:'boolean'},smtp_utf8_required:{type:'boolean'},mailbox_exists:{const:'unknown'},deliverable:{const:'unknown'},mx_present:nullableBoolean,mx_hosts:{type:'array',items:{type:'object',required:['host','priority'],properties:{host:{type:'string'},priority:{type:'integer'}}}},mail_route:{enum:['unknown','mx','implicit_mx','null_mx','conflicting_mx','domain_not_found','no_mail_route']},disposable_domain:nullableBoolean,role_account:nullableBoolean,free_provider:nullableBoolean,spf_present:nullableBoolean,dmarc_at_exact_domain_present:nullableBoolean,typo_suggestion:{type:['string','null']},action:{enum:['reject','review','continue_with_mailbox_verification']},risk_flags:{type:'array',items:{type:'string'}},checked_at:{type:'string',format:'date-time'},request_id:{type:'string'},rules_version:{type:'string'},disposable_list:{type:'object'},evidence:{type:'array',items:{type:'object',required:['name','type','status','records','observed_at'],properties:{name:{type:'string'},type:{enum:['MX','A','AAAA','TXT']},status:{enum:['ok','no_records','nxdomain','unavailable']},records:{type:'array'},observed_at:{type:'string',format:'date-time'}}}}
}};
outputExample.request_id='example-only';
function mountSeller(app,{db,adminAuth,baseUrl,secret,env=process.env,facilitatorClient,check=preflight}) {
  const context=new AsyncLocalStorage();
  const payTo=env.SHSY_PAY_TO || '';
  const amount=env.SHSY_PRICE_ATOMIC || '1000';
  if (!/^[1-9][0-9]{0,8}$/.test(amount)) throw new Error('Invalid SHSY_PRICE_ATOMIC');
  const price=(Number(amount)/1e6).toFixed(6);
  const enabled=/^0x[0-9a-fA-F]{40}$/.test(payTo) && !/^0x0{40}$/i.test(payTo);
  const excluded=new Set([payTo,...(env.SHSY_TEST_PAYERS||'').split(',')].map(x=>x.trim().toLowerCase()).filter(Boolean));
  const hash=x=>crypto.createHmac('sha256',secret).update(x).digest('hex');
  const variant=env.SHSY_EXPERIMENT_ID || 'email-preflight-v1';
  const facilitatorAllowed=()=>Boolean(facilitatorClient || (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) || Date.now()<Date.parse('2026-09-21T12:00:00Z'));
  const live=()=>enabled && facilitatorAllowed();
  let windowStart=Date.now(),requests=0,active=0;
  db.exec(`CREATE TABLE IF NOT EXISTS seller_events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,request_id TEXT,event TEXT NOT NULL,source TEXT,variant TEXT NOT NULL,price_atomic TEXT NOT NULL,payer_id TEXT,classification TEXT,tx TEXT,latency_ms INTEGER,status INTEGER);
    CREATE TABLE IF NOT EXISTS seller_payments(nonce_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,payer_id TEXT NOT NULL,classification TEXT NOT NULL,state TEXT NOT NULL,tx TEXT UNIQUE,amount TEXT NOT NULL,result_hash TEXT,at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS seller_events_at ON seller_events(at);`);
  const event=(name,extra={})=>{const c=context.getStore()||{}; db.prepare('INSERT INTO seller_events(at,request_id,event,source,variant,price_atomic,payer_id,classification,tx,latency_ms,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),c.id||null,name,c.source||null,variant,amount,c.payerId||null,c.classification||null,extra.tx||null,c.started ? Date.now()-c.started:null,extra.status||null);};
  function tracking(req,res,next){
    // Source is caller-provided attribution, never a verified directory impression.
    const claimed=req.get('X-SHSY-Source') || req.query.source;
    const source=typeof claimed==='string' && /^[a-z0-9_-]{1,48}$/.test(claimed) ? claimed : null;
    const c={id:crypto.randomUUID(),source,started:Date.now()};
    context.run(c,()=>{res.set('Cache-Control','no-store');res.set('X-SHSY-Request-ID',c.id);res.on('finish',()=>context.run(c,()=>event(res.statusCode===402?'quote_402':'http_response',{status:res.statusCode})));next();});
  }
  let middleware;
  if(enabled){
    const {paymentMiddleware,x402ResourceServer}=require('@x402/express');
    const {HTTPFacilitatorClient}=require('@x402/core/server');
    const {ExactEvmScheme}=require('@x402/evm/exact/server');
    const {declareDiscoveryExtension,bazaarResourceServerExtension}=require('@x402/extensions/bazaar');
    const {createFacilitatorConfig}=require('@coinbase/x402');
    const client=facilitatorClient || new HTTPFacilitatorClient(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? createFacilitatorConfig(env.CDP_API_KEY_ID,env.CDP_API_KEY_SECRET) : {url:'https://facilitator.payai.network'});
    const server=new x402ResourceServer(client).register(NETWORK,new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
    server.onAfterVerify(async ({result,paymentPayload})=>{
      const c=context.getStore();
      if(!c || !result.isValid || !result.payer) return {abort:true,reason:'payer_not_verified'};
      const auth=paymentPayload.payload?.authorization;
      if(!auth?.nonce) return {abort:true,reason:'EIP3009_authorization_required'};
      c.payerId=hash(result.payer.toLowerCase());
      c.classification=excluded.has(result.payer.toLowerCase()) ? 'excluded_self_or_test' : 'unclassified';
      c.nonceId=hash(`${NETWORK}:${result.payer.toLowerCase()}:${auth.nonce}`);
      const inserted=db.prepare('INSERT OR IGNORE INTO seller_payments(nonce_id,request_id,payer_id,classification,state,amount,at) VALUES(?,?,?,?,?,?,?)').run(c.nonceId,c.id,c.payerId,c.classification,'verified',amount,new Date().toISOString());
      if(!inserted.changes) return {abort:true,reason:'payment_already_seen_contact_support_with_request_id'};
      event('payment_verified');
    });
    server.onVerifiedPaymentCanceled(async()=>{const c=context.getStore();if(c?.nonceId)db.prepare("UPDATE seller_payments SET state='canceled_before_settlement' WHERE nonce_id=? AND state='verified'").run(c.nonceId);event('payment_canceled');});
    server.onVerifyFailure(async()=>{event('verification_failed');});
    server.onBeforeSettle(async()=>{const c=context.getStore();db.prepare("UPDATE seller_payments SET state='settling' WHERE nonce_id=?").run(c.nonceId);event('settlement_started');});
    server.onAfterSettle(async({result})=>{
      const c=context.getStore();
      if(!result.success || !result.transaction) {event('settlement_unconfirmed');return;}
      db.prepare("UPDATE seller_payments SET state='settled',tx=?,result_hash=? WHERE nonce_id=?").run(result.transaction,c.resultHash||null,c.nonceId);
      event('settled',{tx:result.transaction});
    });
    server.onSettleFailure(async()=>{const c=context.getStore();db.prepare("UPDATE seller_payments SET state='settlement_unknown' WHERE nonce_id=?").run(c.nonceId);event('settlement_unknown');});
    middleware=paymentMiddleware({[`POST ${PATH}`]:{accepts:{scheme:'exact',network:NETWORK,payTo,price:{amount,asset:ASSET,extra:{name:'USD Coin',version:'2'}}},resource:`${baseUrl}${PATH}`,description:DESCRIPTION,mimeType:'application/json',extensions:declareDiscoveryExtension({input:{email:'person@example.com'},inputSchema,bodyType:'json',output:{example:outputExample,schema:{type:'object',required:['schema_version','mailbox_exists','deliverable','evidence','action','request_id']}}})}},server);
  }
  app.get('/agent-seller',tracking,(_req,res)=>{event('product_page');res.type('html').send(require('node:fs').readFileSync(__dirname+'/agent-seller.html','utf8').replace('{{PAYMENT_STATUS}}',live() ? `${price} USDC per completed check · x402 on Base` : 'Not accepting payments yet. Launch configuration is in progress.'));});
  app.get('/agent-seller/status',(_req,res)=>res.json({accepting_payments:live(),network:NETWORK,price_usdc:price,external_purchase_verified:null,note:'Purchase qualification requires operator review; see private telemetry.'}));
  app.get('/agent-seller/client.mjs',(_req,res)=>res.type('text/plain').sendFile(__dirname+'/examples/email-preflight-client.mjs'));
  app.get('/agent-seller/example.json',(_req,res)=>res.sendFile(__dirname+'/email-preflight-example.json'));
  const spec={openapi:'3.1.0',info:{title:'SHSY Email Preflight',version:'1.0.0',description:DESCRIPTION},servers:[{url:baseUrl}],paths:{[PATH]:{post:{operationId:'emailPreflight',summary:'Check an email before mailbox verification',description:DESCRIPTION,requestBody:{required:true,content:{'application/json':{schema:inputSchema}}},responses:{200:{description:'Deterministic evidence, never a guarantee of delivery',content:{'application/json':{schema:outputSchema,example:outputExample}}},400:{description:'Invalid request shape; not charged'},402:{description:'x402 v2 USDC payment required'},503:{description:'Unavailable or DNS incomplete; not charged'}}}}}};
  app.get('/agent-seller/openapi.json',tracking,(_req,res)=>{event('schema_view');res.json(spec);});
  app.get(['/llms.txt','/agent-seller/llms.txt'],tracking,(_req,res)=>{event('agent_docs');res.type('text/plain').send(`# SHSY Email Preflight\n${DESCRIPTION}\nEndpoint: POST ${baseUrl}${PATH}\nInput: {"email":"person@example.com"}\nPrice: ${price} USDC. Network: ${NETWORK}. x402 v2.\nSchema: ${baseUrl}/agent-seller/openapi.json\nClient example: ${baseUrl}/agent-seller/client.mjs\nNo account, subscription or API key. Requires a funded Base USDC wallet and compatible x402 client.\nInspect the 402 requirements and your spending policy before paying.\nDo not use to prove mailbox existence. No sending, SMTP, catch-all or reputation test.\nSource attribution: optional X-SHSY-Source header. Never include an email address in the URL.\n`);});
  app.get('/admin/seller/telemetry',adminAuth,(_req,res)=>{
    const events=db.prepare('SELECT event,COUNT(*) count FROM seller_events GROUP BY event').all();
    const settled=db.prepare("SELECT classification,COUNT(*) payments,COUNT(DISTINCT payer_id) wallets,SUM(CAST(amount AS INTEGER)) revenue_atomic FROM seller_payments WHERE state='settled' GROUP BY classification").all();
    const funnel_by_source=db.prepare('SELECT source,variant,price_atomic,event,COUNT(*) count FROM seller_events GROUP BY source,variant,price_atomic,event').all();
    const repeat=db.prepare("SELECT COUNT(*) count FROM (SELECT payer_id FROM seller_payments WHERE state='settled' AND classification!='excluded_self_or_test' GROUP BY payer_id HAVING COUNT(*)>1)").get().count;
    res.json({events,funnel_by_source,settled,repeat_unclassified_wallets:repeat,distinct_economic_buyers:null,market_reach:null,directory_impressions:null,verified_external_agent_purchases:null,notes:['Unclassified wallets are NOT confirmed external buyers.','402 requests include crawlers/retries; they are not qualified demand.','Source attribution is optional, caller-claimed and may be missing.','Settlement is not proof that the client consumed the result.'],recent_payments:db.prepare('SELECT request_id,payer_id,classification,state,tx,amount,result_hash,at FROM seller_payments ORDER BY at DESC LIMIT 50').all()});
  });
  app.post(PATH,tracking,(req,res,next)=>{
    event('api_request');
    if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0;}
    if(++requests>300 || active>=12){res.set('Retry-After','60');return res.status(429).json({error:'Request capacity reached; retry later.'});}
    const invalid=validateInput(req.body);
    if(invalid){event('invalid_request');return res.status(400).json({error:invalid});}
    event('valid_job_request');
    if(!enabled)return res.status(503).json({error:'Payments are not live yet. Receiving address configuration is required.'});
    if(!facilitatorClient && !env.CDP_API_KEY_ID && Date.now() >= Date.parse('2026-09-21T12:00:00Z')) return res.status(503).json({error:'Payment facilitator pricing review required; payments paused.'});
    active++;res.once('close',()=>{active--;});
    return middleware(req,res,next).catch(()=>res.status(503).json({error:'Payment service unavailable'}));
  },async(req,res)=>{
    try {
      const result=await check(req.body.email);
      if(result.risk_flags.includes('dns_incomplete')) {event('dns_unavailable');return res.status(503).json({error:'DNS evidence is incomplete. No settlement requested; retry later.',request_id:context.getStore().id});}
      const c=context.getStore();result.request_id=c.id;c.resultHash=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');event('result_prepared');res.json(result);
    }catch{event('result_failed');res.status(503).json({error:'Could not complete the check; no settlement requested.'});}
  });
  return {enabled,spec};
}
module.exports={mountSeller,PATH};
