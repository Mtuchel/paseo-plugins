// The factory board (/board): one static document the inbox frontdoor serves itself, outside its
// snapshot cache. Its only data source is GET /api/board, read on load and every minute while the
// page is visible (a hidden page reads again once it is shown); when that read fails the last
// reading stays on screen, marked as a backend outage with the error text, and the page keeps
// asking. Every value that reaches the document goes through esc().

const STYLE = `
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--chip:#ececf1;--tint:#0a64d6;
--ok:#1b7a3d;--ok-bg:#dcf5e3;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1;--you:#5b3fc4;--you-bg:#ebe5ff;--stale:#a34f00;--stale-bg:#ffe6cf;--srv:#0f766e;--srv-bg:#d5f2ee;--mac:#3c3c43;--mac-bg:#e6e6eb}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--chip:#2c2c2e;--tint:#5aa9ff;
--ok:#8fe0a8;--ok-bg:#123d22;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512;--you:#c7b8ff;--you-bg:#2e2366;--stale:#ffb870;--stale-bg:#4a2a08;--srv:#7fe3d6;--srv-bg:#0d3b37;--mac:#d1d1d6;--mac-bg:#3a3a3c}}
*{box-sizing:border-box}
body{margin:0;font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--fg);background:var(--bg);font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(1.8) blur(20px);-webkit-backdrop-filter:saturate(1.8) blur(20px);border-bottom:.5px solid var(--line);padding:10px 16px 8px}
.top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em}
.live{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--ok);background:var(--ok-bg);border-radius:6px;padding:1px 7px;white-space:nowrap}
.live i{width:6px;height:6px;border-radius:50%;background:currentColor}
.live.down{color:var(--bad);background:var(--bad-bg)}
.totals{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}
.tot{border:0;font:inherit;font-weight:600;border-radius:999px;padding:3px 10px;cursor:pointer;background:var(--chip);color:var(--sub)}
.tot[aria-pressed=true]{outline:2px solid var(--tint)}
.tot.broken{background:var(--bad-bg);color:var(--bad)}.tot.stale{background:var(--stale-bg);color:var(--stale)}.tot.you{background:var(--you-bg);color:var(--you)}.tot.slow{background:var(--warn-bg);color:var(--warn)}
.machines{display:flex;gap:10px;margin-top:8px;flex-wrap:wrap}
.machine{display:flex;align-items:center;gap:10px;background:var(--card);border-radius:10px;padding:6px 10px;border:.5px solid var(--line);flex-wrap:wrap}
.machine b{font-size:13px}
.machine b.mh0{color:var(--srv)}.machine b.mh1{color:var(--mac)}.machine b.mh2{color:var(--you)}.machine b.mh3{color:var(--stale)}
.machine.bad{border-color:var(--bad)}
.slots{display:flex;align-items:center;gap:6px;color:var(--sub);flex-wrap:wrap}
.meter{width:90px;height:6px;border-radius:3px;background:var(--chip);overflow:hidden;display:flex}
.meter i{display:block;height:100%}
.fact{color:var(--muted);font-size:12px}
.fact.old{color:var(--warn);font-weight:600}
.fact.old::before{content:"⚠ "}
.fact.fresh::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#30a46c;margin-right:5px;vertical-align:1px;animation:beacon 2.4s ease-in-out infinite}
@keyframes beacon{50%{opacity:.3}}
.controls{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}
.seg{display:inline-flex;background:var(--chip);border-radius:8px;padding:2px;flex-wrap:wrap}
.seg button{border:0;background:none;font:inherit;color:var(--sub);padding:3px 10px;border-radius:6px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--card);color:var(--fg);box-shadow:0 1px 2px #0002}
input[type=search]{font:inherit;border:.5px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 9px;width:220px}
.legend{display:flex;gap:10px;color:var(--muted);font-size:12px;margin-left:auto;flex-wrap:wrap}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px;background:var(--c)}
.legend .dash::before{background:none;border:1.5px dashed var(--muted)}
.failure{margin:10px 16px 0;border:.5px solid var(--bad);background:var(--bad-bg);color:var(--bad);border-radius:10px;padding:8px 12px;font-size:12.5px}
.failure b{font-weight:700}
.failure[hidden]{display:none}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;padding:12px 16px}
@media(max-width:1000px){.layout{grid-template-columns:minmax(0,1fr)}.rail{order:-1}}
.board{display:grid;grid-auto-flow:column;grid-template-columns:var(--cols);gap:8px;overflow-x:auto;padding-bottom:8px;align-items:start}
.col{background:color-mix(in srgb,var(--chip) 55%,transparent);border-radius:12px;padding:8px;min-width:0}
.col h2{margin:0;font-size:13px;font-weight:650;display:flex;gap:6px;align-items:baseline}
.col h2 .n{color:var(--muted);font-weight:500}
.col .lim{font-size:11px;color:var(--muted);margin:1px 0 6px}
.bar{display:flex;height:4px;border-radius:2px;overflow:hidden;background:var(--line);margin-bottom:8px}
.bar i{display:block;height:100%}
.card{display:block;cursor:pointer;background:var(--card);border-radius:9px;padding:7px 8px 9px 10px;margin-bottom:6px;border-left:4px solid var(--hc);box-shadow:0 .5px 1.5px #0000001f;position:relative}
.card:hover{outline:1.5px solid var(--tint)}
.card.unverified{border:1px dashed color-mix(in srgb,var(--muted) 80%,transparent);border-left:4px dashed var(--hc);box-shadow:none}
.col.compact .t{-webkit-line-clamp:1;margin-bottom:0}.col.compact .l3,.col.compact .why{display:none}
.h-broken{--hc:var(--bad)}.h-stale{--hc:var(--stale)}.h-you{--hc:var(--you)}.h-slow{--hc:var(--warn)}.h-blocked{--hc:var(--muted)}.h-ok{--hc:var(--ok)}
.l1{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}
.l1 .id{font-weight:650;font-size:12px}
.chip{font-size:10.5px;font-weight:600;border-radius:5px;padding:0 5px;line-height:16px;white-space:nowrap}
.chip.hst0{background:var(--srv-bg);color:var(--srv)}.chip.hst1{background:var(--mac-bg);color:var(--mac)}
.chip.hst2{background:var(--you-bg);color:var(--you)}.chip.hst3{background:var(--stale-bg);color:var(--stale)}
.chip.none,.chip.hostnone{background:none;color:var(--muted);border:.5px dashed var(--line)}
.chip.blk{background:var(--chip);color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;position:relative}
.dot.running{background:#30a46c}.dot.idle{background:var(--muted)}.dot.error{background:var(--bad)}.dot.perm{background:var(--you)}
/* Liveness: only an agent with a real update in the last 20 min breathes; "running" but silent is a hollow, still ring. */
.dot.running.live::after{content:"";position:absolute;inset:0;border-radius:50%;background:#30a46c;animation:breathe 2.4s cubic-bezier(.16,1,.3,1) infinite}
.dot.running.silent{background:none;box-shadow:inset 0 0 0 1.5px var(--stale)}
@keyframes breathe{0%{transform:scale(1);opacity:.6}70%,100%{transform:scale(2.9);opacity:0}}
html.paused *,html.paused ::after,html.paused ::before{animation-play-state:paused!important}
.clock{position:absolute;left:10px;right:8px;bottom:3px;height:2px;border-radius:1px;background:color-mix(in srgb,var(--line) 70%,transparent);overflow:hidden}
.clock i{display:block;height:100%;width:var(--p);background:var(--muted)}
.clock.over i{background:var(--warn)}.clock.red i{background:var(--bad)}
.xd{display:grid;grid-template-rows:0fr;transition:grid-template-rows .26s cubic-bezier(.16,1,.3,1)}
.xd>div{overflow:hidden;min-height:0}
.card.open .xd{grid-template-rows:1fr}
.card.open{outline:1.5px solid var(--tint)}.card.open .t{-webkit-line-clamp:unset}.card.open .why{white-space:normal}
.det{font-size:12px;margin-top:6px;padding-top:6px;border-top:.5px solid var(--line);cursor:auto}
.det table,#pop table{border-collapse:collapse;margin-top:4px}.det td,#pop td{padding:1px 8px 1px 0;vertical-align:top}.det td:first-child,#pop td:first-child{color:var(--muted);white-space:nowrap}
.det ul,#pop ul{margin:4px 0 0;padding-left:16px}
li.broken{color:var(--bad)}li.stale{color:var(--stale)}li.you{color:var(--you)}li.slow{color:var(--warn)}li.blocked{color:var(--muted)}
.acts{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}.acts a{color:var(--tint);font-weight:600;text-decoration:underline;text-underline-offset:2px}
.card.flash{animation:locate .9s cubic-bezier(.16,1,.3,1) 2}
@keyframes locate{0%{box-shadow:0 2px 6px #0003,0 0 0 0 color-mix(in srgb,var(--tint) 75%,transparent)}100%{box-shadow:0 2px 6px #0003,0 0 0 12px transparent}}
.age{margin-left:auto;font-size:11.5px;color:var(--muted);white-space:nowrap}
.age.over{color:var(--warn);font-weight:600}.age.red{color:var(--bad);font-weight:600}
.t{margin:3px 0 4px;color:var(--sub);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px}
.l3{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--muted);flex-wrap:wrap}
.pr{font-weight:600;color:var(--sub)}.pr .x{color:var(--bad)}.pr .ok{color:var(--ok)}.pr .run{color:var(--warn)}
.why{margin-top:4px;font-size:11.5px;color:var(--hc);font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.more{width:100%;border:0;background:none;font:inherit;color:var(--tint);padding:4px;cursor:pointer;text-align:left}
.swipe{display:none;color:var(--muted);font-size:12px;margin:0 2px 6px}@media(max-width:700px){.swipe{display:block}}
.empty{color:var(--muted);font-size:12px;padding:4px 2px}
.rail{background:var(--card);border-radius:12px;padding:10px 12px;border:.5px solid var(--line);align-self:start;position:sticky;top:150px;max-height:calc(100vh - 165px);overflow:auto}
.rail[hidden]{display:none}
.rail h2{margin:0 0 6px;font-size:15px}
.rail h3{margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--hc)}
.att{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:0 8px;padding:5px 0;border:0;border-top:.5px solid var(--line);align-items:baseline;width:100%;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
.att:hover .r{color:var(--fg)}
.att .id{font-weight:650;font-size:12px}
.att .r{color:var(--sub);font-size:12px}
.att .a{color:var(--muted);font-size:11.5px;white-space:nowrap}
.att .m{grid-column:2/4;color:var(--muted);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.grp>summary{list-style:none;cursor:pointer}details.grp>summary::-webkit-details-marker{display:none}details.grp>summary h3{display:inline-block}details.grp:not([open])>summary h3::after{content:"  ▸ show";font-weight:500;text-transform:none;letter-spacing:0;color:var(--muted)}
details.ci summary{cursor:pointer;margin:12px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--bad);font-weight:700}
.causes h3{color:var(--sub)}
.cz{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:3px 8px;align-items:center;width:100%;border:0;background:none;font:inherit;font-size:12px;color:var(--sub);text-align:left;padding:4px 6px;border-radius:7px;cursor:pointer}
.cz:hover{background:var(--chip)}.cz[aria-pressed=true]{background:var(--chip);box-shadow:inset 0 0 0 1.5px var(--tint);color:var(--fg)}
.cz .k{width:8px;height:8px;border-radius:2px;background:var(--hc)}
.cz .n{font-weight:650;color:var(--fg)}
.cz .b{grid-column:2/4;height:3px;border-radius:2px;background:color-mix(in srgb,var(--line) 70%,transparent);overflow:hidden}.cz .b i{display:block;height:100%;width:var(--w);background:var(--hc)}
.h-ci{--hc:var(--bad)}
details.allc>summary{cursor:pointer;color:var(--tint);font-size:12px;padding:4px 6px}
.clear{border:0;background:none;font:inherit;font-size:12px;color:var(--tint);cursor:pointer;padding:0;margin-left:6px}
::view-transition-group(*){animation-duration:.3s;animation-timing-function:cubic-bezier(.16,1,.3,1)}
::view-transition-old(root),::view-transition-new(root){animation-duration:.16s}
/* Station belt: moves only for real arrivals in the 24 h before the snapshot; speed grows with the count. Still = none, dashed = no ledger. */
.station{margin:0 0 6px}
.belt{height:6px;border-radius:3px;background:color-mix(in srgb,var(--line) 70%,transparent);overflow:hidden;position:relative}
.belt::before{content:"";position:absolute;top:0;bottom:0;left:-16px;right:0;background:repeating-linear-gradient(90deg,transparent 0 9px,color-mix(in srgb,var(--tint) 60%,transparent) 9px 13px,transparent 13px 16px)}
.belt.on::before{animation:belt var(--spd) linear infinite}
.belt.zero::before{opacity:.25}
.belt.nodata{background:none;box-shadow:inset 0 0 0 1px var(--line);background-image:repeating-linear-gradient(90deg,var(--line) 0 3px,transparent 3px 7px);background-size:100% 1px;background-repeat:no-repeat;background-position:0 50%}.belt.nodata::before{display:none}
@keyframes belt{to{transform:translateX(16px)}}
.flow{display:flex;justify-content:space-between;gap:6px;font-size:11px;color:var(--muted);margin-top:3px}
.flow b{color:var(--sub);font-weight:650}
.crew{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--muted);margin-top:2px;flex-wrap:wrap}.crew .g{display:inline-flex;align-items:center;gap:4px}
/* Agent progress: one segment per checklist item from the agent's own list; only a live agent's active segment moves. */
.prog{display:flex;gap:2px;height:5px;margin:5px 0 3px}
.prog i{flex:1;min-width:2px;border-radius:1.5px;background:color-mix(in srgb,var(--line) 85%,transparent)}
.prog i.d{background:#30a46c}.prog i.b{background:var(--bad)}.prog i.x{background:none;box-shadow:inset 0 0 0 1px var(--line)}
.prog i.a{background:var(--tint);position:relative;overflow:hidden}
.prog.live i.a::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--card) 75%,transparent),transparent);transform:translateX(-100%);animation:work 1.8s cubic-bezier(.16,1,.3,1) infinite}
@keyframes work{to{transform:translateX(100%)}}
.prog.big{height:7px;margin:4px 0}
.now{display:flex;gap:5px;font-size:11.5px;color:var(--sub);min-width:0;align-items:baseline}
.now .k{color:var(--muted);flex:none}.now .k.live{color:#30a46c;font-weight:600}
.now .x{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.now .pc{margin-left:auto;color:var(--muted);flex:none}
.col.compact .prog,.col.compact .now,.col.compact .fix{display:none}
svg.i{width:12px;height:12px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transform:translateY(1px)}
.fix{display:flex;align-items:baseline;gap:5px;font-size:11.5px;color:var(--sub);margin-top:4px;min-width:0}
.fix.spent{color:var(--bad)}
.fix .x{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sec{margin-top:8px;padding-top:6px;border-top:.5px solid var(--line)}
.sec h5{margin:0 0 3px;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.sec .sub{color:var(--muted);font-size:11.5px}
.todo{list-style:none;padding:0!important;margin:3px 0!important}.todo li{display:flex;gap:6px;align-items:baseline}
.todo .m{width:8px;height:8px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--muted);flex:none}
.todo .in_progress .m{background:var(--tint);box-shadow:none}.todo .blocked .m{border-radius:2px;box-shadow:inset 0 0 0 1.5px var(--bad)}.todo .blocked{color:var(--bad)}
.mix{display:flex;height:6px;border-radius:3px;overflow:hidden;margin:4px 0 3px}.mix i{display:block}
.mixl{display:flex;flex-wrap:wrap;gap:1px 9px;font-size:11px;color:var(--muted)}
.mixl span::before{content:"";display:inline-block;width:7px;height:7px;border-radius:2px;background:var(--c);margin-right:3px}
.log{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sub);margin:3px 0 0}
.log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log b{display:inline-block;min-width:48px;color:var(--muted);font-weight:600}
.log .said{font-family:-apple-system,system-ui,sans-serif;font-style:italic;white-space:normal}
.card.open .log div{animation:tick .3s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i)*45ms)}
@keyframes tick{from{opacity:0;transform:translateY(4px)}}
.bay{border:.5px solid var(--line);border-radius:10px;padding:8px 10px 9px;margin:2px 0 10px}
.bay h3{margin:0 0 6px;color:var(--sub)}
.bay .row{display:flex;justify-content:space-between;gap:8px;width:100%;border:0;background:none;font:inherit;font-size:12px;color:var(--sub);text-align:left;padding:3px 6px;margin:0 -6px;border-radius:6px;box-sizing:content-box}
.bay button.row{cursor:pointer}.bay button.row:hover{background:var(--chip)}.bay button.row[aria-pressed=true]{background:var(--chip);box-shadow:inset 0 0 0 1.5px var(--tint);color:var(--fg)}
.bay .row b{color:var(--fg)}.bay .row.none b{color:var(--muted);font-weight:500}
.bay .lst{margin-top:6px}
@media(prefers-reduced-motion:reduce){
.dot.running.live::after{animation:none;transform:scale(1.9);opacity:.3}.fact.fresh::before{animation:none}
.belt.on::before,.prog.live i.a::after,.card.open .log div{animation:none}
.card.flash{animation:none;outline:2px solid var(--tint)}.xd{transition:none}
::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none}}
@media(max-width:700px){
header{position:static;padding:10px 12px 6px}h1{font-size:18px}
.totals{margin-left:0;width:100%}.tot{padding:2px 9px;font-size:12px}
.machines{gap:6px}.machine{width:100%;padding:6px 8px;gap:4px 8px;font-size:12px}.meter{display:none}.slots{flex-wrap:wrap}
.legend,#q{display:none}.controls{gap:6px}.seg button{padding:3px 8px;font-size:12px}
.layout{padding:8px 10px;gap:10px}
.rail{position:static;max-height:none}
.board{grid-template-columns:none;grid-auto-columns:86vw;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.col{scroll-snap-align:start}
.failure{margin:8px 10px 0}
#pop{display:none!important}}
#pop{position:fixed;z-index:10;max-width:340px;background:var(--card);border:.5px solid var(--line);border-radius:10px;box-shadow:0 8px 28px #0003;padding:10px 12px;display:none;pointer-events:none;font-size:12.5px}
#pop h4{margin:0 0 2px;font-size:13px}
#pop .s{color:var(--muted);margin-bottom:6px}
`;

