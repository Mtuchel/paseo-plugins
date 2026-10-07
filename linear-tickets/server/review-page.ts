import { parsePlanRisk, combinedRating, ratingText } from "../shared/plan-risk";
import { planFollowUps } from "../shared/plan-sections";
import type { PipelineHost } from "../shared/plan-pipeline";
import { pipelinePage, PIPELINE_STYLE, PIPELINE_CLIENT } from "./review-pipeline-page";

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

// How far the journal got with carrying a decision out (a "Being applied" row): pending is being
// applied now, uncertain waits for the owner because Plannotator's answer was lost, unbound is a
// report no review matches, conflict is two contradicting decisions (conflict-applied: reported
// after the accepted one was carried out), unreadable a decision record that cannot be read.
export type ApplyState = "pending" | "uncertain" | "unbound" | "conflict" | "conflict-applied" | "unreadable";

// One row of the inbox, from this host or a peer's /api/inbox. `link` opens the review (the
// agent's stable link); `since` is when the owner got the plan; decided rows add `outcome` (as
// shown: approved, auto-approved, sent back, ended) and `decidedAt`; a "Being applied" row adds
// the journal entry to settle, the decision itself and its last failure.
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
  areas?: string[];
  deleteable?: boolean;
  applyState?: ApplyState;
  entryId?: string;
  approved?: boolean;
  applyError?: string;
  nextAttemptAt?: string;
};
// `unreachable`: peers whose inbox did not answer, so their reviews are missing.
export type InboxView = { open: InboxRow[]; decided: InboxRow[]; applying: InboxRow[]; unreachable: string[]; hosts: string[]; push: boolean; pipeline?: PipelineHost[] };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--press:#ebebf0;--tint:#0a64d6;--chip:#ececf1;--ok:#1b7a3d;--ok-bg:#dcf5e3;--go:#1b7a3d;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--press:#2c2c2e;--tint:#5aa9ff;--chip:#2c2c2e;--ok:#8fe0a8;--ok-bg:#123d22;--go:#1b7a3d;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512}}
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
.acts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%;margin-top:4px}.acts>[data-act="recheck"]:last-child{grid-column:1/-1}button{font:inherit;font-size:.875rem;font-weight:600;min-height:44px;padding:0 12px;border:0;border-radius:10px;cursor:pointer;background:var(--chip);color:var(--fg);-webkit-tap-highlight-color:transparent}button:focus-visible{outline:2px solid var(--tint);outline-offset:2px}button:active{filter:brightness(.92)}button.approve{background:var(--go);color:#fff}button.danger{color:var(--bad);background:var(--bad-bg)}button[disabled]{opacity:.5;cursor:default}
.back{padding:0 16px 14px}.back textarea{display:block;width:100%;min-height:88px;padding:10px 12px;font:inherit;font-size:.9375rem;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;resize:vertical;caret-color:var(--tint)}.back textarea:focus{outline:2px solid var(--tint);outline-offset:-1px;border-color:transparent}.back div{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.status{margin:0;padding:0 16px 12px;font-size:.875rem;font-weight:600;color:var(--tint)}.status:empty{display:none}.status.failed{color:var(--bad)}li.done>a.row,li.done>.facts{opacity:.45}
.outcome{font-size:.75rem;font-weight:600;line-height:1.6;padding:0 8px;border-radius:999px;background:var(--chip);color:var(--sub)}.outcome.approved{background:var(--ok-bg);color:var(--ok)}.outcome.back{background:var(--warn-bg);color:var(--warn)}
.notify{flex:none;background:var(--tint);color:#fff}
.empty{margin:0;padding:28px 16px;text-align:center;color:var(--muted);background:var(--card);border-radius:14px}.empty b{display:block;color:var(--fg);font-size:1.0625rem}
.closed{padding:calc(env(safe-area-inset-top) + 48px) 24px 48px}.closed h1{font-size:1.4rem;margin-bottom:.5rem}
[hidden]{display:none!important}
.bar>.search{display:block;max-width:36rem;margin:14px auto 0}.search label{display:block;margin-bottom:5px;font-size:.8125rem;font-weight:600;color:var(--sub)}.search input,.delete-dialog input{display:block;width:100%;min-height:44px;padding:10px 12px;font:inherit;font-size:.9375rem;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;caret-color:var(--tint)}.search input::placeholder{color:var(--muted)}.search input:focus,.delete-dialog input:focus{outline:2px solid var(--tint);outline-offset:-1px;border-color:transparent}.search-empty{margin-top:24px}.area{background:var(--chip);color:var(--sub)}
.delete-dialog{width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;margin:auto;padding:24px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:14px}.delete-dialog::backdrop{background:rgb(0 0 0 / .45)}.delete-dialog h2{margin:0;font-size:1.25rem}.delete-dialog p{font-size:.9375rem;color:var(--sub)}.delete-dialog label{display:block;margin:18px 0 6px;font-size:.875rem;font-weight:600}.delete-dialog .dialog-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.pane{display:none}
@media(min-width:1100px){body{display:grid;grid-template-columns:minmax(20rem,26rem) minmax(0,1fr);grid-template-rows:minmax(0,1fr);height:100vh;height:100dvh;overflow:hidden}.queue{overflow-y:auto;overscroll-behavior:contain;border-right:.5px solid var(--line)}.pane{display:flex;flex-direction:column;min-width:0;background:var(--card)}li.selected>a.row{background:color-mix(in srgb,var(--tint) 12%,transparent)}li.selected::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--tint)}}
.pane-bar{display:flex;align-items:center;gap:12px;padding:8px 16px;font-size:.875rem;border-bottom:.5px solid var(--line)}.pane-bar b{font-weight:600}.pane-bar a{margin-left:auto;font-weight:600;text-decoration:none}
.frames{position:relative;flex:1;min-height:0}.frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0}.frames iframe.off{visibility:hidden}
.pick{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;margin:0;padding:24px;text-align:center;color:var(--muted)}.pick b{color:var(--fg);font-size:1.0625rem}.pane-bar[hidden],.pick[hidden]{display:none}`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(title)}</title>${head}<style>${PAGE_STYLE}</style></head>
<body>${body}</body></html>`;
}

