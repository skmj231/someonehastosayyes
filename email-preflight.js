'use strict';
const dns = require('node:dns').promises;
const { domainToASCII } = require('node:url');
const isEmail = require('validator/lib/isEmail');
const disposable = new Set(require('disposable-email-domains'));
const disposableWildcards = new Set(require('disposable-email-domains/wildcard.json'));
const listVersion = require('disposable-email-domains/package.json').version;
const ROLE = new Set('admin administrator support info sales contact hello team billing abuse postmaster webmaster noreply no-reply newsletter marketing office help jobs careers'.split(' '));
const FREE = new Set('gmail.com googlemail.com yahoo.com outlook.com hotmail.com live.com icloud.com me.com aol.com proton.me protonmail.com naver.com daum.net hanmail.net'.split(' '));
const TYPOS = { 'gmial.com':'gmail.com','gamil.com':'gmail.com','gmai.com':'gmail.com','gnail.com':'gmail.com','hotmial.com':'hotmail.com','outlok.com':'outlook.com','yaho.com':'yahoo.com' };
function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.email !== 'string' || body.email.length < 1 || body.email.length > 320 || Object.keys(body).some(k => k !== 'email')) return 'Expected JSON {"email":"person@domain.com"}; one address, 1–320 characters, no extra fields.';
  return null;
}
async function preflight(email, { resolver, timestamp = new Date().toISOString() } = {}) {
  const ownResolver = !resolver;
  resolver ||= new dns.Resolver({ timeout: 1600, tries: 1 });
  const original = email.trim();
  const at = original.lastIndexOf('@');
  const local = original.slice(0, at);
  const domain = at >= 0 ? domainToASCII(original.slice(at + 1).toLowerCase()) : '';
  const normalized = at >= 0 && domain ? `${local}@${domain}` : original;
  const unicodeLocal = /[^\x00-\x7F]/.test(local);
  const syntax = isEmail(normalized, { allow_utf8_local_part: true, require_tld: true, allow_ip_domain: false });
  const result = { schema_version:'1.0', normalized_email: normalized, domain: domain || null,
    syntax_valid: syntax, smtp_utf8_required: unicodeLocal, mailbox_exists:'unknown', deliverable:'unknown',
    spf_present:null, dmarc_at_exact_domain_present:null, mx_present:null, mx_hosts:[], mail_route:'unknown', disposable_domain:null, role_account:null, free_provider:null,
    typo_suggestion: TYPOS[domain] || null, risk_flags:[], action:'review', checked_at:timestamp, evidence:[],
    rules_version:'2026-09-17.1', disposable_list:{ package:'disposable-email-domains', version:listVersion, meaning:'false means not found in this list; not proof of a permanent mailbox' } };
  if (!syntax) { result.risk_flags.push('invalid_syntax'); result.action='reject'; return result; }
  result.role_account = ROLE.has(local.toLowerCase().split('+')[0]);
  result.free_provider = FREE.has(domain);
  result.disposable_domain = disposable.has(domain) || domain.split('.').some((_,i,a) => disposableWildcards.has(a.slice(i).join('.')));
  const query = async (name, type) => {
    try { const records = await resolver.resolve(name, type); const e={ name,type,status:'ok',records,observed_at:timestamp }; result.evidence.push(e); return e; }
    catch(e) { const status = e.code === 'ENODATA' ? 'no_records' : e.code === 'ENOTFOUND' ? 'nxdomain' : 'unavailable'; const row={name,type,status,records:[],observed_at:timestamp};result.evidence.push(row);return row; }
  };
  try {
    const [mx] = await Promise.all([query(domain,'MX'),query(domain,'TXT'),query(`_dmarc.${domain}`,'TXT')]);
    result.mx_present = mx.status === 'unavailable' ? null : mx.records.length > 0;
    result.mx_hosts = mx.records.map(x => ({host:x.exchange || '.',priority:x.priority})).sort((a,b)=>a.priority-b.priority || a.host.localeCompare(b.host));
    if (mx.status === 'nxdomain') result.mail_route='domain_not_found';
    else if (mx.status === 'ok' && mx.records.some(x => !x.exchange || x.exchange === '.')) {
      result.mail_route=mx.records.length === 1 && mx.records[0].priority === 0 ? 'null_mx' : 'conflicting_mx';
    } else if (mx.records.length) result.mail_route='mx';
    else if (mx.status === 'no_records') {
      const fallback=await Promise.all([query(domain,'A'),query(domain,'AAAA')]);
      result.mail_route=fallback.some(e=>e.records.length) ? 'implicit_mx' : fallback.some(e=>e.status==='unavailable') ? 'unknown' : 'no_mail_route';
    }
    const txt=result.evidence.find(e=>e.name===domain && e.type==='TXT');
    const dmarc=result.evidence.find(e=>e.name===`_dmarc.${domain}`);
    result.spf_present=txt.status==='unavailable' ? null : txt.records.some(r=>/^v=spf1(?:\s|$)/i.test(r.join('')));
    result.dmarc_at_exact_domain_present=dmarc.status==='unavailable' ? null : dmarc.records.some(r=>/^v=DMARC1(?:;|$)/i.test(r.join('')));
    result.authentication_note='Record presence only. SPF/DMARC concern sending authentication, not recipient existence. Parent-domain DMARC fallback and policy validity are not evaluated.';
    if (['domain_not_found','null_mx','no_mail_route'].includes(result.mail_route)) result.risk_flags.push(result.mail_route);
    if (result.disposable_domain) result.risk_flags.push('listed_disposable_domain');
    if (result.typo_suggestion) result.risk_flags.push('possible_domain_typo');
    if (unicodeLocal) result.risk_flags.push('smtp_utf8_required');
    if (result.evidence.some(e=>e.status==='unavailable')) result.risk_flags.push('dns_incomplete');
    if (result.mail_route==='conflicting_mx') result.risk_flags.push('conflicting_mx');
    result.action=['domain_not_found','null_mx','no_mail_route'].includes(result.mail_route) ? 'reject' : result.risk_flags.length ? 'review' : 'continue_with_mailbox_verification';
    result.evidence.sort((a,b)=>(a.name+a.type).localeCompare(b.name+b.type));
    return result;
  } finally { if (ownResolver) resolver.cancel(); }
}
module.exports={preflight,validateInput};
