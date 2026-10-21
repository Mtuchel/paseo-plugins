import type { InboxAvailability } from "./inbox-transport";
import type { DecisionView } from "../shared/decision-inbox";
import { groupRowsByTicket } from "./decision-groups";
import { decisionBucket, questionBundle, summarizeDecisions } from "../shared/decision-summary";

// Scoped extension of the review inbox: Apple system light/dark, Operate mode.
// The browser owns transient drafts only; the API owns revisions and delivery receipts.
const STYLE = `
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--press:#ebebf0;--tint:#0a64d6;--chip:#ececf1;--ok:#1b7a3d;--ok-bg:#dcf5e3;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--press:#2c2c2e;--tint:#5aa9ff;--chip:#2c2c2e;--ok:#8fe0a8;--ok-bg:#123d22;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scrollbar-color:var(--line) var(--bg)}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-variant-numeric:tabular-nums}::selection{background:color-mix(in srgb,var(--tint) 28%,transparent)}a{color:var(--tint);text-underline-offset:3px}button,input,textarea{font:inherit;caret-color:var(--tint)}button{min-height:44px;padding:9px 14px;border:0;border-radius:10px;background:var(--chip);color:var(--fg);font-size:.875rem;font-weight:600;cursor:pointer}button:hover:not(:disabled){background:var(--press)}button:active:not(:disabled){filter:brightness(.92)}button.primary{background:var(--tint);color:#fff}button.primary:hover:not(:disabled){filter:brightness(.9);background:var(--tint)}button:disabled{opacity:.5;cursor:default}button,a,input,textarea,summary{touch-action:manipulation}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--tint);outline-offset:3px}input:not([type=radio]):not([type=checkbox]),textarea{display:block;width:100%;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:.9375rem}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}textarea{resize:vertical;min-height:96px}input[type=radio],input[type=checkbox]{width:18px;height:18px;accent-color:var(--tint);flex:none;margin:3px 0 0}h1,h2,h3,p{overflow-wrap:anywhere}h1{font-size:1.75rem;line-height:1.15;letter-spacing:-.02em;margin:0}h2{font-size:1.375rem;line-height:1.3;letter-spacing:-.01em;margin:0}h3{font-size:1.0625rem;margin:24px 0 8px}p{margin:8px 0 0}.muted{color:var(--muted);font-size:.875rem}.pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;color:var(--sub)}.skip{position:fixed;left:12px;top:-80px;z-index:5;background:var(--card);padding:12px}.skip:focus{top:12px}[hidden]{display:none!important}
.shell{max-width:1440px;margin:auto;display:grid;grid-template-columns:minmax(300px,390px) minmax(0,1fr);min-height:100dvh}.queue{min-width:0;border-right:1px solid var(--line)}.queue-header{padding:24px 20px 18px}.queue-header .top{display:flex;gap:10px;align-items:center;justify-content:space-between}.search{display:block;margin:20px 0 6px;font-size:.875rem;font-weight:600}.queue-header input{background:var(--card)!important}.coverage{margin:0 16px 16px;padding:12px 14px;border-radius:12px;background:var(--chip);font-size:.875rem;color:var(--sub);overflow-wrap:anywhere}.coverage.warning{color:var(--warn);background:var(--warn-bg)}.coverage p{margin:4px 0 0}.flow{margin:0 0 10px;padding-bottom:10px;border-bottom:1px solid var(--line)}.flow h3{margin:0 0 4px;font-size:.9375rem;color:var(--fg)}.queue-section{margin:24px 16px}.queue-section h2{font-size:1.0625rem;margin:0 4px 8px;display:flex;justify-content:space-between;gap:8px}.count{font-size:.875rem;font-weight:500;color:var(--muted)}.list{list-style:none;margin:0;padding:0;background:var(--card);border-radius:14px;overflow:hidden}.list li+li{border-top:1px solid var(--line)}.row{display:block;text-align:left;width:100%;padding:14px 16px;border-radius:0;background:transparent;font-weight:400;overflow-wrap:anywhere}.row[aria-current=true]{background:color-mix(in srgb,var(--tint) 12%,var(--card))}.row .title{display:block;font-size:.9375rem;font-weight:600;line-height:1.35;margin:4px 0}.row .meta{display:block;font-size:.75rem;color:var(--muted)}.row .summary{display:block;font-size:.8125rem;color:var(--sub);margin-top:5px}.row .state{display:block;margin-top:6px;font-size:.75rem;color:var(--warn)}.group>summary{padding:12px 16px;font-weight:400;overflow-wrap:anywhere}.group>summary .title{display:block;font-size:.9375rem;font-weight:600;line-height:1.35;margin:2px 0 0}.group>summary .meta{display:block;font-size:.75rem;color:var(--muted)}.group[open]>summary{border-bottom:1px solid var(--line)}.empty{padding:18px 16px;background:var(--card);border-radius:14px;font-size:.875rem;color:var(--muted)}
.detail{min-width:0;background:var(--card);padding:24px 32px 64px}.detail-inner{max-width:74ch;margin:0 auto}.detail-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:24px}.detail-nav a{font-size:.875rem}.back{display:none}.placeholder{padding:48px 0;color:var(--muted)}.placeholder h2{color:var(--fg)}.detail-heading{margin-bottom:24px}.detail-heading .muted{margin-bottom:6px}.links{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:14px;font-size:.875rem}.section{padding:24px 0;border-top:1px solid var(--line)}.section h3{margin:0 0 10px}.context{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:8px 16px;margin:0;font-size:.9375rem}.context dt{color:var(--muted)}.context dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:14px 16px;border-radius:12px;background:var(--warn-bg);color:var(--warn);font-size:.9375rem;margin-bottom:20px;overflow-wrap:anywhere}.notice button{margin-top:12px}.notice.error{color:var(--bad);background:var(--bad-bg)}.notice.success{color:var(--ok);background:var(--ok-bg)}.notice:empty{display:none}.status{margin:0 0 20px}.form-section{padding:24px 0;border-top:1px solid var(--line)}fieldset{min-width:0;border:0;padding:0;margin:0 0 24px}legend{font-weight:600;font-size:1rem;margin-bottom:12px;padding:0;overflow-wrap:anywhere;width:100%}.option{display:flex;gap:10px;padding:12px;margin:6px 0;border:1px solid var(--line);border-radius:10px;cursor:pointer;overflow-wrap:anywhere}.option:has(input:checked){border-color:var(--tint);background:color-mix(in srgb,var(--tint) 8%,var(--card))}.option .description{display:block;color:var(--sub);font-size:.875rem;margin-top:3px}.field-label{display:block;font-size:.9375rem;font-weight:600;margin:16px 0 6px}.help{font-size:.875rem;color:var(--muted);margin:8px 0 12px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.actions button{max-width:100%;overflow-wrap:anywhere}.manual{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.manual button{margin-top:12px}.form-section h3{margin:0 0 8px}.history{list-style:none;padding:0;margin:0}.history li{padding:16px 0;border-top:1px solid var(--line)}.history b{font-size:.9375rem}.history .pre{margin-top:8px;font-size:.9375rem}summary{cursor:pointer;font-weight:600;min-height:44px;padding:10px 0}details .pre{padding:12px 0}#refresh-state{min-height:1.3em}.global-status{margin:0 16px 16px;font-size:.875rem;color:var(--bad);overflow-wrap:anywhere}
@media(min-width:900px){.shell{height:100vh;height:100dvh;overflow:hidden}.queue,.detail{overflow-y:auto;overscroll-behavior:contain}}
@media(max-width:899px){.shell{display:block;min-height:100dvh}.queue{border-right:0}.detail{padding:20px max(18px,env(safe-area-inset-right)) 48px max(18px,env(safe-area-inset-left));min-height:100dvh}.detail:not(.show){display:none}.shell.detail-open .queue{display:none}.back{display:inline-block}.queue-header{padding-top:calc(20px + env(safe-area-inset-top))}.detail-nav{margin-bottom:20px}.context{grid-template-columns:1fr;gap:4px}.context dd{margin-bottom:10px}}
@media(prefers-reduced-motion:no-preference){.row{transition:background-color 160ms ease-out}.notice{animation:notice-in 180ms ease-out}@keyframes notice-in{from{background-color:var(--chip)}to{}}}
@media(prefers-color-scheme:dark){button.primary{color:#001b38}}
.merge-status{width:100%;max-width:1440px;margin:0 auto;padding:16px 24px;border-bottom:1px solid var(--line);background:var(--card);overflow-wrap:anywhere}.merge-status.warning{background:var(--warn-bg)}.merge-status h2{margin:0;font-size:1.0625rem;line-height:1.4}.merge-status .merge-meta{margin:6px 0 0;font-size:.8125rem;color:var(--sub)}.merge-status ul{list-style:none;padding:0;margin:12px 0 0}.merge-blocker{padding:12px 0;border-top:1px solid var(--line);font-size:.875rem}.merge-blocker p{margin:4px 0}.merge-blocker .links{margin-top:4px;gap:8px 18px}.merge-blocker a{display:inline-flex;align-items:center;min-height:44px}.merge-phase{font-weight:600;color:var(--sub)}.merge-status a:focus-visible{outline:3px solid var(--tint);outline-offset:3px;border-radius:2px}
@media(min-width:900px){body{height:100dvh;display:flex;flex-direction:column}.merge-status{flex-shrink:0;max-height:45dvh;overflow-y:auto}.shell{width:100%;height:auto;min-height:0;flex:1}}
@media(max-width:899px){.merge-status{padding:calc(16px + env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) 12px max(18px,env(safe-area-inset-left))}.shell{min-height:0}}
`;