export function closedPage(identifier: string | undefined, outcome: string): string {
  const subject = identifier ? `The plan review for ${escapeHtml(identifier)}` : "This plan review";
  return page("Review closed", `<main class="closed"><h1>Review closed — ${escapeHtml(outcome)}</h1><p>${subject} is no longer running. This link opens the agent's next review once it plans again.</p><p><a href="/" target="_top">All plan reviews</a></p></main>`);
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
  const newRule = details.newRule ? `<span class="chip mid">Rule change</span>` : "";
  const chips = `${riskChip(details.risk)}${followUps}${newRule}`;
  return `${details.title ? `<div class="title">${escapeHtml(details.title)}</div>` : ""}${withSummary && details.summary ? `<div class="summary">${escapeHtml(details.summary)}</div>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}${withSummary ? reasons : ""}`;
}

export const MANIFEST = JSON.stringify({ name: "Plan reviews", short_name: "Reviews", start_url: "/", display: "standalone", background_color: "#f2f2f7", theme_color: "#f2f2f7", icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }] });

const CHEVRON = `<svg class="go" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Shows a pushed review and keeps the app icon's badge at the waiting count; a tap opens it.
export const SERVICE_WORKER = `self.addEventListener("push",(event)=>{let data={};try{data=event.data?event.data.json():{}}catch{}const badge=typeof data.count==="number"&&self.navigator.setAppBadge?(data.count?self.navigator.setAppBadge(data.count):self.navigator.clearAppBadge()).catch(()=>{}):null;event.waitUntil(Promise.all([self.registration.showNotification(data.title||"Plan reviews",{body:data.body||"",tag:data.tag||"reviews",icon:"/icon.png",badge:"/icon.png",data:{url:data.url||"/"}}),badge]))});
self.addEventListener("notificationclick",(event)=>{event.notification.close();event.waitUntil(self.clients.openWindow(new URL(event.notification.data&&event.notification.data.url||"/",self.location.origin).href))});
self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",(event)=>event.waitUntil(self.clients.claim()));`;

