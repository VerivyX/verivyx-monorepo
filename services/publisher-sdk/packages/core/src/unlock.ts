import { buildPaywallJsonLd, buildPreviewHtml } from "./preview.js";

/** Read a cookie value from a Request's Cookie header. */
export function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Escape a value for safe embedding inside a JS single-quoted string literal.
function jsStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\x3c").replace(/[\r\n]/g, "");
}

/**
 * Interactive unlock page: the SEO teaser + an in-page PoW solver that runs the
 * existing /auth/challenge → solve → /auth/verify-human flow, sets the vx_session
 * cookie, and reloads. Crawlers still see the teaser + JSON-LD; the script is inert
 * for them. No external deps; uses Web Crypto.
 */
export function buildUnlockHtml(args: {
  slug: string; url: string; authBase: string; domain: string;
  seo?: { title: string; excerpt: string };
}): string {
  const seo = args.seo ?? { title: "Protected content", excerpt: "Verify to read the full article." };
  const jsonLd = buildPaywallJsonLd({ title: seo.title, description: seo.excerpt, url: args.url });
  const teaser = buildPreviewHtml({ title: seo.title, excerpt: seo.excerpt, url: args.url, jsonLd });
  const challengeUrl = jsStr(args.authBase) + "/api/v1/auth/challenge";
  const verifyUrl = jsStr(args.authBase) + "/api/v1/auth/verify-human";
  const cfg = `{challengeUrl:'${challengeUrl}',verifyUrl:'${verifyUrl}',domain:'${jsStr(args.domain)}',slug:'${jsStr(args.slug)}'}`;
  const script = `<script>(function(){var C=${cfg};
function lz(b){var n=0;for(var i=0;i<b.length;i++){var x=b[i];if(x===0){n+=8;continue;}for(var j=7;j>=0;j--){if((x>>j)&1)return n;n++;}return n;}return n;}
async function sha(s){var d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return new Uint8Array(d);}
async function solve(ch,sa,df){var n=0;for(;;){if((lz(await sha(ch+':'+sa+':'+n)))>=df)return ''+n;n++;}}
async function go(){try{
var r=await fetch(C.challengeUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain:C.domain,slug:C.slug})});
if(!r.ok)throw 0;var c=await r.json();var t0=Date.now();var nonce=await solve(c.challenge,c.salt,c.difficulty);var dur=Date.now()-t0;
var fp={ua:navigator.userAgent,lang:navigator.language,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,hc:navigator.hardwareConcurrency||0};
var v=await fetch(C.verifyUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge:c.challenge,nonce:nonce,fingerprint:fp,powDurationMs:dur})});
if(!v.ok)throw 0;var j=await v.json();var tok=j.token||j.sessionToken||j.session;if(!tok)throw 0;
document.cookie='vx_session='+tok+'; path=/; max-age=1800; SameSite=Lax';location.reload();
}catch(e){var s=document.getElementById('vx-status');if(s)s.textContent='Verification failed — please refresh to try again.';}}
if(window.crypto&&crypto.subtle){var s=document.getElementById('vx-status');if(s)s.textContent='Verifying you are human…';go();}})();</script>`;
  // Inject a status line + the script before </body>.
  return teaser.replace(
    "</body>",
    `  <p id="vx-status"></p>\n${script}\n</body>`,
  );
}