const CLIENT = String.raw`
(() => {
  let view = JSON.parse(document.getElementById('decision-data').textContent);
  let availability = view.availability || null;
  let availabilityError = '', recoveryPending = false;
  let selected = null, selectedSnapshot = null, stale = false, busy = false, refreshing = false;
  let refreshError = '', lastUpdated = Date.now(), readingTimer = 0;
  let retainedMerge = null;
  let renderedMerge = null;
  const drafts = new Map(), results = new Map(), completed = new Set(), uncertain = new Set();
  // Withheld nonurgent source reviews never ship in the feed: they arrive here in server pages,
  // browsed, searched and answered like any owner ask. reviewQuery is the query the loaded
  // pages answer; reviewOffset is how many server sources those pages have consumed.
  let pagedRows = [], reviewTotal = null, reviewOffset = 0, reviewQuery = null, reviewLoading = false, reviewError = '', reviewErrorAppend = false, reviewGeneration = 0, reviewTimer = 0, reviewSource = null;
  // Recovery evidence beyond what the feed references is read from the owning host when its
  // section is first opened, one host at a time. A loaded list answers one pass with one ticket
  // total (flowSignature), so a routine 30-second refresh keeps it and a new pass or total drops
  // it; flowOpen is what a rewrite of the coverage element has to restore.
  const flowTickets = new Map(), flowSource = new Map(), flowFailures = new Map();
  const flowLoading = new Set(), flowOpen = new Set();
  const queue = document.getElementById('queue-list');
  const pane = document.getElementById('detail-content');
  const shell = document.querySelector('.shell');
  const detail = document.getElementById('detail');
  const search = document.getElementById('search');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
  const key = row => JSON.stringify([row.host, row.backendInstanceId || null, row.target, row.id, row.revision]);
  const identity = row => JSON.stringify([row.host, row.target, row.id]);
  const date = value => {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at.toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : 'Time unavailable';
  };
  function safeLink(url, label) {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
      return '<a href="' + escape(parsed.href) + '" target="_blank" rel="noopener noreferrer">' + escape(label) + '</a>';
    } catch { return ''; }
  }
  // Host plus source identity: the same source must never appear twice, whether it reaches the
  // page in the feed or in a page of withheld source reviews.
  const sourceKey = row => JSON.stringify([row.host, row.data.issueId, row.data.sourceId || row.revision]);
  function rows() {
    const items = [];
    for (const host of view.hosts) {
      if (host.host === view.canonicalHost) {
        for (const ask of host.asks) items.push({host:host.host, backendInstanceId:host.backendInstanceId, target:'owner', id:JSON.stringify([ask.issueId, ask.sourceId || ask.revision]), revision:ask.revision, data:ask});
      }
      for (const live of host.live) items.push({host:host.host, backendInstanceId:host.backendInstanceId, target:'live', id:JSON.stringify([live.agentId, live.requestId]), revision:live.revision, data:live});
    }
    let base;
    if (!view.tasks) base = items.filter(row => !completed.has(key(row)));
    else {
      const bySource = new Map(items.map(row => [JSON.stringify([row.host, row.target, row.id, row.revision]), row]));
      base = view.tasks.flatMap(task => {
        const row = bySource.get(JSON.stringify([task.host, task.target, task.id, task.revision]));
        return row && !completed.has(key(row)) ? [{...row, task}] : [];
      });
    }
    // View rows first, then loaded review pages: a source already carried by the feed never
    // doubles through a page.
    const seen = new Set(base.map(sourceKey));
    return [...base, ...pagedRows.filter(row => !completed.has(key(row)) && !seen.has(sourceKey(row)))];
  }
  // Paged source reviews: one owner row per loaded ask, identical to a view owner ask row so
  // selection, detail, receipts and actions work unchanged. paged marks the server-paged rows.
  function pagedRow(page, ask) {
    return {host:page.host, ...(page.backendInstanceId ? {backendInstanceId:page.backendInstanceId} : {}), target:'owner', id:JSON.stringify([ask.issueId, ask.sourceId || ask.revision]), revision:ask.revision, data:ask, paged:true, reason:ask.attentionReason || ''};
  }
  const searchQuery = () => search.value.trim().slice(0, 200);
  const reviewNeeded = () => pagedRows.length > 0 || view.hosts.some(host => (host.sourceReviews || 0) > 0);
  // The server total counts every matching withheld source, loaded or not; until a page answer
  // for the current query arrives, the hosts' withheld counts are the only ones known.
  function reviewCount() {
    if (reviewTotal !== null && reviewQuery === searchQuery()) return reviewTotal;
    return view.hosts.reduce((sum, host) => sum + (host.sourceReviews || 0), 0);
  }
  const reviewHasMore = () => reviewTotal !== null && reviewQuery === searchQuery() && reviewOffset < reviewTotal;
  // Which owner collection the withheld sources come from. The owner sources change only when the
  // canonical host recollects, so a routine 30-second refresh keeps the pages already loaded.
  const withheldSource = () => view.hosts.filter(host => (host.sourceReviews || 0) > 0).map(host => host.host + '@' + host.updatedAt + '#' + host.sourceReviews).join(' ');
  // Which steward pass and ticket total a loaded recovery list answers. The feed ships only the
  // tickets its decisions reference plus the steward's total, so a list is complete exactly when
  // it holds every ticket the summary counts.
  const flowTotal = data => typeof data.ticketCount === 'number' ? data.ticketCount : (data.tickets || []).length;
  const flowSignature = data => String(data.at) + '#' + flowTotal(data);
  const flowLoaded = host => flowSource.get(host.host) === flowSignature(host.flow) ? flowTickets.get(host.host) || [] : (host.flow.tickets || []);
  const flowNeedsMore = host => flowTotal(host.flow) > flowLoaded(host).length;
  async function loadFlow(hostName) {
    const host = view.hosts.find(item => item.host === hostName);
    // One read per host: the feed may already carry every ticket, and a request in flight serves
    // every further open.
    if (!host || !host.flow || flowLoading.has(hostName) || !flowNeedsMore(host)) return;
    const signature = flowSignature(host.flow);
    flowLoading.add(hostName);
    flowFailures.delete(hostName);
    renderQueue();
    try {
      const response = await fetch('/api/decisions/flow?host=' + encodeURIComponent(hostName), {cache:'no-store', headers:{accept:'application/json'}});
      const page = await response.json();
      if (!response.ok) throw new Error(page && typeof page.error === 'string' ? page.error : 'Recovery evidence load failed (' + response.status + ').');
      if (!page || page.host !== hostName || !Array.isArray(page.tickets)) throw new Error('The recovery ticket list is unavailable.');
      flowTickets.set(hostName, page.tickets);
      flowSource.set(hostName, signature);
    } catch (error) {
      flowFailures.set(hostName, error instanceof Error ? error.message : 'Recovery evidence load failed.');
    } finally {
      flowLoading.delete(hostName);
      renderQueue();
    }
  }
  // One page per request, always offset 0 for a reload. The generation discards a response that a
  // newer request superseded; a discarded response changes nothing, so the rows, the total and
  // the error always describe the same query.
  async function loadReviews(append = false) {
    if (!reviewNeeded()) {
      // The feed reports nothing withheld any more: drop a stale error or page with the reason.
      if (reviewError || reviewTotal !== null) {
        reviewError = ''; reviewTotal = null; reviewOffset = 0; reviewQuery = null;
        renderQueue();
      }
      return;
    }
    const query = searchQuery();
    if (append && (reviewLoading || !reviewHasMore())) return;
    const generation = ++reviewGeneration;
    reviewLoading = true;
    reviewError = '';
    reviewErrorAppend = append;
    renderQueue();
    try {
      const response = await fetch('/api/decisions/reviews?offset=' + (append ? reviewOffset : 0) + '&limit=50' + (query ? '&q=' + encodeURIComponent(query) : ''), {cache:'no-store', headers:{accept:'application/json'}});
      const page = await response.json();
      if (generation !== reviewGeneration) return;
      if (!response.ok) throw new Error(page && typeof page.error === 'string' ? page.error : 'Source review load failed (' + response.status + ').');
      if (!page || typeof page.host !== 'string' || !Array.isArray(page.asks) || !Number.isFinite(page.total)) throw new Error('The source review page is unavailable.');
      const loaded = page.asks.filter(ask => ask && typeof ask === 'object').map(ask => pagedRow(page, ask));
      pagedRows = append ? pagedRows.concat(loaded) : loaded;
      if (!append) reviewSource = withheldSource();
      reviewOffset = (Number.isFinite(page.offset) ? page.offset : 0) + page.asks.length;
      reviewTotal = page.total;
      reviewQuery = query;
    } catch (error) {
      if (generation !== reviewGeneration) return;
      reviewError = error instanceof Error ? error.message : 'Source review load failed.';
    } finally {
      if (generation === reviewGeneration) {
        reviewLoading = false;
        renderQueue();
        refreshSelection();
      }
    }
  }
  function scheduleReviews() {
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => { void loadReviews(false); }, 250);
  }
  function refocusReview() {
    queue.querySelector(reviewError ? '[data-retry-review]' : '[data-more-review]')?.focus({preventScroll:true});
  }
  function receipts() {
    return view.hosts.flatMap(host => host.history.map(receipt => ({host:host.host, backendInstanceId:host.backendInstanceId, target:'receipt', id:receipt.id, revision:receipt.revision, data:receipt})))
      .sort((a, b) => Date.parse(b.data.at) - Date.parse(a.data.at));
  }
  function priority(row) {
    if (row.paged) return 'review';
    const data = row.data;
    const deferred = data.deferredUntil && Date.parse(data.deferredUntil) > Date.now();
    if (deferred || row.task?.priority === 'waiting' || (row.target === 'owner' && ['research','delegated'].includes(data.disposition))) return 'waiting';
    if (data.deliveryUnknown) return 'review';
    if (row.target === 'live') return row.task?.priority || 'owner';
    if (data.attention === 'advisor' || data.attention === 'dependency') return 'waiting';
    return data.attention === 'owner' ? 'owner' : 'review';
  }
  const other = row => priority(row) === 'waiting';
  function state(row) {
    const data = row.data;
    if (row.target === 'receipt') return data.action + ' · delivery: ' + data.delivery;
    if (data.deliveryUnknown) return 'Delivery unknown · inspect the original source';
    if (data.deferredUntil && Date.parse(data.deferredUntil) > Date.now()) return 'Deferred until ' + date(data.deferredUntil);
    if (row.target === 'live') return data.kind === 'permission' ? 'Permission · choose an original action' : 'Live question';
    if (!data.extracted) return data.attention === 'owner' ? 'Current owner wait · extraction unresolved' : 'Nonurgent source review · extraction unresolved';
    const labels = {owner:'Needs owner', advisor:'Advisor wait', dependency:'Dependency wait', info:'Information'};
    return [labels[data.attention], data.disposition, data.blockerIdentifier ? 'Blocked by ' + data.blockerIdentifier : ''].filter(Boolean).join(' · ');
  }
  function fingerprint(row) {
    const data = row.data;
    // Timestamps and dispositions can change without changing the question or its source.
    return JSON.stringify([row.backendInstanceId || null, row.revision, data.title, data.source, data.summary, data.questions, data.actions, data.kind, data.attention, data.attentionReason, data.blockerIdentifier, data.ticketIdentifier, data.route, data.agentId, data.url, data.issueUrl, data.agentUrl]);
  }
  // Only a live displayed snapshot may send. Availability probes can close the gate but cannot
  // replace its displayed frontdoor epoch or open it without a successful data replacement.
  function unavailable() {
    return recoveryPending || !!availabilityError || !availability || availability.stale || availability.readOnly || availability.backendState !== 'ready';
  }
  function availabilityReason() {
    if (!availability) return 'The inbox backend has not answered yet; no snapshot was received.';
    if (availabilityError) return availabilityError;
    if (recoveryPending) return 'Backend recovery is awaiting a live decision snapshot. Refresh before sending.';
    return (availability.reason || 'The inbox backend is not ready.') + ' Displayed decisions are the last received' + (availability.capturedAt ? ' snapshot from ' + date(availability.capturedAt) : ' data') + '.';
  }
  function hostProblem(row) {
    const host = view.hosts.find(item => item.host === row.host);
    if (unavailable()) return availabilityReason();
    if (refreshError) return 'Refresh failed. This source has not been checked. Refresh before sending.';
    if (view.curation?.error) return 'Collection failed. Displayed tasks may be stale; wait for a successful collection before sending.';
    if (row.target === 'owner' && row.data.mirrorsLiveRequest && bucket(row) === 'review') return 'This source no longer matches an exact current live question. Inspect the original ticket or agent before answering; a newer question is not this round.';
    if (row.data.deliveryUnknown) return 'Delivery for this source is unconfirmed. Inspect the original ticket or agent; do not send another answer.';
    if (!host || view.unreachable.includes(row.host)) return 'This host is unavailable. Its displayed source may be stale; actions are paused.';
    if (row.target === 'owner' && row.host !== view.canonicalHost) return 'The canonical owner-ask host changed. Select the current canonical ask before acting.';
    return '';
  }
  function recoveryContext(ticket) {
    return '<dl class="context"><dt>Recovery state</dt><dd>' + escape(ticket.situation) + ' · since ' + escape(date(ticket.since)) + '</dd>' +
      '<dt>Evidence</dt><dd>' + escape(ticket.reason || 'No reason supplied') + '</dd>' +
      '<dt>Next action</dt><dd>' + escape(ticket.nextAction || 'Not supplied') + '</dd>' +
      '<dt>Waiting for</dt><dd>' + escape(ticket.waitReason || 'No wait reason supplied') + '</dd>' +
      '<dt>Next check</dt><dd>' + escape(ticket.nextCheckAt ? date(ticket.nextCheckAt) : 'Not scheduled in this snapshot') + '</dd>' +
      '<dt>Responsible generation</dt><dd>' + escape(ticket.responsibleGeneration || 'Not supplied') + '</dd>' +
      '<dt>Last verified advancement</dt><dd>' + escape(ticket.lastVerifiedAdvancementAt ? date(ticket.lastVerifiedAdvancementAt) : 'None recorded') + '</dd></dl>';
  }
  // Steward counts describe ticket states, not actionable owner decisions. A waiting-owner
  // state alone does not establish an original question or manual action.
  function flow() {
    const hosts = view.hosts.filter(host => host.flow);
    if (!hosts.length) return '';
    return hosts.map(host => {
      const data = host.flow;
      const counts = Object.entries(data.counts || {}).sort((a, b) => b[1] - a[1]);
      const oldest = (data.oldest || []).slice(0, 5);
      const control = data.control;
      return '<section class="flow"><h3>Ticket flow' + (view.hosts.length > 1 ? ' · ' + escape(host.host) : '') + '</h3>' +
        (data.error ? '<p>' + escape(data.error) + '</p>' : '') +
        '<p>' + (data.at ? 'Pass ' + date(data.at) + '. ' : 'No pass yet. ') + (counts.length ? counts.map(([state, count]) => escape(state) + ' ' + count).join(' · ') : 'No open tickets in scope.') + '</p>' +
        '<p>These are ticket-state totals, not counts of actionable decisions. Waiting-owner does not by itself establish a current owner question. Collected question and manual-action sources are listed separately.</p>' +
        (oldest.length ? '<p>Oldest: ' + oldest.map(item => escape(item.identifier) + ' — ' + escape(item.situation) + ' since ' + date(item.since)).join(' · ') + '</p>' : '') +
        (control ? '<p>Recovery control: ' + (control.passStartedAt ? 'pass started ' + escape(date(control.passStartedAt)) : 'no pass in flight') +
          ' · overdue ' + escape(Math.round(control.overduePassMs / 1000)) + 's · maximum unattended ' + escape(Math.round(control.maxUnattendedMs / 1000)) + 's.</p>' +
          '<p>Outcomes: ' + Object.entries(control.recoveryOutcomes).map(([outcome, count]) => escape(outcome) + ' ' + escape(count)).join(' · ') + '</p>' : '') +
        (flowTotal(data) ? recoveryEvidence(host) : '') +
        '</section>';
    }).join('');
  }
  // Recovery evidence: the feed carries the referenced tickets and the steward's total, and the
  // rest of the list is read from the owning host the first time the section is opened. The count
  // is always the host's own total, so a partial list never reads as the whole one.
  function recoveryEvidence(host) {
    const data = host.flow;
    const total = flowTotal(data);
    const tickets = flowLoaded(host);
    const loading = flowLoading.has(host.host);
    const failure = flowFailures.get(host.host);
    return '<details' + (flowOpen.has(host.host) || loading || failure ? ' open' : '') + ' data-flow="' + escape(host.host) + '">' +
      '<summary>Recovery evidence · ' + total + ' tickets' + (tickets.length < total ? ' · ' + tickets.length + ' loaded' : '') + '</summary>' +
      tickets.map(ticket => '<section class="section"><h3>' + escape(ticket.identifier) + '</h3>' + recoveryContext(ticket) + '</section>').join('') +
      (loading ? '<p class="empty" role="status">Loading the recovery evidence of this host…</p>'
        : failure ? '<p class="empty">Recovery evidence unavailable: ' + escape(failure) + '</p><button type="button" data-retry-flow="' + escape(host.host) + '">Retry recovery evidence</button>'
        : tickets.length < total ? '<p class="empty">The remaining tickets are read from their host when this section is open.</p>' : '') +
      '</details>';
  }
  function mergeStatus() {
    const source = view.hosts.find(host => host.host === view.canonicalHost);
    if (retainedMerge && view.canonicalHost && retainedMerge.host !== view.canonicalHost) retainedMerge = null;
    const received = source?.mergeStatus;
    // A restarted collector may have no successful read yet. Retain the last complete inventory
    // until another successful snapshot arrives; still show the current collection error below.
    if (received && Number.isFinite(Date.parse(received.checkedAt || '')) && (!received.error || !retainedMerge)) {
      retainedMerge = {host: source.host, status: received};
    }
    const status = retainedMerge?.status;
    const blockers = status?.blockers || [];
    const warnings = [];
    if (!source?.mergeStatus) warnings.push('Canonical merge status unavailable. The tickets host may be unreachable or need an upgrade.');
    if (received?.error) warnings.push(received.error);
    if (received && !Number.isFinite(Date.parse(received.checkedAt || '')) && status) warnings.push('The current collector has not completed a successful check.');
    const at = status?.checkedAt ? Date.parse(status.checkedAt) : NaN;
    if (!Number.isFinite(at)) warnings.push('No successful queue blocker check has completed.');
    else if (Date.now() - at > 300000) warnings.push('Queue blocker evidence is over five minutes old.');
    if (refreshError) warnings.push(refreshError);
    if (unavailable()) warnings.push(availabilityReason());
    const heading = blockers.length ? 'Merges paused — ' + blockers[0].title + (blockers.length > 1 ? ' (+' + (blockers.length - 1) + ' more)' : '') :
      warnings.length ? 'Merge status unavailable' : 'No open queue blockers';
    const phases = {'waiting-approval':'Waiting for approval', queued:'Queued', working:'Implementing repair', 'waiting-input':'Waiting for input', review:'In review', failed:'Repair failed', unknown:'Repair activity unconfirmed'};
    const element = document.getElementById('merge-status');
    element.classList.toggle('warning', blockers.length > 0 || warnings.length > 0);
    const html = '<h2 id="merge-status-title">' + escape(heading) + '</h2>' +
      (warnings.length ? '<p class="merge-meta">' + warnings.map(escape).join(' ') + (blockers.length ? ' Showing the last received blocker evidence.' : '') + '</p>' : '') +
      '<p class="merge-meta">' + (Number.isFinite(at) ? 'Last checked ' + escape(date(status.checkedAt)) : 'Last checked: unavailable') +
      (source?.host || retainedMerge?.host ? ' · ' + escape(source?.host || retainedMerge.host) : '') + '</p>' +
      (blockers.length ? '<ul>' + blockers.map(row => '<li class="merge-blocker" data-merge-blocker="' + escape(row.identifier) + '"><b>' + escape(row.identifier) + ' · ' + escape(row.title) + '</b>' +
        '<p class="merge-phase">' + escape(phases[row.phase] || phases.unknown) + ' · ' + escape(row.status) + '</p><p>' + escape(row.nextAction) + '</p>' +
        '<div class="links">' + safeLink(row.issueUrl, 'Open blocker').replace('<a ', '<a data-merge-open="blocker" ') + safeLink(row.agentUrl, 'Open agent').replace('<a ', '<a data-merge-open="agent" ') + '</div></li>').join('') + '</ul>' : '');
    // Do not replace focused links during a search/re-render when their evidence did not change.
    if (renderedMerge !== html) { element.innerHTML = html; renderedMerge = html; }
  }
  function coverage() {
    mergeStatus();
    const warnings = [];
    // A host whose first read is still under way is shown as being read, not as failed, and the
    // page asks again shortly instead of on the 30-second cycle; a failed read is a warning.
    const reading = view.reading || [];
    if (unavailable()) warnings.push(availabilityReason());
    if (!view.canonicalHost) { if (!view.canonicalReading) warnings.push('Canonical Linear owner-ask host unavailable. Owner asks are not shown.'); }
    else if (!view.hosts.some(host => host.host === view.canonicalHost)) warnings.push('Canonical Linear owner-ask host ' + view.canonicalHost + ' is missing.');
    for (const host of view.unreachable) if (!reading.includes(host)) warnings.push(host + ' unavailable; its decisions may be missing.');
    const interval = view.curation?.intervalMs || 900000;
    for (const host of view.hosts) {
      if (reading.includes(host.host)) continue;
      if (host.error) warnings.push(host.host + ' partial or unavailable: ' + host.error);
      const checked = Date.parse(host.updatedAt);
      if (!Number.isFinite(checked)) warnings.push(host.host + ' source snapshot time is unavailable.');
      else if (Date.now() - checked > interval + 30000) warnings.push(host.host + ' source snapshot is older than the collection interval; decisions may have changed.');
    }
    if (!view.hosts.length) warnings.push('No hosts returned a decision snapshot. This is not an empty inbox.');
    if (refreshError) warnings.push(refreshError + ' Displayed decisions are the last received snapshot.');
    if (view.curation?.error) warnings.push('Decision collection failed: ' + view.curation.error);
    if (view.curation && !view.curation.running) warnings.push('Background collection is not running. The list is collected only while requested.');
    if (view.curation?.running && view.curation.nextRefreshAt && Date.now() - Date.parse(view.curation.nextRefreshAt) > 30000) warnings.push('Scheduled collection is overdue. The received task list may be stale.');
    const element = document.getElementById('coverage');
    element.classList.toggle('warning', warnings.length > 0);
    if (reading.length && !refreshError && !readingTimer) readingTimer = setTimeout(() => { readingTimer = 0; if (!document.hidden) void refresh(); }, 2000);
    const status = reading.length ? '<p role="status">Reading decisions' + (view.canonicalReading ? ' and owner asks' : '') + ' from ' + escape(reading.join(', ')) + '…</p>' : '';
    const withheld = view.hosts.reduce((sum, host) => sum + (host.sourceReviews || 0), 0);
    const sources = view.hosts.map(host => '<p><b>' + escape(host.host) + '</b> · ' + host.asks.length + ' owner sources · ' + host.live.length + ' live requests' + (host.sourceReviews ? ' · ' + host.sourceReviews + ' sources to review' : '') + '<br>Source snapshot: ' + escape(date(host.updatedAt)) + '</p>').join('');
    const retained = rows();
    const unresolved = retained.filter(row => row.target === 'owner' && !row.data.extracted).length;
    const expanded = element.querySelector('#source-coverage')?.open;
    element.innerHTML = (warnings.length ? '<b>Incomplete or stale coverage</b>' + warnings.map(text => '<p>' + escape(text) + '</p>').join('') : '') + status +
      (summarizeDecisions(view).unverified ? '<p>Some current requests still need question or delivery verification; they are in source review, not the decision badge.</p>' : '') +
      '<details id="source-coverage"' + (expanded ? ' open' : '') + '><summary>' + retained.length + ' source tasks · ' + unresolved + ' unresolved' + (withheld ? ' · ' + withheld + ' sources to review' : '') + ' · coverage</summary>' + sources +
      '<p>Collected every 15 minutes, even with this page closed. Retained after exact-source deduplication and confirmed answers; includes waits and unresolved extraction, not just immediately actionable decisions.</p>' +
      (view.canonicalHost ? '<p>Canonical Linear source: ' + escape(view.canonicalHost) + '</p>' : '') +
      '<details><summary>Ticket flow — not decision counts</summary>' + flow() + '</details></details>';
    const curation = view.curation;
    document.getElementById('refresh-state').textContent = refreshing ? 'Checking for updates…' :
      curation ? 'Updated: ' + (curation.lastRefreshAt ? date(curation.lastRefreshAt) : 'not yet collected') +
        ' · Next: ' + (curation.nextRefreshAt ? date(curation.nextRefreshAt) : 'collection stopped') :
        'Snapshot received ' + date(availability?.lastCheckedAt || new Date(lastUpdated).toISOString()) + ' · Background collection status unavailable';
  }
  function queueRow(row) {
    const data = row.data;
    const title = row.target === 'receipt' ? data.identifier + ' · ' + data.action : data.title;
    const meta = [data.identifier, row.host, row.target === 'owner' ? data.ticketIdentifier : ''].filter(Boolean).join(' · ');
    return '<li><button type="button" class="row" data-key="' + escape(key(row)) + '" aria-current="' + (selected && key(selected) === key(row) ? 'true' : 'false') + '">' +
      '<span class="meta">' + escape(meta) + '</span><span class="title">' + escape(title) + '</span>' +
      (data.summary ? '<span class="summary">' + escape(data.summary) + '</span>' : '') +
      (row.task?.reason || row.reason ? '<span class="summary">' + escape(row.task?.reason || row.reason) + '</span>' : '') +
      '<span class="state">' + escape(state(row)) + '</span></button></li>';
  }
  // Presentation grouping: one queue entry per ticket, expanding to the untouched per-source
  // rows. A single-member group renders exactly like an ungrouped row. The function is embedded
  // from server/decision-groups.ts, which keeps its source self-contained for this.
  const groupRowsByTicket = ${groupRowsByTicket.toString()};
  const decisionBucket = ${decisionBucket.toString()};
  const questionBundle = ${questionBundle.toString()};
  const summarizeDecisions = ${summarizeDecisions.toString()};
  const bucket = row => decisionBucket({...row, live:view.hosts.find(host => host.host === row.host)?.live || []});
  function groupRow(group, open) {
    if (group.rows.length === 1) return queueRow(group.rows[0]);
    const first = group.rows[0];
    const title = first.target === 'receipt' ? first.data.identifier + ' · ' + first.data.action : first.data.title;
    return '<li class="group"><details' + (open ? ' open' : '') + '><summary><span class="meta">' + escape(group.ticket + ' · ' + group.rows.length + ' sources') + '</span><span class="title">' + escape(title || group.ticket) + '</span></summary>' +
      '<ul class="list">' + group.rows.map(queueRow).join('') + '</ul></details></li>';
  }
  function renderQueue() {
    const focused = queue.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = row => terms.every(term => JSON.stringify([row.host, row.data]).toLocaleLowerCase().includes(term));
    const all = rows();
    // Canonical counting and source rendering are separate. Filtering never changes the
    // global badge, and local confirmations cannot leave an already answered round in it.
    const active = new Set(all.filter(row => !row.paged).map(row => JSON.stringify([row.host, row.target, row.id, row.revision])));
    const summary = summarizeDecisions({...view, tasks:(view.tasks || all.filter(row => !row.paged).map(row => ({host:row.host,target:row.target,id:row.id,revision:row.revision,priority:priority(row)}))).filter(task => active.has(JSON.stringify([task.host,task.target,task.id,task.revision])))});
    const countCurrent = summary.coverageComplete && !unavailable() && !refreshError;
    const groups = [
      ['Needs your decision', all.filter(row => !row.paged && bucket(row) === 'decisions'), true],
      ['Personal actions', all.filter(row => !row.paged && bucket(row) === 'actions'), true],
      ['Needs source review', all.filter(row => row.paged || bucket(row) === 'review'), false],
      ['Research, delegated & other waits', all.filter(other), true],
      ['Recent receipts', receipts(), false]
    ];
    const selectedKey = selected ? key(selected) : null;
    let found = 0, reviewShown = false;
    queue.innerHTML = groups.map(([title, items, grouped]) => {
      const filtered = items.filter(matches);
      found += filtered.length;
      const review = title === 'Needs source review';
      if (terms.length && !filtered.length && !(review && (reviewLoading || reviewError || reviewNeeded()))) return '';
      const empty = title === 'Recent receipts' ? 'No receipts in the returned history.' : 'No items in the received snapshot. Check host coverage above.';
      if (review) {
        // The withheld backlog is read fifty sources at a time from the server; the count reports
        // every matching source, loaded or not, and loaded pages are never sliced again here.
        const viewPart = filtered.filter(row => !row.paged), pagedPart = filtered.filter(row => row.paged);
        const count = viewPart.length + reviewCount();
        const visible = [...viewPart, ...pagedPart];
        reviewShown = count > 0;
        return '<section class="queue-section"><h2>' + title + '<span class="count">' + count + '</span></h2>' +
          (visible.length ? '<ul class="list">' + visible.map(queueRow).join('') + '</ul>' : '') +
          (reviewLoading ? '<p class="empty" role="status">Loading source reviews…</p>' : '') +
          (reviewError ? '<p class="empty">Source reviews unavailable: ' + escape(reviewError) + '</p><button type="button" data-retry-review="true">Retry source reviews</button>' : '') +
          (!visible.length && !reviewLoading && !reviewError ? '<p class="empty">' + empty + '</p>' : '') +
          (!reviewLoading && !reviewError && reviewHasMore() ? '<button type="button" data-more-review="true">Show next ' + Math.min(50, reviewTotal - reviewOffset) + ' source reviews · ' + reviewOffset + ' of ' + reviewTotal + ' loaded</button>' : '') + '</section>';
      }
      if (grouped) {
        const tickets = groupRowsByTicket(filtered);
        const counted = title === 'Needs your decision' ? summary.decisions : title === 'Personal actions' ? summary.actions : null;
        const label = counted === null ? tickets.length + ' tickets' : !countCurrent ?
          view.hosts.length ? '? · ' + counted + ' in last snapshot' : '? · not yet collected' :
          title === 'Needs your decision' && summary.unverified ? counted + ' verified · ' + summary.unverified + ' to verify' : String(counted);
        return '<section class="queue-section"><h2>' + title + '<span class="count">' + label +
          (terms.length ? ' · ' + filtered.length + ' matching sources' : '') + '</span></h2>' +
          (tickets.length ? '<ul class="list">' + tickets.map(group => groupRow(group, group.rows.some(row => (selectedKey && key(row) === selectedKey) || (focused && key(row) === focused)))).join('') + '</ul>' : '<p class="empty">' + empty + '</p>') + '</section>';
      }
      return '<section class="queue-section"><h2>' + title + '<span class="count">' + filtered.length + (terms.length ? ' of ' + items.length : '') + '</span></h2>' +
        (filtered.length ? '<ul class="list">' + filtered.map(queueRow).join('') + '</ul>' : '<p class="empty">' + empty + '</p>') + '</section>';
    }).join('') + (terms.length && !found && !reviewShown ? '<section class="queue-section"><p class="empty">No matching decisions or receipts. Try the ticket, host, title, or original source.</p></section>' : '');
    if (focused) [...queue.querySelectorAll('[data-key]')].find(element => element.dataset.key === focused)?.focus({preventScroll:true});
    coverage();
  }
  function draft(row) {
    const id = key(row);
    const source = fingerprint(row);
    if (!drafts.has(id) || drafts.get(id).source !== source) drafts.set(id, {source, questions:[], note:'', scope:'', boundaries:'', permission:null});
    return drafts.get(id);
  }
  function questionMarkup(question, index, value, allowCustom) {
    const name = 'question-' + index;
    const options = question.options.map((option, optionIndex) => {
      const checked = value.options.includes(optionIndex);
      return '<label class="option"><input type="' + (question.multiSelect ? 'checkbox' : 'radio') + '" name="' + name + '" data-question="' + index + '" data-option="' + optionIndex + '"' + (checked ? ' checked' : '') + '><span>' + escape(option.label) +
        (option.description ? '<span class="description">' + escape(option.description) + '</span>' : '') + '</span></label>';
    }).join('');
    const custom = allowCustom && question.options.length && !question.multiSelect ? '<label class="option"><input type="radio" name="' + name + '" data-question="' + index + '" data-custom="true"' + (value.custom ? ' checked' : '') + '><span>Write a different answer</span></label>' : '';
    const textLabel = !question.options.length ? 'Your answer' : question.multiSelect ? 'Additional answer (optional)' : 'Different answer (select above to send)';
    const text = !question.options.length || allowCustom ? '<label class="field-label" for="text-' + index + '">' + textLabel + '</label><textarea id="text-' + index + '" data-question="' + index + '" data-text="true" maxlength="4000">' + escape(value.text) + '</textarea>' : '';
    return '<fieldset><legend>' + escape(question.question) + (question.allowEmpty ? ' (optional)' : '') + '</legend>' + (question.multiSelect && question.options.length ? '<p class="help">Select every exact choice you want to send. Nothing is preselected.</p>' : '') + options + custom + text + '</fieldset>';
  }
  function receiptMarkup(receipt) {
    return '<b>' + escape(receipt.identifier + ' · ' + receipt.action) + '</b><p class="muted">' + escape(date(receipt.at)) + ' · delivery: ' + escape(receipt.delivery) + '</p><p class="pre">' + escape(receipt.text) + '</p>';
  }
  function renderReceipt(row) {
    const current = rows().find(item => item.host === row.host && item.target === 'owner' && item.data.issueId === row.data.issueId && item.revision === row.data.revision);
    pane.innerHTML = '<header class="detail-heading"><p class="muted">Receipt · ' + escape(row.host) + '</p><h2 tabindex="-1" id="detail-title">' + escape(row.data.identifier + ' · ' + row.data.action) + '</h2></header>' +
      '<section class="section">' + receiptMarkup(row.data) + '<p class="help">A delivery receipt records where the decision went. It does not confirm that downstream work is complete.</p>' +
      (current ? '<button type="button" data-current="' + escape(key(current)) + '">Open current ask</button>' : '<p class="help">No current canonical ask for this receipt is in the received snapshot. Historical revisions cannot be answered or reopened here.</p>') + '</section>';
  }
  function renderDetail() {
    if (!selected) {
      pane.innerHTML = '<div class="placeholder"><h2>Select a decision</h2><p>Read the original context, then choose an explicit answer or next step. Suggestions never send themselves.</p></div>';
      return;
    }
    if (selected.target === 'receipt') { renderReceipt(selected); return; }
    const row = selected, data = row.data, saved = draft(row);
    const permission = row.target === 'live' && data.kind === 'permission';
    const why = row.task?.reason || row.reason || (row.target === 'owner' ? data.attentionReason || 'No owner-attention reason was supplied.' : permission ? 'The agent is waiting for an explicit permission decision.' : 'The agent is waiting for your answer to its original questions.');
    // Receipts have issue IDs, not live request IDs. Never invent a live-request join.
    const history = receipts().filter(receipt => receipt.host === row.host && (row.target === 'live' || (receipt.data.issueId === data.issueId && receipt.data.revision === row.revision)));
    const links = safeLink(row.target === 'owner' ? data.url : data.issueUrl, 'Open Linear ticket') + (row.target === 'live' ? safeLink(data.agentUrl, 'Open agent') : '');
    let answer;
    if (permission) {
      answer = '<fieldset><legend>Original permission actions</legend><p class="help">Choose one original action. Research, delegation, and deferral do not grant or deny permission.</p>' +
        data.actions.map((action, index) => '<label class="option"><input type="radio" name="permission" data-permission="' + index + '"' + (saved.permission === index ? ' checked' : '') + '><span>' + escape(action.label) + '<span class="description">' + escape(action.behavior + ' · action ID: ' + action.id) + '</span></span></label>').join('') +
        (!data.actions.length ? '<p class="notice">No original permission actions were supplied. Open the agent to resolve this request.</p>' : '') + '</fieldset>';
    } else {
      answer = (row.target === 'live' ? '<p class="help">This answer applies to the current question only. In OMP selection flows, “Other” opens a text editor and “Done selecting” finishes; a new round appears after delivery.</p>' : '') +
        data.questions.map((question, index) => questionMarkup(question, index, saved.questions[index] || {options:[], custom:false, text:''}, row.target === 'owner')).join('');
      if (row.target === 'live' && !data.questions.length) answer += '<p class="help">This request has no required visible questions. Continue sends the empty follow-up without inventing an answer.</p>';
    }
    const noteLabel = permission ? 'Reason for denial (optional)' : 'Optional note';
    const manual = row.target === 'owner' && data.kind === 'manual';
    pane.innerHTML = '<header class="detail-heading"><p class="muted">' + escape([data.identifier, row.host, row.target === 'owner' ? data.ticketIdentifier : data.kind].filter(Boolean).join(' · ')) + '</p>' +
      '<h2 tabindex="-1" id="detail-title">' + escape(data.title) + '</h2><div class="links">' + links + '</div></header>' +
      '<div id="source-warning" class="notice" role="alert" hidden></div><div id="action-status" class="notice status" role="status" aria-live="polite" hidden></div>' +
      (row.target === 'owner' ? '<section class="section"><h3>Ask summary <span class="muted">' + (data.extracted ? '· generated' : '· unresolved extraction') + '</span></h3><p class="pre">' + escape(data.summary || 'No summary available. Read the original source below.') + '</p>' + (!data.extracted ? '<p class="help">Extraction is pending or failed. This source remains visible; read the original request before replying. No choices or authorization have been inferred.</p>' : '') + '<p class="help">The summary is not an approval or an answer. Your explicit choice is sent.</p></section>' : '') +
      '<p class="help">' + escape(why) + '</p><details class="section"><summary>Decision context</summary><dl class="context"><dt>Why it needs you</dt><dd>' + escape(why) + '</dd><dt>Wait / group</dt><dd>' + escape(state(row)) + '</dd>' +
      '<dt>Blocked work</dt><dd>' + escape(row.task?.blockedWork || 'No additional blocked-work evidence supplied.') + '</dd>' +
      '<dt>Owner last resort</dt><dd>Use scoped research or delegation when authority already exists. This list never invents authorization or accepts a recommendation for you.</dd>' +
      (row.target === 'owner' ? '<dt>Blocker</dt><dd>' + escape(data.blockerIdentifier || 'No blocker identified in this snapshot.') + '</dd><dt>Answer route</dt><dd>' + escape(data.route) + (data.agentId ? ' · agent ' + escape(data.agentId) : '') + '</dd>' : '<dt>Request</dt><dd>' + escape(data.requestId) + '</dd><dt>Agent</dt><dd>' + escape(data.agentId) + '</dd>') +
      (data.sourceId ? '<dt>Source</dt><dd>' + escape(data.sourceId === 'description' ? 'Issue description' : 'Comment ' + data.sourceId) + '</dd>' : '') +
      '<dt>Revision</dt><dd>' + escape(row.revision) + '</dd></dl></details>' +
      (row.task?.flow ? '<section class="section"><h3>Recovery evidence</h3>' + recoveryContext(row.task.flow) + '<p class="help">Queued recovery is waiting, not verified progress. This evidence never grants authority or creates an owner decision by itself.</p></section>' : '') +
      '<details class="section"' + (permission || !data.questions.length || (row.target === 'owner' && !data.extracted) ? ' open' : '') + '><summary>Original source</summary><pre class="pre">' + escape(data.source || 'No source text supplied.') + '</pre></details>' +
      '<form id="answer-form" class="form-section"><h3>' + (permission ? 'Permission decision' : 'Your answer') + '</h3>' + answer +
      (row.target === 'owner' && !data.questions.length ? '<label class="field-label" for="note">Your reply</label><textarea id="note" maxlength="4000">' + escape(saved.note) + '</textarea>' : row.target === 'owner' || permission ? '<label class="field-label" for="note">' + noteLabel + '</label><textarea id="note" maxlength="4000">' + escape(saved.note) + '</textarea>' : '') +
      '<p class="help">Nothing is preselected. Sending confirms delivery only, not completion of the work.</p><div class="actions"><button class="primary" type="submit"' + (permission && !data.actions.length ? ' disabled' : '') + '>' + (permission ? 'Send permission decision' : row.target === 'live' && !data.questions.length ? 'Continue current round' : 'Send answer') + '</button></div>' +
      (permission ? '<p class="help">A reason is sent with Deny only. Leave it empty when allowing the displayed action.</p>' : '') +
      (manual ? '<div class="manual"><b>Manual work completed?</b><p class="help">Use Done only after you have performed the requested work. This is separate from sending an answer and may close the Linear ask.</p><button type="button" data-operation="done">Done — I completed the manual work</button></div>' : '') + '</form>' +
      (!permission ? '<form id="scope-form" class="form-section"><h3>Research or delegate</h3><p class="help">Request scoped work, not approval. State the task and what must not change.</p>' +
      '<label class="field-label" for="scope">Scope / question to resolve</label><textarea id="scope" maxlength="3000">' + escape(saved.scope) + '</textarea>' +
      '<label class="field-label" for="boundaries">Boundaries / stop conditions</label><textarea id="boundaries" maxlength="1000">' + escape(saved.boundaries) + '</textarea>' +
      '<div class="actions"><button type="submit" data-triage="research">Request research</button><button type="submit" data-triage="delegate">Delegate scoped work</button></div></form>' : '') +
      '<section class="form-section"><h3>Timing</h3><p class="help">Defer pauses this decision; it does not answer or approve it. Tomorrow means 9:00 in this browser’s local time.</p><div class="actions"><button type="button" data-operation="hour">Defer 1 hour</button><button type="button" data-operation="tomorrow">Defer until tomorrow</button>' +
      (data.disposition || data.deferredUntil ? '<button type="button" data-operation="reopen">Reopen decision</button>' : '') + '</div></section>' +
      '<section class="section"><h3>' + (row.target === 'live' ? 'Host history' : 'History') + '</h3>' +
      (row.target === 'live' ? '<p class="help">Receipts from this host may belong to other decisions. This history does not associate receipts with live request IDs.</p>' : '') +
      (history.length ? '<ul class="history">' + history.map(receipt => '<li>' + receiptMarkup(receipt.data) + '</li>').join('') + '</ul>' : '<p class="muted">No receipts in the returned history for this scope. All received receipts are available in the queue.</p>') + '</section>';
    updateSafety();
  }
  function captureDraft() {
    if (!selected || stale || selected.target === 'receipt' || !document.getElementById('answer-form')) return;
    const saved = draft(selected);
    saved.note = document.getElementById('note')?.value || '';
    saved.scope = document.getElementById('scope')?.value || '';
    saved.boundaries = document.getElementById('boundaries')?.value || '';
    saved.questions = selected.data.questions.map((question, index) => {
      const controls = [...pane.querySelectorAll('[data-question="' + index + '"]')];
      return {options:controls.filter(element => element.dataset.option !== undefined && element.checked).map(element => Number(element.dataset.option)), custom:controls.some(element => element.dataset.custom && element.checked), text:controls.find(element => element.dataset.text)?.value || ''};
    });
    const choice = pane.querySelector('[data-permission]:checked');
    saved.permission = choice ? Number(choice.dataset.permission) : null;
  }
  function showStatus(message, type = 'error') {
    const element = document.getElementById('action-status');
    if (!element) return;
    element.textContent = message;
    element.className = 'notice status ' + type;
    element.setAttribute('role', type === 'error' ? 'alert' : 'status');
    element.hidden = false;
  }
  function updateSafety() {
    if (!selected || selected.target === 'receipt') return;
    const id = key(selected), problem = hostProblem(selected);
    const warning = document.getElementById('source-warning');
    if (!warning) return;
    warning.hidden = completed.has(id) || (!stale && !problem);
    const nextRounds = stale && selected.target === 'live' ? rows().filter(row => row.target === 'live' && row.host === selected.host && row.data.agentId === selected.data.agentId && identity(row) !== identity(selected)) : [];
    warning.innerHTML = stale ? '<b>Source changed or the current round ended.</b><p>Your previous draft has not been applied to another request or revision. Review and reselect the current source before sending.</p><button type="button" data-reselect="true">Review current source</button>' +
      nextRounds.map(row => '<button type="button" data-current="' + escape(key(row)) + '">Review live request: ' + escape(row.data.title) + '</button>').join('') : escape(problem);
    const blocked = stale || !!problem || busy || completed.has(id) || uncertain.has(id) || unavailable();
    for (const element of pane.querySelectorAll('form input, form textarea, form button, [data-operation]')) {
      element.disabled = blocked || (element.type === 'submit' && selected.data.kind === 'permission' && !selected.data.actions.length);
    }
    detail.setAttribute('aria-busy', String(busy));
    if (results.has(id)) showStatus(results.get(id).message, results.get(id).type);
  }
  function select(row, focus = true) {
    captureDraft();
    if (selected && identity(row) === identity(selected) && (stale || fingerprint(row) !== selectedSnapshot)) drafts.delete(key(row));
    selected = row;
    selectedSnapshot = fingerprint(row);
    stale = false;
    shell.classList.add('detail-open');
    detail.classList.add('show');
    renderQueue();
    renderDetail();
    detail.scrollTop = 0;
    if (focus) document.getElementById('detail-title')?.focus({preventScroll:true});
  }
  function refreshSelection() {
    if (!selected || selected.target === 'receipt') return;
    const current = rows().find(row => identity(row) === identity(selected));
    if (!current || fingerprint(current) !== selectedSnapshot) {
      captureDraft();
      stale = true;
      // A same-revision source change is invalid too: never restore that old draft.
      if (current && key(current) === key(selected)) drafts.delete(key(current));
    } else if (!stale) selected = current;
    updateSafety();
  }
  // The page's own availability check (every 5 seconds, and on focus/pageshow), separate from the
  // 30-second data refresh: a failed check disables every send control at once, and a recovered
  // one fetches the current snapshot before anything can be sent.
  async function checkAvailability() {
    const wasUnavailable = unavailable();
    const previousInstance = availability ? availability.displayedInstanceId : null;
    let next = null;
    try {
      const response = await fetch('/api/inbox/availability', {cache:'no-store', headers:{accept:'application/json'}});
      const answer = await response.json();
      if (!response.ok || !answer || typeof answer !== 'object' || typeof answer.backendState !== 'string') throw new Error('The backend availability check failed (' + response.status + ').');
      next = answer;
    } catch (error) {
      availabilityError = error instanceof Error ? error.message : 'The backend availability check failed.';
    }
    if (!next || next.stale || next.readOnly || next.backendState !== 'ready') {
      if (next) availabilityError = next.reason || 'The inbox backend is not ready.';
      recoveryPending = true;
      coverage(); updateSafety();
      return;
    }
    const instanceChanged = previousInstance !== (next.displayedInstanceId || null);
    if (wasUnavailable || unavailable() || instanceChanged) {
      // Close before clearing the probe error or awaiting refresh, including when another refresh
      // or a send is already busy. Only the replacement snapshot may clear this latch.
      recoveryPending = true;
      availabilityError = '';
      coverage(); updateSafety();
      await refresh();
      return;
    }
    coverage(); updateSafety();
  }
  async function refresh() {
    if (refreshing || busy) return false;
    refreshing = true;
    let replaced = false;
    coverage();
    try {
      const response = await fetch('/api/decisions', {cache:'no-store', headers:{accept:'application/json'}});
      const next = await response.json();
      if (!response.ok) throw new Error(typeof next.error === 'string' ? next.error : 'Decision refresh failed (' + response.status + ').');
      if (!Array.isArray(next.hosts) || !Array.isArray(next.unreachable) || !(typeof next.canonicalHost === 'string' || next.canonicalHost === null)) throw new Error('The decision snapshot is unavailable.');
      const previousInstance = availability ? availability.displayedInstanceId : null;
      // Use only the envelope received with these displayed decisions, never the probe's epoch.
      availability = next.availability && typeof next.availability === 'object' ? next.availability : null;
      recoveryPending = !availability || availability.stale || availability.readOnly || availability.backendState !== 'ready';
      availabilityError = '';
      if (previousInstance && previousInstance !== (availability ? availability.displayedInstanceId : null)) {
        captureDraft();
        selectedSnapshot = null;
      }
      view = next;
      refreshError = '';
      lastUpdated = Date.now();
      replaced = true;
    } catch (error) {
      refreshError = error instanceof Error ? error.message : 'Decision refresh failed.';
    } finally {
      refreshing = false;
      renderQueue();
      refreshSelection();
    }
    // Page 1 restarts at 0 only when the withheld set may have changed (a new owner collection), or
    // when the last page read failed; otherwise the loaded pages stay.
    if (replaced && (reviewError || reviewTotal === null || reviewSource !== withheldSource())) void loadReviews(false);
    // A new steward pass or a different ticket total invalidates that host's loaded evidence the
    // same way: a section that is open reads it again, a closed one reads on its next open.
    if (replaced) for (const hostName of [...flowSource.keys()]) {
      const host = view.hosts.find(item => item.host === hostName && item.flow);
      if (host && flowSource.get(hostName) === flowSignature(host.flow)) continue;
      flowSource.delete(hostName);
      flowTickets.delete(hostName);
      flowFailures.delete(hostName);
      if (flowOpen.has(hostName)) void loadFlow(hostName);
    }
    return replaced;
  }
  function baseAction(row, operation) {
    return {host:row.host, ...(row.backendInstanceId ? {backendInstanceId:row.backendInstanceId} : {}), target:row.target, operation, revision:row.revision, ...(row.target === 'owner' ? {issueId:row.data.issueId, ...(row.data.sourceId ? {sourceId:row.data.sourceId} : {})} : {agentId:row.data.agentId, requestId:row.data.requestId})};
  }
  function answers(row, saved) {
    const entries = row.data.questions.map((question, index) => {
      const value = saved.questions[index] || {options:[], custom:false, text:''};
      const selectedLabels = value.options.map(option => question.options[option].label);
      const text = value.text.trim();
      const answer = !question.options.length || value.custom ? text : question.multiSelect ? [...selectedLabels, ...(text ? [text] : [])].join(', ') : selectedLabels[0] || '';
      return [question.key, answer];
    });
    const missing = entries.find(([key, answer]) => !answer && !row.data.questions.find(question => question.key === key)?.allowEmpty);
    if (missing) {
      const index = row.data.questions.findIndex(question => question.key === missing[0]);
      pane.querySelector('[data-question="' + index + '"]')?.focus();
      throw new Error('Choose an explicit option or write an answer for every question.');
    }
    return Object.fromEntries(entries);
  }
  async function send(action, row) {
    const id = key(row);
    if (busy || stale || hostProblem(row) || completed.has(id) || uncertain.has(id)) return;
    if (unavailable()) { showStatus(availabilityReason() + ' Nothing was sent.'); return; }
    busy = true;
    results.delete(id);
    showStatus('Sending once… Waiting for a delivery receipt.', '');
    updateSafety();
    let requestStarted = false;
    try {
      requestStarted = true;
      const response = await fetch('/api/decisions/action', {method:'POST', headers:{'content-type':'application/json', 'x-review-action':'1', ...(availability && availability.displayedInstanceId ? { "x-paseo-inbox-displayed": availability.displayedInstanceId } : {}), accept:'application/json'}, body:JSON.stringify(action)});
      const result = await response.json();
      if (!response.ok) {
        if (typeof result.error !== 'string') throw new Error('The server did not return a delivery receipt.');
        if (result.outcomeUnknown === true) uncertain.add(id);
        results.set(id, {type:'error', message:result.error + ' No automatic retry was made. Check the source and history before sending again.'});
      } else {
        if (typeof result.message !== 'string' || typeof result.delivered !== 'string' || !result.delivered) throw new Error('The server did not return a delivery receipt.');
        if (result.delivered === 'unconfirmed') throw new Error('The server reports unconfirmed delivery.');
        results.set(id, {type:'success', message:'Delivery confirmed · ' + result.delivered + '. ' + result.message + ' This confirms delivery, not completion of downstream work.'});
        if (action.operation === 'answer') completed.add(id);
      }
    } catch (error) {
      if (requestStarted) uncertain.add(id);
      results.set(id, {type:'error', message:'Delivery unconfirmed. ' + (error instanceof Error ? error.message : 'Connection interrupted.') + ' Nothing was retried. Check recent receipts and the original ticket or agent before reloading to send again.'});
    } finally {
      busy = false;
      updateSafety();
      await refresh();
      // The action changed the withheld set whether or not the view snapshot followed it yet:
      // restart the pages unless the refresh already did.
      if (!reviewLoading) void loadReviews(false);
    }
  }
  function answerAction(done = false) {
    const row = selected;
    captureDraft();
    const saved = draft(row);
    const action = {...baseAction(row, 'answer'), note:saved.note.trim()};
    if (row.target === 'live' && row.data.kind === 'permission') {
      const choice = saved.permission === null ? null : row.data.actions[saved.permission];
      if (!choice) throw new Error('Choose an original permission action before sending.');
      action.actionId = choice.id;
      action.behavior = choice.behavior;
    } else {
      action.answers = done ? {} : answers(row, saved);
      if (!done && row.target === 'owner' && !row.data.questions.length && !action.note) throw new Error('Write your reply before sending.');
      if (done) action.done = true;
    }
    return send(action, row);
  }
  queue.addEventListener('click', event => {
    if (event.target.closest('[data-more-review]')) {
      void loadReviews(true).then(refocusReview);
      return;
    }
    if (event.target.closest('[data-retry-review]')) {
      void loadReviews(reviewErrorAppend).then(refocusReview);
      return;
    }
    const button = event.target.closest('[data-key]');
    if (!button || busy) return;
    const row = [...rows(), ...receipts()].find(item => key(item) === button.dataset.key);
    if (row) select(row);
  });
  // Recovery evidence is read from the owning host when its section is opened, never on a routine
  // refresh: the toggle of a section (also fired for a section rendered open) and the retry of a
  // failed read are the only triggers, and loadFlow itself ignores both when nothing is missing.
  const coverageElement = document.getElementById('coverage');
  coverageElement.addEventListener('toggle', event => {
    const details = event.target.closest('details[data-flow]');
    if (!details) return;
    if (details.open) { flowOpen.add(details.dataset.flow); void loadFlow(details.dataset.flow); }
    else flowOpen.delete(details.dataset.flow);
  }, true);
  coverageElement.addEventListener('click', event => {
    const retry = event.target.closest('[data-retry-flow]');
    if (retry) void loadFlow(retry.dataset.retryFlow);
  });
  pane.addEventListener('input', captureDraft);
  pane.addEventListener('change', captureDraft);
  pane.addEventListener('submit', event => {
    event.preventDefault();
    if (!selected || busy || stale || hostProblem(selected)) return;
    try {
      if (event.target.id === 'answer-form') { void answerAction(); return; }
      captureDraft();
      const saved = draft(selected), action = event.submitter?.dataset.triage;
      if (action !== 'research' && action !== 'delegate') return;
      if (!saved.scope.trim() || !saved.boundaries.trim()) throw new Error('Provide both the scope and boundaries before requesting research or delegation.');
      const note = 'Scope:\n' + saved.scope.trim() + '\n\nBoundaries / stop conditions:\n' + saved.boundaries.trim();
      if (note.length > 4000) throw new Error('Shorten the scope and boundaries to fit within 4,000 characters together.');
      void send({...baseAction(selected, 'triage'), action, note}, selected);
    } catch (error) { showStatus(error.message); }
  });
  pane.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.dataset.current) {
      const row = rows().find(item => key(item) === button.dataset.current);
      if (row) select(row);
      return;
    }
    if (button.dataset.reselect) {
      const row = rows().find(item => identity(item) === identity(selected));
      if (row) select(row);
      else showStatus('This decision is no longer in the received snapshot. Check host coverage, receipts, and the original source; no action has been sent.');
      return;
    }
    const operation = button.dataset.operation;
    if (!operation || !selected || stale || hostProblem(selected)) return;
    try {
      if (operation === 'done') { void answerAction(true); return; }
      const until = new Date();
      if (operation === 'hour') until.setTime(until.getTime() + 60 * 60 * 1000);
      else if (operation === 'tomorrow') { until.setDate(until.getDate() + 1); until.setHours(9, 0, 0, 0); }
      const action = operation === 'reopen' ? 'reopen' : 'defer';
      void send({...baseAction(selected, 'triage'), action, ...(action === 'defer' ? {until:until.toISOString()} : {})}, selected);
    } catch (error) { showStatus(error.message); }
  });
  document.getElementById('back').addEventListener('click', () => {
    if (busy) return;
    captureDraft();
    shell.classList.remove('detail-open');
    detail.classList.remove('show');
    const button = [...queue.querySelectorAll('[data-key]')].find(element => selected && element.dataset.key === key(selected));
    (button || search).focus({preventScroll:true});
  });
  search.addEventListener('input', () => { renderQueue(); scheduleReviews(); });
  document.getElementById('refresh').addEventListener('click', () => { void refresh(); });
  addEventListener('focus', () => { void checkAvailability(); void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void checkAvailability(); void refresh(); } });
  addEventListener('pageshow', event => { void checkAvailability(); if (event.persisted) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
  setInterval(() => { if (!document.hidden) void checkAvailability(); }, 5000);
  renderQueue();
  renderDetail();
  void loadReviews(false);
})();
`;