// The page's behaviour, all optional: swaps in the fresh list every 30 s, when it comes back into
// view and when focus returns from the review pane (keeping the scroll position; never while a
// send-back note is being written), keeps the app badge at the waiting count, sends Approve /
// Send back, and subscribes to notifications. When the pane shows (the 1100px breakpoint in
// PAGE_STYLE), a row opens its review there instead of navigating; each opened review keeps its
// own frame (and so its unsent annotations) until it leaves the list while every host answers,
// and #<agentId> in the URL reopens it on reload. Resting the pointer on a row starts loading its
// review out of sight, so a click mostly finds it loaded; only the latest such unopened one stays.
const CLIENT_SCRIPT = `(()=>{let busy=false,selected=null,hovered=null,hover=0,query="",composing=false;const pending=new Set();
${PIPELINE_CLIENT}
const writing=()=>!!document.querySelector("form.back:not([hidden]),.delete-dialog[open]");
const badge=()=>{const n=Number(document.querySelector("[data-waiting]")?.getAttribute("data-waiting")||0);if(navigator.setAppBadge)(n?navigator.setAppBadge(n):navigator.clearAppBadge()).catch(()=>{})};
const notifyButton=()=>{const b=document.querySelector("button[data-act=notify]");if(b)b.hidden=typeof Notification!=="undefined"&&Notification.permission==="granted"&&localStorage.getItem("reviews-notify")==="on"};
const items=()=>[...document.querySelectorAll(".queue li[data-agent]")];
const frames=()=>[...document.querySelectorAll(".frames iframe")];
const wide=()=>matchMedia("(min-width: 1100px)").matches;
function mark(){for(const li of items()){const on=li.dataset.agent===selected;li.classList.toggle("selected",on);const a=li.querySelector("a.row");if(on)a.setAttribute("aria-current","true");else a.removeAttribute("aria-current")}if(document.querySelector(".missing"))return;const waiting=new Set(items().map((li)=>li.dataset.agent));for(const f of frames())if(f.dataset.agent!==selected&&!waiting.has(f.dataset.agent))f.remove()}
function frameFor(item){const id=item.dataset.agent;let frame=frames().find((f)=>f.dataset.agent===id);if(!frame){frame=document.createElement("iframe");frame.dataset.agent=id;frame.className="off";frame.title="Plan review "+item.dataset.name;frame.allow="clipboard-read; clipboard-write; fullscreen";frame.src=item.querySelector("a.row").href;document.querySelector(".frames").append(frame)}return frame}
function warm(item){for(const f of frames())if(!f.dataset.opened&&f.dataset.agent!==item.dataset.agent)f.remove();frameFor(item)}
function select(item){const frame=frameFor(item),link=item.querySelector("a.row").href;frame.dataset.opened="1";for(const f of frames())f.classList.toggle("off",f!==frame);document.querySelector(".pick").hidden=true;const bar=document.querySelector(".pane-bar");bar.hidden=false;bar.querySelector("b").textContent=item.dataset.name;bar.querySelector("a").href=link;selected=item.dataset.agent;history.replaceState(null,"","#"+encodeURIComponent(selected));mark();frame.focus()}
function filter(){const terms=query.trim().toLocaleLowerCase().split(/\\s+/).filter(Boolean);for(const li of document.querySelectorAll("li[data-search]"))li.hidden=!terms.every((term)=>li.dataset.search.includes(term));for(const group of document.querySelectorAll(".day-group"))group.hidden=![...group.querySelectorAll("li")].some((li)=>!li.hidden);let found=0;for(const section of document.querySelectorAll("[data-review-section]")){const rows=[...section.querySelectorAll("li[data-search]")],count=rows.filter((li)=>!li.hidden).length;found+=count;section.hidden=!!terms.length&&!count;const n=section.querySelector("[data-filter-count]");if(n)n.textContent=terms.length?count+" of "+rows.length:String(rows.length)}const empty=document.querySelector("[data-search-empty]");if(empty)empty.hidden=!terms.length||found>0}
const settle=()=>{badge();notifyButton();mark();filter();tickPipeline()};
async function refresh(){
tickPipeline();if(busy||pending.size||document.hidden||writing()||composing)return;busy=true;
try{
const response=await fetch(location.pathname,{cache:"no-store"});if(!response.ok)throw new Error(String(response.status));
const next=new DOMParser().parseFromString(await response.text(),"text/html"),fresh=next.querySelector(".queue");if(!fresh||!fresh.querySelector("[data-pipeline]"))throw new Error("no pipeline list");
// A note, modal, action or IME composition may have started while the request was in flight.
if(pending.size||writing()||composing)return;
const queue=document.querySelector(".queue"),search=document.querySelector("#review-search"),active=document.activeElement;
const focused=active===search,start=search?.selectionStart,end=search?.selectionEnd,direction=search?.selectionDirection;
const details=document.querySelector("#pipeline-details"),expanded=details?.open,pipelineFocus=details?.contains(active),focusLink=pipelineFocus&&active?.closest("a")?.getAttribute("href");
const top=queue.scrollTop,left=queue.scrollLeft;query=search?.value??query;
// Reuse the exact input node, including its query, selection and browser editing state.
if(search)fresh.querySelector("#review-search")?.replaceWith(search);
const freshDetails=fresh.querySelector("#pipeline-details");if(freshDetails)freshDetails.open=!!expanded;
clearTimeout(hover);hovered=null;document.title=next.title;queue.replaceChildren(...fresh.childNodes);settle();
if(focused){search.focus({preventScroll:true});if(start!==null&&end!==null)search.setSelectionRange(start,end,direction)}
else if(pipelineFocus){const target=focusLink&&[...document.querySelectorAll("#pipeline-details a")].find((a)=>a.getAttribute("href")===focusLink);(target||document.querySelector("#pipeline-details summary"))?.focus({preventScroll:true})}
queue.scrollTop=top;queue.scrollLeft=left;
}catch{document.querySelector(".sub")?.classList.add("offline");pipelineFetchFailed()}finally{busy=false}
}
async function post(path,body){const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json","x-review-action":"1"},body:JSON.stringify(body)});const answer=await response.json().catch(()=>({}));if(!response.ok)throw new Error(answer.error||("HTTP "+response.status));return answer}
async function act(item,action,body,label){const id=item.dataset.agent,status=item.querySelector(".status");pending.add(id);for(const b of item.querySelectorAll("button"))b.disabled=true;status.className="status";status.textContent=label?label+"…":action==="delete"?"Deleting plan and issue…":action==="recheck"?"Sending landscape recheck…":body.approve?"Approving…":"Sending back…";try{await post("/api/reviews/"+encodeURIComponent(id)+"/"+action,body);status.textContent=label?label+" done.":action==="delete"?"Plan and Linear issue deleted.":action==="recheck"?"Sent back to check code, PRs and issues, then resubmit for review.":body.approve?"Approved. The agent takes it from here.":"Sent back with your note.";item.classList.add("done");if(action==="delete"){for(const f of frames())if(f.dataset.agent===id)f.remove();if(selected===id){selected=null;document.querySelector(".pane-bar").hidden=true;document.querySelector(".pick").hidden=false;history.replaceState(null,"",location.pathname)}}setTimeout(()=>refresh(),2500)}catch(error){status.className="status failed";status.textContent=(action==="delete"?"Deletion not completed: ":action==="recheck"?"Recheck not sent: ":"Not decided: ")+error.message;for(const b of item.querySelectorAll("button"))b.disabled=false}finally{pending.delete(id)}}
const decide=(item,approve,feedback)=>act(item,"decision",{approve,feedback});
function confirmDelete(item){const dialog=document.querySelector("#delete-dialog");dialog.dataset.agent=item.dataset.agent;dialog.querySelector("[data-delete-issue]").textContent=item.dataset.name;dialog.querySelector("[data-delete-confirm]").textContent=item.dataset.name;const input=dialog.querySelector("input");input.value="";input.setCustomValidity("");dialog.showModal();input.focus()}
const urlKey=(key)=>{const padded=(key+"=".repeat((4-key.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from(atob(padded),(c)=>c.charCodeAt(0))};
async function subscribe(button){try{if(!("serviceWorker" in navigator)||!("PushManager" in window)||typeof Notification==="undefined")throw new Error("This browser cannot show notifications for this page. On iPhone, add it to the Home Screen first (Share → Add to Home Screen) and open it from there.");if(await Notification.requestPermission()!=="granted")throw new Error("Notifications are not allowed for this page.");const {publicKey}=await (await fetch("/api/push/key",{cache:"no-store"})).json();const registration=await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlKey(publicKey)});await post("/api/push/subscribe",subscription.toJSON());localStorage.setItem("reviews-notify","on");button.hidden=true}catch(error){alert(error.message)}}
document.addEventListener("click",(event)=>{const item=event.target.closest("a.row")?.closest("li[data-agent]");if(!item||!wide()||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();select(item)});
document.addEventListener("mouseover",(event)=>{const item=event.target.closest("a.row")?.closest("li[data-agent]")||null;if(item===hovered)return;hovered=item;clearTimeout(hover);if(item&&wide())hover=setTimeout(()=>warm(item),150)});
document.addEventListener("input",(event)=>{if(event.target.id==="review-search"){query=event.target.value;filter()}else if(event.target.id==="delete-identifier")event.target.setCustomValidity("")});
document.addEventListener("compositionstart",(event)=>{if(event.target.id==="review-search")composing=true});
document.addEventListener("compositionend",(event)=>{if(event.target.id==="review-search"){composing=false;query=event.target.value;filter()}});
document.addEventListener("click",(event)=>{const button=event.target.closest("button[data-act]");if(!button)return;const action=button.dataset.act;if(action==="notify")return void subscribe(button);if(action==="cancel-delete")return void document.querySelector("#delete-dialog").close();const item=button.closest("[data-agent]");if(!item)return;const form=item.querySelector("form.back");if(action==="approve"){if(confirm("Approve the plan for "+item.dataset.name+"?"))decide(item,true,"")}else if(action==="back"){form.hidden=false;form.querySelector("textarea").focus()}else if(action==="cancel")form.hidden=true;else if(action==="recheck"){if(confirm("Send "+item.dataset.name+" back to check current code, PRs and issues, resolve conflicts, and resubmit for review? This does not approve or start implementation."))act(item,"recheck",{})}else if(action==="delete")confirmDelete(item);else if(action==="resolve")act(item,"resolve",{entryId:button.dataset.entry,action:button.dataset.action},button.textContent)});
document.addEventListener("submit",(event)=>{const deletion=event.target.closest("#delete-form");if(deletion){event.preventDefault();const dialog=document.querySelector("#delete-dialog"),item=items().find((li)=>li.dataset.agent===dialog.dataset.agent),input=deletion.querySelector("input");if(!item){dialog.close();return}if(input.value!==item.dataset.name){input.setCustomValidity("Type "+item.dataset.name+" exactly to confirm.");input.reportValidity();return}dialog.close();act(item,"delete",{identifier:input.value});return}const form=event.target.closest("form.back");if(!form)return;event.preventDefault();const note=form.querySelector("textarea").value.trim();if(!note)return;form.hidden=true;decide(form.closest("[data-agent]"),false,note)});
document.addEventListener("DOMContentLoaded",()=>{settle();const id=decodeURIComponent(location.hash.slice(1));const item=id&&wide()&&items().find((li)=>li.dataset.agent===id);if(item)select(item)});setInterval(()=>refresh(),${INBOX_REFRESH_S * 1000});document.addEventListener("visibilitychange",()=>refresh());addEventListener("focus",()=>refresh());addEventListener("pageshow",(event)=>{if(event.persisted)refresh()})})()`;

