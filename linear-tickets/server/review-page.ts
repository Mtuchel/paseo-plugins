import { parsePlanRisk, combinedRating, ratingText } from "../shared/plan-risk";
import { planFollowUps } from "../shared/plan-sections";

// The review inbox's pages (README, "Review inbox"): the inbox, the closed-review page, and the
// service worker that shows its notifications. Everything here renders data; review-links.ts
// decides what is listed.

const SUMMARY_CHARS = 280;
// A review waiting this long gets its age highlighted.
const STALE_HOURS = 12;
export const INBOX_REFRESH_S = 30;

// What the inbox shows about a review's plan, read once from the plan text.
export type PlanDetails = {
  title: string | null;
  summary: string | null;
  // The `## Risk and impact` rating (planner and advisor combined); null when the plan has none.
  risk: { impact: number; text: string } | null;
  // Why the risk policy left it to the owner; absent when the policy did not judge the review.
  reasons?: string[];
  autoApproved?: boolean;
  // The plan's `follow-up` items (filed as tickets on approval) and whether it sets a new rule.
  followUps?: number;
  newRule?: boolean;
};

// One row of the inbox, from this host or a peer's /api/inbox. `link` opens the review (the
// agent's stable link); `since` is when the owner got the plan; decided rows add `outcome` (as
// shown: approved, auto-approved, sent back, ended) and `decidedAt`.
export type InboxRow = {
  agentId: string;
  name: string;
  link: string;
  since: string;
  host: string;
  outcome?: string;
  decidedAt?: string;
  details?: PlanDetails;
  model?: string;
  issueUrl?: string;
};
// `unreachable`: peers whose inbox did not answer, so their reviews are missing.
export type InboxView = { open: InboxRow[]; decided: InboxRow[]; unreachable: string[]; hosts: string[]; push: boolean };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--press:#ebebf0;--tint:#0a64d6;--chip:#ececf1;--ok:#1b7a3d;--ok-bg:#dcf5e3;--go:#1f8a45;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--press:#2c2c2e;--tint:#5aa9ff;--chip:#2c2c2e;--ok:#8fe0a8;--ok-bg:#123d22;--go:#2fa75a;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font:17px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--fg);background:var(--bg);font-variant-numeric:tabular-nums}::selection{background:color-mix(in srgb,var(--tint) 30%,transparent)}a{color:var(--tint)}
.bar{position:sticky;top:0;z-index:2;padding:calc(env(safe-area-inset-top) + 14px) max(20px,env(safe-area-inset-right)) 10px max(20px,env(safe-area-inset-left));background:color-mix(in srgb,var(--bg) 80%,transparent);-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px);border-bottom:.5px solid var(--line)}
.bar>div,main{max-width:36rem;margin:0 auto}.bar>div{display:flex;align-items:flex-end;gap:12px}.bar>div>div{flex:1;min-width:0}h1{margin:0;font-size:1.75rem;line-height:1.15;font-weight:700;letter-spacing:-.02em}.sub{margin:2px 0 0;font-size:.875rem;color:var(--muted)}.sub.offline::after{content:" · offline, retrying";color:var(--warn)}.missing{margin:4px 0 0;font-size:.8125rem;color:var(--warn)}
main{padding:4px max(16px,env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
h2{display:flex;align-items:baseline;gap:8px;margin:28px 4px 4px;font-size:1.25rem;font-weight:700;letter-spacing:-.01em}h2 .n{font-size:1rem;font-weight:600;color:var(--muted)}h2 .hint{margin-left:auto;font-size:.8125rem;font-weight:500;color:var(--muted)}
h3{margin:18px 4px 6px;font-size:.8125rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.list{list-style:none;margin:0;padding:0;background:var(--card);border-radius:14px;overflow:hidden}.list>li{position:relative}.list>li+li::before{content:"";position:absolute;top:0;left:16px;right:0;border-top:.5px solid var(--line)}
.row{position:relative;display:block;padding:12px 16px 13px;color:inherit;text-decoration:none}a.row{padding-right:36px;padding-bottom:8px;-webkit-tap-highlight-color:transparent;transition:background-color .25s ease-out}a.row:active{background:var(--press);transition:none}@media(hover:hover){a.row:hover{background:var(--press)}}a.row:focus-visible{outline:2px solid var(--tint);outline-offset:-2px}
.go{position:absolute;right:16px;top:50%;width:8px;height:14px;margin-top:-7px;color:var(--muted);opacity:.55}
.top{display:flex;align-items:baseline;gap:8px}.id{font-size:.8125rem;font-weight:600;color:var(--muted)}.when{margin-left:auto;font-size:.8125rem;color:var(--muted);white-space:nowrap}.when.stale{color:var(--warn);font-weight:600}
.title{margin-top:2px;font-weight:600;line-height:1.3;text-wrap:pretty}.summary{margin-top:4px;font-size:.9375rem;color:var(--sub);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.chip{font-size:.75rem;line-height:1.5;padding:2px 8px;border-radius:7px;background:var(--chip);color:var(--sub)}.low{background:var(--ok-bg);color:var(--ok)}.mid{background:var(--warn-bg);color:var(--warn)}.high{background:var(--bad-bg);color:var(--bad)}
.why{margin-top:6px;font-size:.8125rem;color:var(--muted)}.why b{font-weight:600;color:var(--sub)}
.facts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:0 16px 12px;font-size:.8125rem;color:var(--muted)}.row+.facts{margin-top:-2px}div.row+.facts{margin-top:-8px}.facts a{font-weight:600;text-decoration:none}.facts a:focus-visible{outline:2px solid var(--tint);outline-offset:2px;border-radius:4px}
.acts{display:flex;gap:8px;margin-left:auto}button{font:inherit;font-size:.875rem;font-weight:600;min-height:36px;padding:0 14px;border:0;border-radius:10px;cursor:pointer;background:var(--chip);color:var(--fg);-webkit-tap-highlight-color:transparent}button:focus-visible{outline:2px solid var(--tint);outline-offset:2px}button:active{filter:brightness(.92)}button.approve{background:var(--go);color:#fff}button[disabled]{opacity:.5;cursor:default}
.back{padding:0 16px 14px}.back textarea{display:block;width:100%;min-height:88px;padding:10px 12px;font:inherit;font-size:.9375rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;resize:vertical;caret-color:var(--tint)}.back textarea:focus{outline:2px solid var(--tint);outline-offset:-1px;border-color:transparent}.back div{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.status{margin:0;padding:0 16px 12px;font-size:.875rem;font-weight:600;color:var(--tint)}.status:empty{display:none}.status.failed{color:var(--bad)}li.done>a.row,li.done>.facts{opacity:.45}
.outcome{font-size:.75rem;font-weight:600;line-height:1.6;padding:0 8px;border-radius:999px;background:var(--chip);color:var(--sub)}.outcome.approved{background:var(--ok-bg);color:var(--ok)}.outcome.back{background:var(--warn-bg);color:var(--warn)}
.notify{flex:none;background:var(--tint);color:#fff}
.empty{margin:0;padding:28px 16px;text-align:center;color:var(--muted);background:var(--card);border-radius:14px}.empty b{display:block;color:var(--fg);font-size:1.0625rem}
.closed{padding:calc(env(safe-area-inset-top) + 48px) 24px 48px}.closed h1{font-size:1.4rem;margin-bottom:.5rem}`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(title)}</title>${head}<style>${PAGE_STYLE}</style></head>
<body>${body}</body></html>`;
}

export function closedPage(identifier: string | undefined, outcome: string): string {
  const subject = identifier ? `The plan review for ${escapeHtml(identifier)}` : "This plan review";
  return page("Review closed", `<main class="closed"><h1>Review closed — ${escapeHtml(outcome)}</h1><p>${subject} is no longer running. This link opens the agent's next review once it plans again.</p><p><a href="/">All plan reviews</a></p></main>`);
}

// "12 min" for a waiting review; with `suffix`, "12 min ago" for a decision.
function ago(from: string, now: Date, suffix = false): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return "just now";
  const hours = Math.floor(minutes / 60);
  const span = minutes < 60 ? `${minutes} min` : hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
  return suffix ? `${span} ago` : span;
}

// Clock times and calendar days as the owner reads them, in one time zone.
class Dates {
  readonly clock: Intl.DateTimeFormat;
  readonly full: Intl.DateTimeFormat;
  private readonly key: Intl.DateTimeFormat;
  private readonly day: Intl.DateTimeFormat;
  private readonly dayWithYear: Intl.DateTimeFormat;
  private readonly today: number;
  private readonly year: string;

  constructor(now: Date, timeZone: string | undefined) {
    this.clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    this.full = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" });
    this.key = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    this.day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" });
    this.dayWithYear = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
    this.today = this.dayNumber(now);
    this.year = this.key.format(now).slice(0, 4);
  }

  // Days since the epoch of the calendar date in the time zone, so "yesterday" holds across DST.
  private dayNumber(at: Date): number {
    const [year, month, day] = this.key.format(at).split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  }

  // "Today", "Yesterday", "Mon 29 Dec", or with the year when it is not this one.
  dayLabel(at: Date): string {
    const days = this.today - this.dayNumber(at);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return (this.key.format(at).startsWith(this.year) ? this.day : this.dayWithYear).format(at);
  }
}

// Markdown reduced to the words a one-glance summary needs.
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).trimEnd()}…`;
}

// The plan's title (its first `# ` heading, without the ticket identifier the row already shows),
// its opening paragraph and its risk rating.
export function planDetails(plan: string, identifier?: string): PlanDetails {
  const lines = plan.split("\n");
  const start = lines.findIndex((line) => /^#\s+\S/.test(line));
  let title = start >= 0 ? plainText(lines[start].replace(/^#\s+/, "")) : null;
  if (title && identifier && title.toLowerCase().startsWith(identifier.toLowerCase())) title = title.slice(identifier.length).replace(/^[\s—–·:|-]+/, "") || null;
  let summary: string | null = null;
  let paragraph: string[] = [];
  for (const line of [...lines.slice(start + 1), ""]) {
    if (line.trim() && !/^#{1,6}\s/.test(line)) { paragraph.push(line); continue; }
    // Tables, code and rules are not a summary.
    if (paragraph.length && !/^\s*(?:\||```|---|\*\*\*)/.test(paragraph[0])) { summary = clip(plainText(paragraph.join(" ")), SUMMARY_CHARS); break; }
    paragraph = [];
  }
  const rated = parsePlanRisk(plan);
  const risk = "risk" in rated ? { impact: combinedRating(rated.risk).impact, text: ratingText(rated.risk) } : null;
  const followUps = planFollowUps(plan).length;
  return { title, summary: summary || null, risk, ...(followUps ? { followUps } : {}), ...("risk" in rated && rated.risk.newRule ? { newRule: true } : {}) };
}

function riskChip(risk: PlanDetails["risk"]): string {
  if (!risk) return "";
  const level = risk.impact <= 1 ? "low" : risk.impact === 2 ? "mid" : "high";
  return `<span class="chip ${level}">Risk: ${escapeHtml(risk.text.replace(/, /g, " · "))}</span>`;
}

function detailRows(details: PlanDetails | undefined, withSummary: boolean): string {
  if (!details) return "";
  const reasons = details.reasons?.length ? `<div class="why"><b>Needs you:</b> ${escapeHtml(details.reasons.join("; "))}</div>` : "";
  const followUps = details.followUps ? `<span class="chip">${details.followUps} follow-up${details.followUps === 1 ? "" : "s"}</span>` : "";
  const newRule = details.newRule ? `<span class="chip mid">new rule</span>` : "";
  const chips = `${riskChip(details.risk)}${followUps}${newRule}`;
  return `${details.title ? `<div class="title">${escapeHtml(details.title)}</div>` : ""}${withSummary && details.summary ? `<div class="summary">${escapeHtml(details.summary)}</div>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}${withSummary ? reasons : ""}`;
}

export const MANIFEST = JSON.stringify({ name: "Plan reviews", short_name: "Reviews", start_url: "/", display: "standalone", background_color: "#f2f2f7", theme_color: "#f2f2f7", icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }] });

const CHEVRON = `<svg class="go" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Shows a pushed review and keeps the app icon's badge at the waiting count; a tap opens it.
export const SERVICE_WORKER = `self.addEventListener("push",(event)=>{let data={};try{data=event.data?event.data.json():{}}catch{}const badge=typeof data.count==="number"&&self.navigator.setAppBadge?(data.count?self.navigator.setAppBadge(data.count):self.navigator.clearAppBadge()).catch(()=>{}):null;event.waitUntil(Promise.all([self.registration.showNotification(data.title||"Plan reviews",{body:data.body||"",tag:data.tag||"reviews",icon:"/icon.png",badge:"/icon.png",data:{url:data.url||"/"}}),badge]))});
self.addEventListener("notificationclick",(event)=>{event.notification.close();event.waitUntil(self.clients.openWindow(new URL(event.notification.data&&event.notification.data.url||"/",self.location.origin).href))});
self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",(event)=>event.waitUntil(self.clients.claim()));`;

// The page's behaviour, all optional: swaps in the fresh page every 30 s and when it comes back
// into view (keeping the scroll position; never while a send-back note is being written), keeps
// the app badge at the waiting count, sends Approve / Send back, and subscribes to notifications.
const CLIENT_SCRIPT = `(()=>{let busy=false;
const writing=()=>!!document.querySelector("form.back:not([hidden])");
const badge=()=>{const n=Number(document.querySelector("[data-waiting]")?.getAttribute("data-waiting")||0);if(navigator.setAppBadge)(n?navigator.setAppBadge(n):navigator.clearAppBadge()).catch(()=>{})};
const notifyButton=()=>{const b=document.querySelector("button[data-act=notify]");if(b)b.hidden=typeof Notification!=="undefined"&&Notification.permission==="granted"&&localStorage.getItem("reviews-notify")==="on"};
const settle=()=>{badge();notifyButton()};
async function refresh(force){if(busy||document.hidden||(!force&&writing()))return;busy=true;try{const response=await fetch(location.pathname,{cache:"no-store"});if(!response.ok)throw new Error(String(response.status));const next=new DOMParser().parseFromString(await response.text(),"text/html");document.title=next.title;document.body.replaceChildren(...next.body.childNodes);settle()}catch{document.querySelector(".sub")?.classList.add("offline")}finally{busy=false}}
async function post(path,body){const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-review-action":"1"},body:JSON.stringify(body)});const answer=await response.json().catch(()=>({}));if(!response.ok)throw new Error(answer.error||("HTTP "+response.status));return answer}
async function decide(item,approve,feedback){const status=item.querySelector(".status");for(const b of item.querySelectorAll("button"))b.disabled=true;status.className="status";status.textContent=approve?"Approving…":"Sending back…";try{await post("/api/reviews/"+encodeURIComponent(item.dataset.agent)+"/decision",{approve,feedback});status.textContent=approve?"Approved. The agent takes it from here.":"Sent back with your note.";item.classList.add("done");setTimeout(()=>refresh(true),2500)}catch(error){status.className="status failed";status.textContent="Not decided: "+error.message;for(const b of item.querySelectorAll("button"))b.disabled=false}}
const urlKey=(key)=>{const padded=(key+"=".repeat((4-key.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(padded),(c)=>c.charCodeAt(0))};
async function subscribe(button){try{if(!("serviceWorker" in navigator)||!("PushManager" in window)||typeof Notification==="undefined")throw new Error("This browser cannot show notifications for this page. On iPhone, add it to the Home Screen first (Share → Add to Home Screen) and open it from there.");if(await Notification.requestPermission()!=="granted")throw new Error("Notifications are not allowed for this page.");const {publicKey}=await (await fetch("/api/push/key",{cache:"no-store"})).json();const registration=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlKey(publicKey)});await post("/api/push/subscribe",subscription.toJSON());localStorage.setItem("reviews-notify","on");button.hidden=true}catch(error){alert(error.message)}}
document.addEventListener("click",(event)=>{const button=event.target.closest("button[data-act]");if(!button)return;const act=button.dataset.act;if(act==="notify")return void subscribe(button);const item=button.closest("[data-agent]");const form=item.querySelector("form.back");if(act==="approve"){if(confirm("Approve the plan for "+item.dataset.name+"?"))decide(item,true,"")}else if(act==="back"){form.hidden=false;form.querySelector("textarea").focus()}else if(act==="cancel")form.hidden=true});
document.addEventListener("submit",(event)=>{const form=event.target.closest("form.back");if(!form)return;event.preventDefault();const note=form.querySelector("textarea").value.trim();if(!note)return;form.hidden=true;decide(form.closest("[data-agent]"),false,note)});
document.addEventListener("DOMContentLoaded",settle);setInterval(()=>refresh(false),${INBOX_REFRESH_S * 1000});document.addEventListener("visibilitychange",()=>refresh(false));addEventListener("pageshow",(event)=>{if(event.persisted)refresh(false)})})()`;

// The row's second line: where to follow up (Linear), who planned it, where it runs.
function facts(row: InboxRow, multiHost: boolean): string[] {
  return [
    ...(row.issueUrl ? [`<a href="${escapeHtml(row.issueUrl)}" target="_blank" rel="noopener">Linear ↗</a>`] : []),
    ...(row.model ? [`<span>${escapeHtml(row.model.split("/").at(-1) ?? row.model)}</span>`] : []),
    ...(multiHost ? [`<span>${escapeHtml(row.host)}</span>`] : []),
  ];
}

function waitingRow(row: InboxRow, now: Date, dates: Dates, multiHost: boolean): string {
  const opened = new Date(row.since);
  const stale = now.getTime() - opened.getTime() >= STALE_HOURS * 3_600_000;
  const when = `<span class="when${stale ? " stale" : ""}"><time datetime="${escapeHtml(row.since)}" title="Opened ${dates.full.format(opened)}">${dates.clock.format(opened)}</time> · ${ago(row.since, now)}</span>`;
  const actions = `<span class="acts"><button type="button" data-act="back">Send back</button><button type="button" class="approve" data-act="approve">Approve</button></span>`;
  const form = `<form class="back" hidden><textarea name="feedback" required maxlength="4000" aria-label="What should change" placeholder="What should change?"></textarea><div><button type="button" data-act="cancel">Cancel</button><button type="submit" class="approve">Send back</button></div></form>`;
  return `<li data-agent="${escapeHtml(row.agentId)}" data-name="${escapeHtml(row.name)}"><a class="row" href="${escapeHtml(row.link)}"><div class="top"><span class="id">${escapeHtml(row.name)}</span>${when}</div>${detailRows(row.details, true)}${CHEVRON}</a><div class="facts">${facts(row, multiHost).join("<span aria-hidden=\"true\">·</span>")}${actions}</div>${form}<p class="status" role="status"></p></li>`;
}

function decidedRow(row: InboxRow, now: Date, dates: Dates, multiHost: boolean): string {
  const iso = row.decidedAt ?? row.since;
  const at = new Date(iso);
  const day = dates.dayLabel(at);
  const outcome = row.outcome ?? "ended";
  const tone = outcome === "approved" ? " approved" : outcome === "sent back" ? " back" : "";
  const when = `<span class="when"><time datetime="${escapeHtml(iso)}" title="Decided ${dates.full.format(at)}">${day === "Today" ? "" : `${day} `}${dates.clock.format(at)}</time> · ${ago(iso, now, true)}</span>`;
  const extra = facts(row, multiHost);
  return `<li><div class="row"><div class="top"><span class="id">${escapeHtml(row.name)}</span><span class="outcome${tone}">${escapeHtml(outcome)}</span>${when}</div>${detailRows(row.details, false)}</div>${extra.length ? `<div class="facts">${extra.join("<span aria-hidden=\"true\">·</span>")}</div>` : ""}</li>`;
}

// The root of :8444: every review waiting for the owner on this host and its peers, newest first
// and grouped by the day the owner got it, plus the latest decisions.
export function inboxPage(view: InboxView, now: Date, timeZone: string | undefined): string {
  const { open, decided } = view;
  const dates = new Dates(now, timeZone);
  const multiHost = view.hosts.length > 1;
  const days: { label: string; rows: string[] }[] = [];
  for (const row of open) {
    const label = dates.dayLabel(new Date(row.since));
    const last = days.at(-1);
    if (last?.label === label) last.rows.push(waitingRow(row, now, dates, multiHost));
    else days.push({ label, rows: [waitingRow(row, now, dates, multiHost)] });
  }
  const waiting = open.length
    ? `<section><h2>Waiting <span class="n">${open.length}</span><span class="hint">newest first</span></h2>${days.map((day) => `<h3>${escapeHtml(day.label)}</h3><ul class="list">${day.rows.join("")}</ul>`).join("")}</section>`
    : `<section><h2>Waiting</h2><p class="empty"><b>Nothing to review.</b>New plan reviews show up here on their own.</p></section>`;
  const recent = decided.length
    ? `<section><h2>Recently decided</h2><ul class="list">${decided.map((row) => decidedRow(row, now, dates, multiHost)).join("")}</ul></section>`
    : "";
  const oldest = open.at(-1);
  const status = [open.length ? `${open.length} waiting` : "Nothing waiting", ...(oldest ? [`oldest ${ago(oldest.since, now)}`] : []), `updated ${dates.clock.format(now)}`].join(" · ");
  const missing = view.unreachable.length ? `<p class="missing">Not reachable, so its reviews are missing: ${escapeHtml(view.unreachable.join(", "))}</p>` : "";
  const notify = view.push ? `<button type="button" class="notify" data-act="notify">Notify me</button>` : "";
  const header = `<header class="bar" data-waiting="${open.length}"><div><div><h1>Plan reviews</h1><p class="sub">${status}</p>${missing}</div>${notify}</div></header>`;
  const head = `<noscript><meta http-equiv="refresh" content="${INBOX_REFRESH_S}"></noscript><meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Reviews"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon.png"><link rel="icon" href="/icon.png"><script>${CLIENT_SCRIPT}</script>`;
  return page(open.length ? `Plan reviews (${open.length})` : "Plan reviews", `${header}<main>${waiting}${recent}</main>`, head);
}