/** Self-contained browser inbox. No client dependency, navigation, or menu-bar changes. The
 * `availability` envelope (inbox-transport.ts) says whether the persistent frontdoor's snapshot is
 * current: while it is stale, read-only or the backend is not ready, the page disables every send
 * control, and a snapshot that only returned cached data never counts as a refresh. */
export function decisionPage(view: DecisionView, availability?: InboxAvailability): string {
  // JSON sits in a raw-text element: prevent closing it or introducing JS separators.
  const data = JSON.stringify({ ...view, ...(availability ? { availability } : {}) }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Decision inbox</title><style>${STYLE}</style></head>
<body><a class="skip" href="#detail">Skip to selected decision</a>
<section id="merge-status" class="merge-status" aria-labelledby="merge-status-title" role="region" aria-live="polite"><h2 id="merge-status-title">Checking merge status…</h2></section>
<div class="shell"><aside class="queue" aria-label="Decision queue">
<header class="queue-header"><div class="top"><h1>Decision tasks</h1><button id="refresh" type="button">Check updates</button></div><p id="refresh-state" class="muted" role="status" aria-live="polite"></p><p class="muted">Original choices, explicit answers. Research or delegate first when it is already within scope.</p><label class="search" for="search">Search decisions &amp; history</label><input id="search" type="search" maxlength="200" placeholder="Ticket, title, host, or source" autocomplete="off"></header>
<div id="coverage" class="coverage" role="status" aria-live="polite"></div><div id="queue-list"></div>
</aside><main id="detail" class="detail" tabindex="-1" aria-label="Selected decision"><div class="detail-inner"><nav class="detail-nav" aria-label="Inbox navigation"><button id="back" class="back" type="button">Back to decisions</button><a href="/">Plan review inbox</a></nav><div id="detail-content"></div></div></main></div>
<noscript><p class="coverage warning">JavaScript is required to load decisions and send explicit answers. No actions are sent without it.</p></noscript>
<script type="application/json" id="decision-data">${data}</script><script>${CLIENT}</script></body></html>`;
}