// The row's second line: where to follow up (Linear), who planned it, where it runs.
function facts(row: InboxRow, multiHost: boolean): string[] {
  return [
    ...(row.issueUrl ? [`<a href="${escapeHtml(row.issueUrl)}" target="_blank" rel="noopener">Linear ↗</a>`] : []),
    ...(row.model ? [`<span>${escapeHtml(row.model.split("/").at(-1) ?? row.model)}</span>`] : []),
    ...(multiHost ? [`<span>${escapeHtml(row.host)}</span>`] : []),
  ];
}
function searchText(row: InboxRow): string {
  return escapeHtml([row.name, row.details?.title, row.details?.summary, row.host, row.model, row.outcome, ...(row.areas ?? []), ...(row.details?.newRule ? ["rule change"] : [])].filter(Boolean).join(" ").toLocaleLowerCase());
}

function areaChips(row: InboxRow): string {
  return row.areas?.length ? `<div class="chips">${row.areas.map((area) => `<span class="chip area">Area: ${escapeHtml(area)}</span>`).join("")}</div>` : "";
}

function waitingRow(row: InboxRow, now: Date, dates: Dates, multiHost: boolean): string {
  const opened = new Date(row.since);
  const stale = now.getTime() - opened.getTime() >= STALE_HOURS * 3_600_000;
  const when = `<span class="when${stale ? " stale" : ""}"><time datetime="${escapeHtml(row.since)}" title="Opened ${dates.full.format(opened)}">${dates.clock.format(opened)}</time> · ${ago(row.since, now)}</span>`;
  const actions = `<span class="acts"><button type="button" data-act="back">Send back</button><button type="button" class="approve" data-act="approve">Approve</button><button type="button" data-act="recheck" title="Send back to check current code, PRs and issues, then resubmit for review">Recheck landscape</button>${row.deleteable ? `<button type="button" class="danger" data-act="delete">Delete plan + issue</button>` : ""}</span>`;
  const form = `<form class="back" hidden><textarea name="feedback" required maxlength="4000" aria-label="What should change" placeholder="What should change?"></textarea><div><button type="button" data-act="cancel">Cancel</button><button type="submit" class="approve">Send back</button></div></form>`;
  return `<li data-agent="${escapeHtml(row.agentId)}" data-name="${escapeHtml(row.name)}" data-search="${searchText(row)}"><a class="row" href="${escapeHtml(row.link)}"><div class="top"><span class="id">${escapeHtml(row.name)}</span>${when}</div>${areaChips(row)}${detailRows(row.details, true)}${CHEVRON}</a><div class="facts">${facts(row, multiHost).join("<span aria-hidden=\"true\">·</span>")}${actions}</div>${form}<p class="status" role="status"></p></li>`;
}

