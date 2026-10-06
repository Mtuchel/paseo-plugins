import type { PipelineHost, PipelineRow, PipelineStage } from "../shared/plan-pipeline";

const HOST_STALE_MS = 90_000;
const TERMINAL: Record<PipelineStage, boolean> = {
  queued: false, preparing: false, advisor: false, publishing: false, waiting: false,
  ready: true, "auto-approved": true, superseded: true, cancelled: true, completed: true,
};
const STAGE_LABEL: Record<PipelineStage, string> = {
  queued: "Queued", preparing: "Preparing plan", advisor: "Advisor review", publishing: "Publishing review",
  waiting: "Waiting", ready: "Ready for review", "auto-approved": "Auto-approved", superseded: "Superseded",
  cancelled: "Cancelled", completed: "Completed",
};
const STATUS_LABEL = { normal: "Normal", attention: "Needs attention", failed: "Failure reported", unknown: "Unknown" };

function age(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

// Uses the inbox's escaping function; no pipeline data is interpolated into executable script.
export function pipelinePage({ pipeline, hosts, unreachable, ready, now, escapeHtml }: {
  pipeline: PipelineHost[] | undefined; hosts: string[]; unreachable: string[]; ready: number;
  now: Date; escapeHtml: (text: string) => string;
}): string {
  const time = now.getTime();
  const sources = pipeline ?? [];
  const expected = [...new Set([...hosts, ...unreachable, ...sources.map((source) => source.host)])];
  const rows = sources.flatMap((source) => source.rows);
  const active = rows.filter((row) => !TERMINAL[row.stage]);
  const onWay = active.filter((row) => row.status === "normal");
  // The source classifies long silence and legitimate waits. Age alone is not failure evidence.
  const attention = rows.filter((row) => row.status !== "normal");
  const hostState = (source: PipelineHost | undefined, host: string) => {
    if (!source || unreachable.includes(host)) return "unknown";
    if (!source.checkedAt || !Number.isFinite(Date.parse(source.checkedAt))) return "unknown";
    if (source.error !== undefined) return "unknown";
    return time - Date.parse(source.checkedAt) > HOST_STALE_MS ? "stale" : "normal";
  };
  const unknown = !sources.length || expected.some((host) => {
    const state = hostState(sources.find((source) => source.host === host), host);
    return state === "unknown" || state === "stale";
  }) || rows.some((row) => row.status === "unknown");
  const failures = rows.filter((row) => row.status === "failed").length;
  const health = unknown ? "unknown" : failures ? "failed" : attention.length ? "attention" : "normal";
  const healthLabel = { normal: "Up to date", attention: "Needs attention", failed: "Failure reported", unknown: failures ? `Unknown · ${failures} failure${failures === 1 ? "" : "s"} reported` : "Unknown" };
  const timestamp = (at: string | null, fallback: string) => at && Number.isFinite(Date.parse(at))
    ? `<time datetime="${escapeHtml(at)}" data-pipeline-time title="${escapeHtml(at)}">${age(at, time)}</time>`
    : escapeHtml(fallback);
  const checked = expected.map((host) => sources.find((source) => source.host === host)?.checkedAt);
  const allChecked = checked.length > 0 && checked.every((at) => at && Number.isFinite(Date.parse(at)));
  const oldestCheck = allChecked ? checked.reduce<string | null>((oldest, at) => at && (!oldest || Date.parse(at) < Date.parse(oldest)) ? at : oldest, null) : null;
  const lastArrival = sources.reduce<string | null>((latest, source) => source.lastArrivalAt && Number.isFinite(Date.parse(source.lastArrivalAt)) && (!latest || Date.parse(source.lastArrivalAt) > Date.parse(latest)) ? source.lastArrivalAt : latest, null);
  const stageCounts: Record<PipelineStage, number> = { queued: 0, preparing: 0, advisor: 0, publishing: 0, waiting: 0, ready: 0, "auto-approved": 0, superseded: 0, cancelled: 0, completed: 0 };
  for (const row of rows) stageCounts[row.stage]++;
  const counts = (["preparing", "advisor", "publishing"] as const).map((stage) => `<span><b data-pipeline-count="${stage}">${stageCounts[stage]}</b> ${stage}</span>`);
  counts.push(`<span><b data-pipeline-count="ready">${ready}</b> ready</span>`);
  for (const stage of ["queued", "waiting"] as const) if (stageCounts[stage]) counts.push(`<span><b data-pipeline-count="${stage}">${stageCounts[stage]}</b> ${stage}</span>`);
  const link = (url: string | undefined, label: string) => {
    if (!url) return "";
    // Attribute escaping alone does not make a javascript: URL safe. Keep only supplied web links.
    try { if (!["http:", "https:"].includes(new URL(url).protocol)) return ""; } catch { return ""; }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label} ↗</a>`;
  };
  const rowHtml = (row: PipelineRow) => {
    const links = [link(row.agentUrl, "Open agent"), link(row.issueUrl, "Linear"), link(row.reviewUrl, "Review")].filter(Boolean);
    return `<li class="pipeline-row" data-pipeline-row="${escapeHtml(row.id)}" data-pipeline-stage="${escapeHtml(row.stage)}" data-pipeline-status="${escapeHtml(row.status)}"><div class="pipeline-ticket"><b>${escapeHtml(row.identifier)}</b><span>${escapeHtml(row.host)}</span></div><div class="pipeline-stage"><b>${STAGE_LABEL[row.stage]}</b><span class="pipeline-state ${escapeHtml(row.status)}">${STATUS_LABEL[row.status]}</span></div><p class="pipeline-evidence">${escapeHtml(row.detail)}</p><p class="pipeline-progress">Last progress: ${timestamp(row.lastProgressAt, "not recorded")}</p>${links.length ? `<nav class="pipeline-links" aria-label="Links for ${escapeHtml(row.identifier)}">${links.join("")}</nav>` : ""}</li>`;
  };
  const hostHtml = expected.map((host) => {
    const source = sources.find((item) => item.host === host);
    const state = hostState(source, host);
    const problem = !source ? "No pipeline observation received." : unreachable.includes(host) ? "Source unreachable; shown evidence is last received." : source.error !== undefined ? source.error || "Source failure reported." : !source.checkedAt ? "Source has not been checked." : "";
    return `<li class="pipeline-source" data-pipeline-source data-pipeline-checked="${escapeHtml(source?.checkedAt ?? "")}" data-pipeline-source-state="${state}"><div class="pipeline-ticket"><b>${escapeHtml(host)}</b><span class="pipeline-source-label">${{ normal: "Observed", stale: "Stale · unknown", failed: "Source failed", unknown: "Unknown" }[state]}</span></div><p>Checked: ${timestamp(source?.checkedAt ?? null, "not checked")} · Last arrival: ${timestamp(source?.lastArrivalAt ?? null, "not recorded")}</p>${problem ? `<p class="pipeline-source-error">${escapeHtml(problem)}</p>` : ""}</li>`;
  }).join("");
  const accounted = (["ready", "auto-approved", "superseded", "cancelled", "completed"] as const).filter((stage) => stageCounts[stage]);
  const outcomes = accounted.length ? `<p class="pipeline-accounted">Accounted reports: ${accounted.map((stage) => `${stageCounts[stage]} ${STAGE_LABEL[stage].toLowerCase()}`).join(" · ")}. Ready above counts actual open reviews.</p>` : "";
  return `<section class="pipeline" aria-labelledby="pipeline-title" data-pipeline data-pipeline-failures="${failures}" data-pipeline-health="${health}" data-pipeline-state="${health}"><div class="pipeline-heading"><h2 id="pipeline-title">Plan pipeline</h2><span class="pipeline-health ${health}" data-pipeline-health-label role="status">${healthLabel[health]}</span></div><p class="pipeline-fetch-error" data-pipeline-fetch-error role="status" hidden>Refresh failed; pipeline state unknown. Counts and evidence below are last received.</p><details id="pipeline-details"><summary><span class="pipeline-counts">${counts.join("")}</span><span class="pipeline-freshness">Checked: ${timestamp(oldestCheck, "not all hosts checked")} · Last arrival: ${timestamp(lastArrival, "not recorded")}</span><span class="pipeline-disclosure">Pipeline details</span></summary><div class="pipeline-body"><h3>On the way <span>${onWay.length}</span></h3>${onWay.length ? `<ul class="pipeline-list" data-pipeline-group="on-way">${onWay.map(rowHtml).join("")}</ul>` : `<p class="pipeline-empty" data-pipeline-group="on-way">${unknown ? "No confirmed work on the way in the available observations." : "No plans on the way."}</p>`}<h3>Needs attention <span>${attention.length}</span></h3>${attention.length ? `<ul class="pipeline-list" data-pipeline-group="attention">${attention.map(rowHtml).join("")}</ul>` : `<p class="pipeline-empty" data-pipeline-group="attention">No row-level attention reported.${unknown ? " Source health is unknown; this is not an all-clear." : ""}</p>`}<h3>Sources</h3>${hostHtml ? `<ul class="pipeline-list" data-pipeline-group="sources">${hostHtml}</ul>` : `<p class="pipeline-empty" data-pipeline-group="sources">No pipeline observations received.</p>`}${outcomes}</div></details></section>`;
}

export const PIPELINE_STYLE = `
.pipeline{margin-top:20px;background:var(--card);border-radius:14px;overflow-wrap:anywhere}
.pipeline-heading{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;padding:14px 16px 0}.pipeline h2{margin:0;font-size:1.0625rem}.pipeline-health{margin-left:auto;font-size:.8125rem;font-weight:600}.pipeline-health.normal{color:var(--ok)}.pipeline-health.attention,.pipeline-health.unknown{color:var(--warn)}.pipeline-health.failed{color:var(--bad)}
.pipeline summary{padding:10px 16px 12px;cursor:pointer;font-size:.8125rem;min-height:44px}.pipeline summary::marker{color:var(--muted)}.pipeline summary:focus-visible{outline:2px solid var(--tint);outline-offset:-2px;border-radius:10px}.pipeline-counts{display:inline-flex;flex-wrap:wrap;gap:4px 12px;max-width:100%;vertical-align:top;color:var(--sub)}.pipeline-counts b{color:var(--fg);font-weight:600}.pipeline-freshness{display:block;margin-top:6px;color:var(--muted)}.pipeline-disclosure{display:block;margin-top:6px;color:var(--tint);font-weight:600}
.pipeline-body{border-top:.5px solid var(--line);padding:0 16px 14px}.pipeline h3{margin:16px 0 6px}.pipeline h3 span{margin-left:4px}.pipeline-list{list-style:none;margin:0;padding:0}.pipeline-list>li+li{border-top:.5px solid var(--line)}.pipeline-row,.pipeline-source{padding:10px 0}.pipeline-ticket,.pipeline-stage{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:.8125rem}.pipeline-ticket{color:var(--muted)}.pipeline-ticket b{color:var(--sub)}.pipeline-stage{margin-top:4px;font-size:.875rem}.pipeline-state{font-size:.75rem;color:var(--muted)}.pipeline-state.attention,.pipeline-state.unknown,.pipeline-source-label{color:var(--warn)}.pipeline-state.failed,.pipeline-source-error{color:var(--bad)}.pipeline-source[data-pipeline-source-state=normal] .pipeline-source-label{color:var(--muted)}.pipeline-evidence{margin:5px 0 0;font-size:.875rem;color:var(--sub);white-space:pre-line}.pipeline-progress,.pipeline-source p,.pipeline-accounted,.pipeline-empty{margin:5px 0 0;font-size:.8125rem;color:var(--muted)}.pipeline-source p.pipeline-source-error{color:var(--bad)}.pipeline-accounted{margin-top:14px}.pipeline-links{display:flex;flex-wrap:wrap;gap:0 16px;margin-top:2px}.pipeline-links a{display:inline-flex;align-items:center;min-height:44px;font-size:.8125rem;font-weight:600;text-underline-offset:3px}.pipeline-links a:focus-visible{outline:2px solid var(--tint);outline-offset:2px;border-radius:4px}.pipeline-fetch-error{margin:8px 16px 0;font-size:.8125rem;color:var(--warn)}
`;

// Re-evaluate observation age even while refresh is deferred for an owner's draft or modal.
// checkedAt stays the backend timestamp; a successful fetch never resets it.
export const PIPELINE_CLIENT = `
function pipelineAge(at,now){const seconds=Math.max(0,Math.floor((now-Date.parse(at))/1000));if(seconds<60)return seconds+" s ago";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+" min ago";const hours=Math.floor(minutes/60);return hours<48?hours+" h ago":Math.floor(hours/24)+" d ago"}
let pipelineTimer=0;
function tickPipeline(){
clearTimeout(pipelineTimer);const root=document.querySelector("[data-pipeline]");if(!root)return;
const now=Date.now();let delay=30000,stale=false;
for(const time of root.querySelectorAll("[data-pipeline-time]"))time.textContent=pipelineAge(time.dateTime,now);
for(const source of root.querySelectorAll("[data-pipeline-source]")){
if(source.dataset.pipelineSourceState!=="normal"&&source.dataset.pipelineSourceState!=="stale")continue;
const checked=Date.parse(source.dataset.pipelineChecked),old=!Number.isFinite(checked)||now-checked>${HOST_STALE_MS};
source.dataset.pipelineSourceState=old?"stale":"normal";source.querySelector(".pipeline-source-label").textContent=old?"Stale · unknown":"Observed";stale=stale||old;
if(!old)delay=Math.min(delay,checked+${HOST_STALE_MS}+1-now);
}
const state=root.dataset.pipelineFetchFailed||stale?"unknown":root.dataset.pipelineHealth,label=root.querySelector("[data-pipeline-health-label]");
root.dataset.pipelineState=state;
label.className="pipeline-health "+state;const failures=Number(root.dataset.pipelineFailures||0);label.textContent=state==="unknown"&&failures?"Unknown · "+failures+" failure"+(failures===1?"":"s")+" reported":({normal:"Up to date",attention:"Needs attention",failed:"Failure reported",unknown:"Unknown"})[state];
pipelineTimer=setTimeout(tickPipeline,delay);
}
function pipelineFetchFailed(){const root=document.querySelector("[data-pipeline]");if(!root)return;root.dataset.pipelineFetchFailed="1";root.querySelector("[data-pipeline-fetch-error]").hidden=false;tickPipeline()}
`;