const SCRIPT = `
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const url=u=>{try{const p=new URL(String(u),location.href);return p.protocol==="http:"||p.protocol==="https:"?esc(p.href):"#"}catch{return"#"}};
const HNAME={broken:"Broken",stale:"Stale",you:"Waiting on you",slow:"Slow",blocked:"Blocked",ok:"OK"};
const RANK={broken:0,stale:1,you:2,slow:3,blocked:4,ok:5};
const HC={broken:"bad",stale:"stale",you:"you",slow:"warn",blocked:"muted",ok:"ok"};
const MIXC={read:["Reading","var(--tint)"],run:["Running commands","#30a46c"],edit:["Editing","var(--you)"],wait:["Waiting","var(--warn)"],team:["Delegating, asking","var(--srv)"],linear:["Updating Linear","var(--muted)"]};
const ACT={resume:"resumed",escalate:"diagnosis asked",succeed:"successor",diagnostic:"diagnostic",start:"started",verify:"verified"};
const CAUSE_KIND={broken:"Broken",stale:"Stale",you:"Waiting on you",ci:"CI red"};
const SHOWN=10;
const COMPACT=new Set(["labelled","merged"]);
const state={host:"all",view:"all",q:"",only:null,cause:null,fix:null,open:new Set(),exp:new Set()};
const REDUCE=matchMedia("(prefers-reduced-motion:reduce)");
// NOW is the view's own snapshot time: ages read as of that reading, never as of the browser clock.
let D=null,NOW=0,HKEY={},byId={},readAt=0,stewardAt=null;
const causeKey=([k,c])=>k+"|"+c;
const causeLabel=([k,c])=>k==="ci"?"CI red: "+c:c;
const ms=t=>t?NOW-Date.parse(t):null;
function ago(t){const m=ms(t);if(m==null||!isFinite(m))return null;const s=Math.max(0,m/1000);if(s<90)return Math.round(s)+"s";if(s<5400)return Math.round(s/60)+"m";if(s<172800)return Math.round(s/3600)+"h";return Math.round(s/86400)+"d"}
const A=t=>ago(t)==null?"–":ago(t);
const fmtH=h=>h<1?Math.round(h*60)+"m":h+"h";
const mins=m=>m==null?"unknown":m<90?Math.round(m)+" min":m<2880?Math.round(m/60)+" h":Math.round(m/1440)+" d";
const plain=s=>String(s==null?"":s).split("**").join("");
function update(fn){if(!document.startViewTransition||REDUCE.matches){fn();return}document.startViewTransition(fn)}
const hostChip=k=>\`<span class="chip \${HKEY[k]==null?"hostnone":"hst"+HKEY[k]}">\${esc(k)}</span>\`;
function primary(r){const k=r.health;return (r.reasons[k]||[])[0]||""}
function visible(r){
  if(state.host==="none"&&r.hosts.length)return false;
  if(state.host!=="all"&&state.host!=="none"&&!r.hosts.includes(state.host))return false;
  if(state.view==="problems"&&!["broken","stale","you"].includes(r.health))return false;
  if(state.view==="agents"&&!r.agents.length)return false;
  if(state.only&&r.health!==state.only)return false;
  if(state.cause&&!r.causes.some(c=>causeKey(c)===state.cause))return false;
  if(state.fix&&!(inBay(r)&&FIX[state.fix](r)))return false;
  if(state.q){const q=state.q.toLowerCase();if(!(r.id.toLowerCase().includes(q)||(r.title||"").toLowerCase().includes(q)))return false}
  return true}
const sortRows=a=>a.sort((x,y)=>RANK[x.health]-RANK[y.health]||(x.ciOnly-y.ciOnly)||(ms(y.since)||0)-(ms(x.since)||0));
function seg(el,key,opts){el.innerHTML=opts.map(([v,l])=>\`<button data-v="\${esc(v)}" aria-pressed="\${state[key]===v}">\${esc(l)}</button>\`).join("");
  el.onclick=e=>{const b=e.target.closest("button");if(!b)return;update(()=>{state[key]=b.dataset.v;render()})}}
function factHtml(label,at,quiet){
  const old=at&&ms(at)>90e3&&!quiet;
  const fresh=at&&!old&&!quiet;
  return \`<span class="fact\${old?" old":fresh?" fresh":""}" title="\${esc(at||"never read")}">\${esc(label)} \${at?A(at)+" ago":"never read"}</span>\`}
function machines(){
  const hosts=D.hosts.map(h=>{
    const a=h.agents,run=a.running||0,idle=a.idle||0,err=a.error||0,perm=a.permission||0,init=a.initializing||0,max=h.maxRunning||Math.max(run,1);
    const facts=(h.facts||[]).map(([l,t])=>factHtml(l,t,l.startsWith("Plan journal"))).join("");
    return \`<div class="machine"><b class="mh\${HKEY[h.key]==null?0:HKEY[h.key]}">\${esc(h.key)}</b>
      <span class="slots"><span class="meter"><i style="width:\${Math.min(100,run/max*100)}%;background:#30a46c"></i></span>\${run} running <span class="fact">(cap \${h.maxRunning==null?"?":esc(h.maxRunning)})</span> · \${idle} idle\${init?\` · \${init} starting\`:""}\${err?\` · <span style="color:var(--bad)">\${err} error</span>\`:""}\${perm?\` · <span style="color:var(--you)">\${perm} asking permission</span>\`:""}</span>\${facts}</div>\`}).join("");
  const sources=(D.sources||[]).map(([name,at])=>\`<div class="machine"><span class="chip blk">\${esc(name)}</span>\${at?factHtml("read",at,false):'<span class="fact old">unavailable</span>'}</div>\`).join("");
  const missing=(D.unreachable||[]).length?\`<div class="machine bad"><span class="chip blk">unreachable</span><span class="fact old">\${D.unreachable.map(esc).join(", ")} · facts missing</span></div>\`:"";
  return hosts+sources+missing}
function dot(a){
  const silent=a.status==="running"&&a.quietMin!=null&&a.quietMin>20;
  const cls=a.permission?"perm":a.status==="running"?(silent?"running silent":"running live"):a.status;
  const quiet=a.quietMin==null?"":a.quietMin<120?\`\${a.quietMin} min\`:\`\${Math.round(a.quietMin/60)} h\`;
  const title=\`\${a.host} agent \${a.status}\${silent?\`, but silent for \${quiet}\`:quiet?\`, last update \${quiet} ago\`:""}\${a.permission?", waiting for permission":""}\`;
  return \`<span class="dot \${cls}" title="\${esc(title)}"></span>\`}
const WRENCH=\`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/></svg>\`;
const isLive=a=>a.status==="running"&&a.quietMin!=null&&a.quietMin<=20;
function tally(cl){
  const done=cl.done,total=cl.total,open=Math.min(cl.items.length,Math.max(0,total-done));
  return {done,total,open,act:cl.items.some(i=>i[1]==="in_progress")?1:0,gone:Math.max(0,total-done-open)}}
function lead(r){
  return r.agents.filter(a=>a.inside).sort((x,y)=>isLive(y)-isLive(x)||(y.status==="running")-(x.status==="running")
    ||!!y.inside.checklist-!!x.inside.checklist||(x.quietMin??1e9)-(y.quietMin??1e9))[0]||null}
// One segment per item of the agent's own checklist: done, active, open, dropped. Only a live agent's active segment moves.
function progBar(cl,live,big){
  const t=tally(cl),parts=[["d",t.done],["a",t.act],["o",Math.max(0,t.open-t.act)],["x",t.gone]].filter(p=>p[1]);
  const segs=cl.total<=24?parts.flatMap(([c,n])=>Array(n).fill(\`<i class="\${c}"></i>\`)):parts.map(([c,n])=>\`<i class="\${c}" style="flex:\${n}"></i>\`);
  const label=\`\${t.done} of \${t.total} done, \${t.open} open\`;
  return \`<div class="prog\${live&&t.act?" live":""}\${big?" big":""}" role="img" aria-label="\${esc(label)}" title="\${esc(label+" (the agent's own checklist)")}">\${segs.join("")}</div>\`}
const VERB=a=>isLive(a)?["Now","live"]:a.status==="running"?["Silent "+mins(a.quietMin)+", at",""]:["Stopped at",""];
function nowText(a){const v=a.inside,cur=(v.checklist?v.checklist.items:[]).find(i=>i[1]==="in_progress");return plain(cur?cur[0]:v.said||v.recent[v.recent.length-1]||"")}
function inside(r){
  const a=lead(r);if(!a)return"";
  const cl=a.inside.checklist,v=VERB(a),txt=nowText(a);
  const when=isLive(a)?"Live: its last update is under 20 min old":\`Last update \${mins(a.quietMin)} before the snapshot\`;
  return (cl?progBar(cl,isLive(a)):"")+\`<div class="now"><span class="k \${v[1]}" title="\${esc(when)}">\${esc(v[0])}</span><span class="x" title="\${esc(txt)}">\${esc(txt)||"–"}</span><span class="pc">\${cl?\`\${tally(cl).done}/\${cl.total}\`:"no checklist"}</span></div>\`}
const actsTxt=a=>Object.entries(a).sort((x,y)=>y[1]-x[1]).map(([k,n])=>n+" "+(ACT[k]||k)).join(", ");
const inBay=r=>(r.health==="broken"&&!r.ciOnly)||r.health==="stale";
const tries=r=>Object.values(r.repair.acts24||{}).reduce((x,y)=>x+y,0);
const FIX={tried:r=>tries(r)>0,untouched:r=>!tries(r),spent:r=>!!(r.repair.watchdog&&r.repair.watchdog.exhaustedAt)};
function fixLine(r){
  if(!inBay(r))return"";
  const p=r.repair,n=tries(r),parts=[];
  if(n)parts.push(\`Steward \${n}× in 24h: \${actsTxt(p.acts24)}\`);
  if(p.watchdog&&p.watchdog.exhaustedAt)parts.push(\`watchdog used up \${A(p.watchdog.exhaustedAt)} ago\`);
  const txt=parts.join(" · ")||"No automatic repair in 24h";
  return \`<div class="fix\${!n&&p.watchdog&&p.watchdog.exhaustedAt?" spent":""}">\${WRENCH}<span class="x" title="\${esc(txt)}">\${esc(txt)}</span></div>\`}
function step(x){
  const i=x.indexOf(": "),head=i>0&&i<24&&!/\\s/.test(x.slice(0,i))?x.slice(0,i+1):"";
  return head?\`<b>\${esc(head)}</b> \${esc(x.slice(i+2))}\`:esc(x)}
function insideDet(r){
  const ags=r.agents.filter(a=>a.inside);
  if(!ags.length)return r.agents.length?\`<div class="sec"><h5>Inside the agent</h5><div class="sub">Not read: the agent was gone when the facts were collected.</div></div>\`:"";
  const first=lead(r);ags.sort((x,y)=>(y===first)-(x===first));
  return ags.slice(0,2).map(a=>{
    const v=a.inside,cl=v.checklist,tot=v.mix.reduce((m,x)=>m+x[1],0),t=cl?tally(cl):null;
    const head=\`\${a.host} agent · \${a.status} · last update \${mins(a.quietMin)} before the snapshot\`;
    const chk=cl?\`\${progBar(cl,isLive(a),true)}<div class="sub">\${t.done} of \${t.total} done · \${t.open} open</div>\`
      +(cl.items.length?\`<ul class="todo">\${cl.items.slice(0,6).map(([x,s])=>\`<li class="\${esc(s)}"><span class="m"></span><span>\${esc(x)}</span></li>\`).join("")}\${cl.items.length>6?\`<li class="sub">+\${cl.items.length-6} more</li>\`:""}</ul>\`:"")
      :\`<div class="sub">No checklist in the timeline tail: progress unknown, not 0%.</div>\`;
    const mix=tot?\`<div class="sub" style="margin-top:6px">Work mix, recent tool calls</div><div class="mix" role="img" aria-label="Work mix">\${v.mix.map(([g,n])=>\`<i style="flex:\${n};background:\${MIXC[g]?MIXC[g][1]:"var(--muted)"}" title="\${esc((MIXC[g]?MIXC[g][0]:g)+": "+n)}"></i>\`).join("")}</div><div class="mixl">\${v.mix.map(([g,n])=>\`<span style="--c:\${MIXC[g]?MIXC[g][1]:"var(--muted)"}">\${esc(MIXC[g]?MIXC[g][0]:g)} \${Math.round(n/tot*100)}%</span>\`).join("")}</div>\`:"";
    const log=v.recent.length?\`<div class="sub" style="margin-top:6px">Last steps, oldest first</div><div class="log">\${v.recent.map((x,i)=>\`<div style="--i:\${i}">\${step(x)}</div>\`).join("")}\${v.said?\`<div class="said"><b>said</b> \${esc(plain(v.said))}</div>\`:""}</div>\`:"";
    return \`<div class="sec"><h5>Inside the agent</h5><div class="sub">\${esc(head)}</div>\${chk}\${mix}\${log}</div>\`}).join("")}
function repairDet(r){
  const p=r.repair;if(!inBay(r))return"";
  const rows=[];
  if(p.watchdog)rows.push(["Watchdog",\`\${p.watchdog.total} cycle\${p.watchdog.total===1?"":"s"} run, \${p.watchdog.used24} of \${p.watchdog.cap} in 24h\${p.watchdog.exhaustedAt?\` · gave up \${A(p.watchdog.exhaustedAt)} ago\`:""}\${p.watchdog.cycle?\` · now: \${p.watchdog.cycle}\`:""}\`]);
  if(p.steward)rows.push(["Steward",\`\${p.steward.total} restarts, \${p.steward.used24} of \${p.steward.cap} in 24h\${p.steward.refusals?\` · \${p.steward.refusals} refused\`:""}\${p.steward.escalatedAt?\` · escalated \${A(p.steward.escalatedAt)} ago\`:""}\`]);
  if(p.steward&&p.steward.lastRefusal)rows.push(["Last refusal",p.steward.lastRefusal]);
  if(p.drops)rows.push(["Queue drops",String(p.drops)]);
  const log=(p.log||[]).map(([t,x])=>\`<div><b>\${A(t)}</b> \${esc(x)}</div>\`).join("");
  return \`<div class="sec"><h5>Repair</h5>\${rows.length?\`<table>\${rows.map(([k,v])=>\`<tr><td>\${esc(k)}</td><td>\${esc(v)}</td></tr>\`).join("")}</table>\`:\`<div class="sub">No automatic repair on record.</div>\`}
    \${log?\`<div class="sub" style="margin-top:6px">Steward, last actions</div><div class="log">\${log}</div>\`:""}</div>\`}
function station(stage,all){
  const f=D.flow[stage];
  const belt=!f?\`<div class="belt nodata" title="No ledger records arrivals at this station"></div>\`
    :\`<div class="belt \${f.n?"on":"zero"}" style="--spd:\${Math.max(.35,2.4/Math.sqrt(f.n||1)).toFixed(2)}s" title="\${esc(f.n+" "+f.what+" in the 24 h before the snapshot"+(f.extra?" · "+f.extra:""))}"></div>\`;
  const flow=f?\`<span><b>+\${esc(f.n)}</b> \${esc(f.what)}\${f.extra?\` · \${esc(f.extra)}\`:""}</span><span>24h</span>\`:"<span>no flow ledger</span>";
  const ags=all.flatMap(r=>r.agents),live=ags.filter(isLive).length;
  const silent=ags.filter(a=>a.status==="running").length-live,idle=ags.filter(a=>a.status==="idle").length;
  const g=(n,cls,l)=>n?\`<span class="g"><span class="dot \${cls}"></span>\${n} \${l}</span>\`:"";
  const crew=ags.length?\`<div class="crew">\${g(live,"running live","working")}\${g(silent,"running silent","silent")}\${g(idle,"idle","idle")}</div>\`:"";
  return \`<div class="station">\${belt}<div class="flow">\${flow}</div>\${crew}</div>\`}
function bay(rows){
  const rs=rows.filter(inBay);if(!rs.length&&!state.fix)return"";
  const acts={};rs.forEach(r=>Object.entries(r.repair.acts24||{}).forEach(([k,n])=>acts[k]=(acts[k]||0)+n));
  const n=Object.values(acts).reduce((x,y)=>x+y,0),cnt=k=>rs.filter(FIX[k]).length,drops=rs.reduce((m,r)=>m+(r.repair.drops||0),0);
  const btn=(k,l)=>\`<button class="row" data-fix="\${k}" aria-pressed="\${state.fix===k}" title="Show only these tickets"><span>\${l}</span><b>\${cnt(k)}</b></button>\`;
  const phone=matchMedia("(max-width:700px)").matches;
  return \`<details class="grp bay"\${phone&&!state.fix?"":" open"}><summary><h3>Repair bay · \${rs.length}</h3></summary>\${state.fix?\`<button class="clear" data-fix="">Clear filter</button>\`:""}
    <div class="belt \${n?"on":"zero"}" style="--spd:\${Math.max(.35,2.4/Math.sqrt(n||1)).toFixed(2)}s" title="Steward repair actions on these tickets in the 24 h before the snapshot (the log keeps 10 per ticket)"></div>
    <div class="flow"><span><b>\${n}</b> steward repair actions\${n?": "+esc(actsTxt(acts)):""}</span><span>24h</span></div>
    <div class="lst"><div class="row"><span>Broken or stale, CI-only excluded</span><b>\${rs.length}</b></div>
    \${btn("tried","Repair tried in 24h")}\${btn("untouched","No repair in 24h")}\${btn("spent","Watchdog used up")}
    <div class="row"><span>Queue drops on their PRs</span><b>\${drops}</b></div></div></details>\`}
function detail(r){
  const reasons=Object.entries(r.reasons||{}).flatMap(([k,a])=>(a||[]).map(x=>\`<li class="\${esc(k)}">\${esc(x)}</li>\`)).join("");
  const agents=r.agents.map(a=>\`\${a.host}: \${a.status}\${a.status==="running"&&a.quietMin!=null&&a.quietMin>20?\` (silent \${mins(a.quietMin)})\`:""}\${a.permission?" (asks permission)":""}\`).join(", ")||"none";
  const prs=r.prs.map(p=>"#"+p.num+(p.failed?" CI red":p.running?" CI running":" CI green")+(p.conflict?", conflicts":"")+(p.dnm?", do-not-merge":"")+(p.draft?", draft":"")+(p.drops?", "+p.drops+" queue drops":"")).join("; ")||"none";
  const status=r.status?esc(r.status)+(r.project?" · "+esc(r.project):""):"not in Linear";
  const steward=r.situation?\`<tr><td>Steward</td><td>\${esc(r.situation)}\${r.unverified&&stewardAt?\` (last pass \${A(stewardAt)} ago)\`:""}</td></tr>\`:"";
  return \`<table><tr><td>Linear</td><td>\${status}</td></tr><tr><td>Stage</td><td>\${esc(D.labels[r.stage]||r.stage)} for \${A(r.since)}</td></tr>
    <tr><td>Activity</td><td>\${r.last?\`\${A(r.last)} ago\`:"none seen"}</td></tr><tr><td>Agents</td><td>\${esc(agents)}</td></tr><tr><td>PRs</td><td>\${esc(prs)}</td></tr>
    \${steward}</table>\${reasons?\`<ul>\${reasons}</ul>\`:""}\`}
function card(r){
  const lim=D.limits?D.limits[r.stage]:null,raw=ms(r.since),h=raw==null?0:raw/36e5;
  const ageCls=lim&&raw!=null&&h>lim[1]?"red":lim&&raw!=null&&h>lim[0]?"over":"";
  const hosts=r.hosts.length?r.hosts.map(hostChip).join(""):\`<span class="chip none">no agent</span>\`;
  const prs=r.prs.slice(0,2).map(p=>\`<a class="pr" href="\${url(p.url)}" target="_blank" rel="noreferrer">#\${esc(p.num)} \${p.failed?'<span class="x">✗</span>':p.running?'<span class="run">●</span>':'<span class="ok">✓</span>'}\${p.conflict?" ⇄":""}\${p.dnm?" ⛔":""}</a>\`).join("")+(r.prs.length>2?\`<span>+\${r.prs.length-2}</span>\`:"");
  const blk=r.reasons.blocked.length&&r.health!=="blocked"?\`<span class="chip blk">blocked</span>\`:"";
  const why=r.health!=="ok"?\`<div class="why">\${esc(primary(r))}</div>\`:"";
  // Time left before the red limit; past it, the red age already says everything.
  const clock=lim&&raw!=null&&h>=0&&h<lim[1]?\`<span class="clock \${ageCls}" title="\${esc(A(r.since)+" in stage; orange at "+fmtH(lim[0])+", red at "+fmtH(lim[1]))}"><i style="--p:\${(h/lim[1]*100).toFixed(1)}%"></i></span>\`:"";
  const open=state.exp.has(r.id);
  return \`<div class="card h-\${esc(r.health)}\${r.unverified?" unverified":""}\${open?" open":""}" data-id="\${esc(r.id)}" style="view-transition-name:c-\${esc(r.id)}" tabindex="0" aria-expanded="\${open}">
    <div class="l1"><span class="id">\${esc(r.id)}</span>\${hosts}\${r.agents.map(dot).join("")}<span class="age \${ageCls}" title="In this stage since \${esc(r.since||"unknown")}">\${A(r.since)}</span></div>
    <div class="t">\${esc(r.title)}</div>\${inside(r)}
    <div class="l3">\${blk}<span title="Last activity \${esc(r.last||"none")}">active \${r.last?\`\${A(r.last)} ago\`:"–"}</span>\${prs}</div>\${why}\${fixLine(r)}
    <div class="xd"><div>\${open?expBody(r):""}</div></div>\${clock}</div>\`}
function expBody(r){
  const acts=[r.url?\`<a href="\${url(r.url)}" target="_blank" rel="noreferrer">Open in Linear</a>\`:""].concat(r.prs.map(p=>\`<a href="\${url(p.url)}" target="_blank" rel="noreferrer">PR #\${esc(p.num)}</a>\`)).filter(Boolean).join("");
  return \`<div class="det">\${detail(r)}\${insideDet(r)}\${repairDet(r)}<div class="acts">\${acts}</div></div>\`}
function column(stage,rows){
  const all=sortRows(rows.filter(r=>r.stage===stage)),lim=D.limits?D.limits[stage]:null;
  const cnt={};all.forEach(r=>cnt[r.health]=(cnt[r.health]||0)+1);
  const bar=Object.keys(RANK).map(k=>cnt[k]?\`<i style="flex:\${cnt[k]};background:var(--\${HC[k]})" title="\${cnt[k]} \${HNAME[k]}"></i>\`:"").join("");
  const open=state.open.has(stage),shown=open?all:all.slice(0,SHOWN),rest=all.slice(SHOWN);
  const restTxt=Object.entries(rest.reduce((m,r)=>(m[r.health]=(m[r.health]||0)+1,m),{})).map(([k,n])=>n+" "+HNAME[k].toLowerCase()).join(", ");
  const oldest=all.reduce((m,r)=>Math.max(m,ms(r.since)||0),0);
  return \`<section class="col\${COMPACT.has(stage)?" compact":""}"><h2>\${esc(D.labels[stage]||stage)}<span class="n">\${all.length}</span></h2>
    <div class="lim">\${lim?\`limit \${fmtH(lim[0])} / \${fmtH(lim[1])}\`:"today"}\${all.length?\` · oldest \${A(new Date(NOW-oldest).toISOString())}\`:""}</div>
    \${station(stage,all)}<div class="bar">\${bar}</div>
    \${shown.map(card).join("")||'<div class="empty">Nothing here</div>'}
    \${rest.length?\`<button class="more" data-stage="\${esc(stage)}">\${open?"Show fewer":\`+\${rest.length} more (\${esc(restTxt)})\`}</button>\`:""}</section>\`}
function attItem(r,k){const reasons=r.reasons[k]||[];return \`<button class="att h-\${esc(k)}" data-id="\${esc(r.id)}" title="Show \${esc(r.id)} on the board"><span class="id">\${esc(r.id)}</span><span class="r">\${esc(reasons[0]||"")}\${reasons.length>1?\` <span style="color:var(--muted)">+\${reasons.length-1}</span>\`:""}</span><span class="a">\${A(r.since)}</span><span class="m">\${esc(r.hosts.join(" + ")||"no agent")} · \${esc(D.labels[r.stage]||r.stage)} · \${esc(r.title)}</span></button>\`}
function causes(rows){
  const cnt=new Map();
  rows.forEach(r=>r.causes.forEach(c=>{const k=causeKey(c);cnt.set(k,{c,n:(cnt.get(k)||{n:0}).n+1})}));
  if(state.cause&&!cnt.has(state.cause))cnt.set(state.cause,{c:state.cause.split(/\\|(.*)/s).slice(0,2),n:0});
  const list=[...cnt.values()].sort((a,b)=>b.n-a.n),max=Math.max(1,...list.map(x=>x.n));
  if(!list.length)return"";
  const btn=({c,n})=>\`<button class="cz h-\${esc(c[0])}" data-cause="\${esc(causeKey(c))}" aria-pressed="\${state.cause===causeKey(c)}" title="\${esc((CAUSE_KIND[c[0]]||c[0])+": show only these tickets")}"><span class="k"></span><span>\${esc(causeLabel(c))}</span><span class="n">\${n}</span><span class="b"><i style="--w:\${(n/max*100).toFixed(1)}%"></i></span></button>\`;
  const top=list.slice(0,6),rest=list.slice(6);
  return \`<section class="causes"><h3>Causes · tickets\${state.cause?\`<button class="clear" data-cause="">Clear filter</button>\`:""}</h3>\${top.map(btn).join("")}
    \${rest.length?\`<details class="allc"><summary>\${rest.length} more causes</summary>\${rest.map(btn).join("")}</details>\`:""}</section>\`}
function rail(rows,causeRows,bayRows){
  const by=k=>sortRows(rows.filter(r=>r.health===k));
  const core=by("broken").filter(r=>!r.ciOnly),ci=by("broken").filter(r=>r.ciOnly),stale=by("stale"),you=by("you");
  const oldest=a=>a.sort((x,y)=>(ms(y.since)||0)-(ms(x.since)||0));
  const phone=matchMedia("(max-width:700px)").matches;
  const grp=(t,k,a,hc)=>a.length?\`<details class="grp"\${!phone||k==="broken"?" open":""}><summary><h3 style="--hc:var(--\${hc})">\${t} · \${a.length}</h3></summary>\`+oldest(a).map(r=>attItem(r,k)).join("")+"</details>":"";
  return \`<h2>Needs attention</h2>\${bay(bayRows)}\${causes(causeRows)}
    \${grp("Broken","broken",core,"bad")}\${grp("Stale","stale",stale,"stale")}\${grp("Waiting on you","you",you,"you")}
    \${ci.length?\`<details class="ci"><summary>CI red, nothing else wrong · \${ci.length}</summary>\${oldest(ci).map(r=>attItem(r,"broken")).join("")}</details>\`:""}
    \${!core.length&&!stale.length&&!you.length&&!ci.length?'<div class="empty">Nothing needs you right now.</div>':""}\`}
const without=(k,f)=>{const o=state[k];state[k]=null;try{return f()}finally{state[k]=o}};
function hostOptions(){return [["all","All hosts"]].concat(D.hosts.map(h=>[h.key,h.key]),[["none","No agent"]])}
function render(){
  if(!D){
    $("totals").innerHTML="";$("machines").innerHTML="";$("hostSeg").innerHTML="";$("viewSeg").innerHTML="";
    $("rail").hidden=true;
    $("board").innerHTML='<div class="empty">Waiting for the backend…</div>';$("rail").innerHTML="";return}
  byId=Object.fromEntries(D.rows.map(r=>[r.id,r]));
  const rows=D.rows.filter(visible);
  const all=without("only",()=>D.rows.filter(visible));
  const causeRows=without("cause",()=>D.rows.filter(visible)),bayRows=without("fix",()=>D.rows.filter(visible));
  const n=k=>all.filter(r=>r.health===k).length;
  $("totals").innerHTML=["broken","stale","you","slow"].map(k=>\`<button class="tot \${k}" data-k="\${k}" aria-pressed="\${state.only===k}">\${n(k)} \${HNAME[k].toLowerCase()}</button>\`).join("");
  $("machines").innerHTML=machines();
  seg($("hostSeg"),"host",hostOptions());
  seg($("viewSeg"),"view",[["all","All tickets"],["problems","Problems only"],["agents","With an agent"]]);
  const board=$("board");board.style.setProperty("--cols",D.stages.map(s=>COMPACT.has(s)?"minmax(150px,.7fr)":"minmax(214px,1fr)").join(" "));
  board.innerHTML=D.stages.map(s=>column(s,rows)).join("");
  $("rail").hidden=false;$("rail").innerHTML=rail(rows,causeRows,bayRows)}
function toggle(c,force){
  const id=c.dataset.id,open=force==null?!state.exp.has(id):force;
  if(open===state.exp.has(id)&&c.classList.contains("open")===open)return;
  open?state.exp.add(id):state.exp.delete(id);
  const body=c.querySelector(".xd>div");
  if(open){if(byId[id])body.innerHTML=expBody(byId[id]);c.offsetHeight;c.classList.add("open")}else c.classList.remove("open");
  c.setAttribute("aria-expanded",open);$("pop").style.display="none"}
// Attention list → its card: reveal it, open it, and mark where it is.
function locate(id){
  const r=byId[id];if(!r)return;let c=$("board").querySelector('.card[data-id="'+CSS.escape(id)+'"]');
  if(!c){state.open.add(r.stage);render();c=$("board").querySelector('.card[data-id="'+CSS.escape(id)+'"]')}
  if(!c)return;
  toggle(c,true);
  c.scrollIntoView({behavior:REDUCE.matches?"auto":"smooth",block:"center",inline:"center"});
  c.classList.remove("flash");c.offsetWidth;c.classList.add("flash");setTimeout(()=>c.classList.remove("flash"),1900)}
$("totals").onclick=e=>{const b=e.target.closest("button");if(!b)return;update(()=>{state.only=state.only===b.dataset.k?null:b.dataset.k;render()})};
$("board").addEventListener("click",e=>{
  if(e.target.closest("a")||e.target.closest(".det"))return;
  const c=e.target.closest(".card");if(c){toggle(c);return}
  const b=e.target.closest(".more");if(!b)return;const s=b.dataset.stage;update(()=>{state.open.has(s)?state.open.delete(s):state.open.add(s);render()})});
$("board").addEventListener("keydown",e=>{const c=e.target.closest(".card");if(c&&(e.key==="Enter"||e.key===" ")&&e.target===c){e.preventDefault();toggle(c)}});
$("rail").addEventListener("click",e=>{
  const f=e.target.closest("[data-fix]");
  if(f){e.preventDefault();const k=f.dataset.fix;update(()=>{state.fix=!k||state.fix===k?null:k;render()});return}
  const z=e.target.closest("[data-cause]");
  if(z){const k=z.dataset.cause;update(()=>{state.cause=!k||state.cause===k?null:k;render()});return}
  const a=e.target.closest(".att");if(a)locate(a.dataset.id)});
$("q").oninput=e=>{state.q=e.target.value.trim();render()};
document.addEventListener("visibilitychange",()=>{document.documentElement.classList.toggle("paused",document.hidden);if(!document.hidden&&Date.now()-readAt>55000)load()});
document.addEventListener("mouseover",e=>{
  const el=e.target.closest("[data-id]");if(!el||el.classList.contains("open")||!D){$("pop").style.display="none";return}
  const r=byId[el.dataset.id];if(!r){$("pop").style.display="none";return}
  $("pop").innerHTML=\`<h4>\${esc(r.id)} · \${HNAME[r.health]||r.health}\${r.unverified?" · unverified":""}</h4><div class="s">\${esc(r.title)}</div>\${detail(r)}\`;
  $("pop").style.display="block";const b=el.getBoundingClientRect(),w=$("pop").offsetWidth,h=$("pop").offsetHeight;
  let x=b.right+8;if(x+w>innerWidth-8)x=Math.max(8,b.left-w-8);const y=Math.min(b.top,innerHeight-h-8);$("pop").style.left=x+"px";$("pop").style.top=Math.max(8,y)+"px"});
function claim(data){
  if(!data||!Array.isArray(data.hosts)||!Array.isArray(data.rows)||!Array.isArray(data.stages)||!data.labels||!data.flow)
    throw new Error("the answer is not a board view");
  D=data;NOW=Date.parse(data.now)||Date.now();readAt=Date.now();
  HKEY={};D.hosts.forEach((h,i)=>{HKEY[h.key]=i%4});
  const fact=(data.hosts.flatMap(h=>h.facts||[]).find(f=>f[0]==="Steward: last pass")||[])[1];
  stewardAt=fact||null;
  document.documentElement.dataset.board="ready";
  $("failure").hidden=true;$("failure").textContent="";
  $("live").className="live";$("live").innerHTML="<i></i>Live · snapshot "+esc(new Date(NOW).toLocaleString("en-GB",{weekday:"short",hour:"2-digit",minute:"2-digit"}));
  render()}
function down(error){
  const text=String(error&&error.message||error||"unknown error");
  document.documentElement.dataset.board="unavailable";
  $("live").className="live down";$("live").innerHTML="<i></i>Backend unavailable";
  const when=D?new Date(readAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}):null;
  $("failure").hidden=false;
  $("failure").innerHTML="<b>Board backend unavailable</b> — "+esc(text)+". "+(when?\`Showing the last reading, read at \${esc(when)}. \`:"")+"Retrying every 60 s.";
  if(!D)render()}
async function load(){
  try{
    const answer=await fetch("/api/board",{headers:{accept:"application/json"},cache:"no-store"});
    if(!answer.ok)throw new Error("the board backend answered HTTP "+answer.status);
    claim(await answer.json());
  }catch(error){down(error)}}
load();
// Every read collects both hosts' facts and the tails of their working agents from the daemons;
// a page nobody sees asks nothing, and the visibilitychange handler catches up once it is shown.
setInterval(()=>{if(!document.hidden)load()},60000);
`;