function decidedRow(row: InboxRow, now: Date, dates: Dates, multiHost: boolean): string {
  const iso = row.decidedAt ?? row.since;
  const at = new Date(iso);
  const day = dates.dayLabel(at);
  const outcome = row.outcome ?? "ended";
  const tone = outcome === "approved" ? " approved" : outcome === "sent back" ? " back" : "";
  const when = `<span class="when"><time datetime="${escapeHtml(iso)}" title="Decided ${dates.full.format(at)}">${day === "Today" ? "" : `${day} `}${dates.clock.format(at)}</time> · ${ago(iso, now, true)}</span>`;
  const extra = facts(row, multiHost);
  return `<li data-search="${searchText(row)}"><div class="row"><div class="top"><span class="id">${escapeHtml(row.name)}</span><span class="outcome${tone}">${escapeHtml(outcome)}</span>${when}</div>${areaChips(row)}${detailRows(row.details, false)}</div>${extra.length ? `<div class="facts">${extra.join("<span aria-hidden=\"true\">·</span>")}</div>` : ""}</li>`;
}

// The chip of a "Being applied" row: the decision and what the journal still has to do about it.
function applyChip(row: InboxRow): string {
  const outcome = row.approved === false ? "sent back" : "approved";
  switch (row.applyState) {
    case "uncertain": return `${outcome} — not confirmed by Plannotator`;
    case "unbound": return "report not matched to a review";
    case "conflict": return "conflicting decisions";
    case "conflict-applied": return "Plannotator reported the other decision after this one was carried out";
    case "unreadable": return row.name;
    default: return `${outcome} — being applied`;
  }
}

// What the owner may do about a "Being applied" row: a decision the journal is unsure about is
// carried out or dropped, a conflict keeps this decision or the other one; once the accepted one
// went through anyway, only Dismiss remains. Buttons post /resolve like the decision buttons.
function applyActions(row: InboxRow): string {
  const button = (action: string, label: string, tone = "") => `<button type="button"${tone} data-act="resolve" data-entry="${escapeHtml(row.entryId ?? "")}" data-action="${action}">${label}</button>`;
  switch (row.applyState) {
    case "uncertain":
    case "unbound": return `<span class="acts">${button("carry-out", "Carry it out", " class=\"approve\"")}${button("drop", "Drop it", " class=\"danger\"")}</span>`;
    case "conflict": return `<span class="acts">${button("keep", "Keep this one")}${button("other", "Carry out the other")}</span>`;
    case "conflict-applied": return `<span class="acts">${button("dismiss", "Dismiss", " class=\"approve\"")}</span>`;
    default: return "";
  }
}

function applyingRow(row: InboxRow, now: Date, dates: Dates, multiHost: boolean): string {
  // Pending rows say what carrying the decision out is doing; the other kinds wait for the owner.
  const line = row.applyState === "pending"
    ? `<p class="why">${row.applyError ? `Last try failed: ${escapeHtml(row.applyError)}${row.nextAttemptAt ? ` · next try ${dates.clock.format(new Date(row.nextAttemptAt))}` : ""}` : "Applying…"}</p>`
    : "";
  const tone = row.applyState === "pending" || row.applyState === "uncertain" ? (row.approved === false ? " back" : " approved") : "";
  const extra = facts(row, multiHost);
  const actions = applyActions(row);
  const name = row.applyState === "unreadable" ? "" : `<span class="id">${escapeHtml(row.name)}</span>`;
  const footer = extra.length || actions ? `<div class="facts">${extra.join("<span aria-hidden=\"true\">·</span>")}${actions}</div>` : "";
  return `<li data-agent="${escapeHtml(row.agentId)}" data-name="${escapeHtml(row.name)}" data-search="${searchText(row)}"><div class="row"><div class="top">${name}<span class="outcome${tone}">${escapeHtml(applyChip(row))}</span></div>${areaChips(row)}${detailRows(row.details, false)}${line}</div>${footer}<p class="status" role="status"></p></li>`;
}