export function boardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent board</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="top">
    <h1>Agent board</h1>
    <span class="live" id="live" role="status">connecting…</span>
    <div class="totals" id="totals"></div>
  </div>
  <div class="machines" id="machines"></div>
  <div class="controls">
    <div class="seg" id="hostSeg"></div>
    <div class="seg" id="viewSeg"></div>
    <input type="search" id="q" placeholder="Filter: TUC-123, title…">
    <div class="legend">
      <span style="--c:var(--bad)">broken</span><span style="--c:var(--stale)">stale</span><span style="--c:var(--you)">waiting on you</span><span style="--c:var(--warn)">slow (past red limit)</span><span style="--c:var(--muted)">blocked</span><span style="--c:var(--ok)">ok</span><span class="dash">unverified (source &gt; 90 s old)</span><span style="--c:color-mix(in srgb,var(--tint) 60%,transparent)">belt: arrivals in 24 h</span><span style="--c:#30a46c">bar: agent's own checklist</span>
    </div>
  </div>
</header>
<div class="failure" id="failure" role="alert" hidden></div>
<div class="layout">
  <div style="min-width:0"><div class="swipe">Swipe sideways for the stages →</div><main class="board" id="board" aria-label="Tickets by stage"><div class="empty">Waiting for the backend…</div></main></div>
  <aside class="rail" id="rail" aria-label="Needs attention"></aside>
</div>
<div id="pop" aria-hidden="true"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}