// The root of :8444: every review waiting for the owner on this host and its peers, newest first
// and grouped by the day the owner got it, plus the latest decisions. On a wide screen the pane
// beside the list shows the selected review's Plannotator page.
export function inboxPage(view: InboxView, now: Date, timeZone: string | undefined): string {
  const { open, decided, applying } = view;
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
    ? `<section data-review-section><h2>Waiting <span class="n" data-filter-count>${open.length}</span><span class="hint">newest first</span></h2>${days.map((day) => `<div class="day-group"><h3>${escapeHtml(day.label)}</h3><ul class="list">${day.rows.join("")}</ul></div>`).join("")}</section>`
    : `<section data-review-section><h2>Waiting</h2><p class="empty"><b>Nothing to review.</b>New plan reviews show up here on their own.</p></section>`;
  const beingApplied = applying.length
    ? `<section data-review-section><h2>Being applied <span class="n" data-filter-count>${applying.length}</span></h2><ul class="list">${applying.map((row) => applyingRow(row, now, dates, multiHost)).join("")}</ul></section>`
    : "";
  const recent = decided.length
    ? `<section data-review-section><h2>Recently decided <span class="n" data-filter-count>${decided.length}</span></h2><ul class="list">${decided.map((row) => decidedRow(row, now, dates, multiHost)).join("")}</ul></section>`
    : "";
  const oldest = open.at(-1);
  const status = [open.length ? `${open.length} waiting` : "Nothing waiting", ...(oldest ? [`oldest ${ago(oldest.since, now)}`] : []), `updated ${dates.clock.format(now)}`].join(" · ");
  const missing = view.unreachable.length ? `<p class="missing">Not reachable, so its reviews are missing: ${escapeHtml(view.unreachable.join(", "))}</p>` : "";
  const notify = view.push ? `<button type="button" class="notify" data-act="notify">Notify me</button>` : "";
  const header = `<header class="bar" data-waiting="${open.length}"><div><div><h1>Plan reviews</h1><p class="sub">${status}</p>${missing}</div>${notify}</div><div class="search"><label for="review-search">Search reviews</label><input id="review-search" type="search" autocomplete="off" placeholder="Issue, plan or area…" aria-controls="review-list"></div></header>`;
  const head = `<noscript><meta http-equiv="refresh" content="${INBOX_REFRESH_S}"></noscript><meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Reviews"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon.png"><link rel="icon" href="/icon.png"><style>${PIPELINE_STYLE}</style><script>${CLIENT_SCRIPT}</script>`;
  const pane = `<aside class="pane" aria-label="Plan review"><div class="pane-bar" hidden><b></b><a target="_blank" rel="noopener">Open in new tab ↗</a></div><div class="frames"><p class="pick"><b>Pick a review</b>It opens here in Plannotator: annotate, comment, approve or send back as on its own page.</p></div></aside>`;
  const deletion = `<dialog id="delete-dialog" class="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-explanation"><form id="delete-form"><h2 id="delete-title">Delete plan and issue?</h2><p id="delete-explanation">This removes the waiting plan and moves its underlying Linear issue <strong data-delete-issue></strong> to Linear’s Trash. Its queued work is stopped. This is not a send-back or an approval.</p><label for="delete-identifier">Type <strong data-delete-confirm></strong> to confirm</label><input id="delete-identifier" name="identifier" required autocomplete="off" spellcheck="false"><div class="dialog-acts"><button type="button" data-act="cancel-delete">Cancel</button><button type="submit" class="danger">Delete plan + issue</button></div></form></dialog>`;
  const pipeline = pipelinePage({ pipeline: view.pipeline, hosts: view.hosts, unreachable: view.unreachable, ready: open.length, now, escapeHtml });
  return page(open.length ? `Plan reviews (${open.length})` : "Plan reviews", `<div class="queue">${header}<main id="review-list">${pipeline}${waiting}${beingApplied}${recent}<p class="empty search-empty" data-search-empty role="status" hidden><b>No matching reviews.</b>Try another issue, plan title or area.</p></main></div>${pane}${deletion}`, head);
}
