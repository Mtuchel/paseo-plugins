import type { InboxAvailability } from "./inbox-transport";
import type { DecisionView } from "../shared/decision-inbox";

// Scoped extension of the review inbox: Apple system light/dark, Operate mode.
// The browser owns transient drafts only; the API owns revisions and delivery receipts.
const STYLE = `
:root{color-scheme:light dark;--bg:#f2f2f7;--card:#fff;--fg:#1c1c1e;--sub:#3c3c43;--muted:#6e6e73;--line:#d8d8dd;--press:#ebebf0;--tint:#0a64d6;--chip:#ececf1;--ok:#1b7a3d;--ok-bg:#dcf5e3;--warn:#8a5a00;--warn-bg:#fdefd0;--bad:#b3261e;--bad-bg:#fde4e1}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f2f2f7;--sub:#d1d1d6;--muted:#98989f;--line:#38383a;--press:#2c2c2e;--tint:#5aa9ff;--chip:#2c2c2e;--ok:#8fe0a8;--ok-bg:#123d22;--warn:#ffd27a;--warn-bg:#4a3500;--bad:#ff9f97;--bad-bg:#4d1512}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scrollbar-color:var(--line) var(--bg)}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-variant-numeric:tabular-nums}::selection{background:color-mix(in srgb,var(--tint) 28%,transparent)}a{color:var(--tint);text-underline-offset:3px}button,input,textarea{font:inherit;caret-color:var(--tint)}button{min-height:44px;padding:9px 14px;border:0;border-radius:10px;background:var(--chip);color:var(--fg);font-size:.875rem;font-weight:600;cursor:pointer}button:hover:not(:disabled){background:var(--press)}button:active:not(:disabled){filter:brightness(.92)}button.primary{background:var(--tint);color:#fff}button.primary:hover:not(:disabled){filter:brightness(.9);background:var(--tint)}button:disabled{opacity:.5;cursor:default}button,a,input,textarea,summary{touch-action:manipulation}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--tint);outline-offset:3px}input:not([type=radio]):not([type=checkbox]),textarea{display:block;width:100%;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);font-size:.9375rem}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}textarea{resize:vertical;min-height:96px}input[type=radio],input[type=checkbox]{width:18px;height:18px;accent-color:var(--tint);flex:none;margin:3px 0 0}h1,h2,h3,p{overflow-wrap:anywhere}h1{font-size:1.75rem;line-height:1.15;letter-spacing:-.02em;margin:0}h2{font-size:1.375rem;line-height:1.3;letter-spacing:-.01em;margin:0}h3{font-size:1.0625rem;margin:24px 0 8px}p{margin:8px 0 0}.muted{color:var(--muted);font-size:.875rem}.pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0;color:var(--sub)}.skip{position:fixed;left:12px;top:-80px;z-index:5;background:var(--card);padding:12px}.skip:focus{top:12px}[hidden]{display:none!important}
.shell{max-width:1440px;margin:auto;display:grid;grid-template-columns:minmax(300px,390px) minmax(0,1fr);min-height:100dvh}.queue{min-width:0;border-right:1px solid var(--line)}.queue-header{padding:24px 20px 18px}.queue-header .top{display:flex;gap:10px;align-items:center;justify-content:space-between}.search{display:block;margin:20px 0 6px;font-size:.875rem;font-weight:600}.queue-header input{background:var(--card)!important}.coverage{margin:0 16px 16px;padding:12px 14px;border-radius:12px;background:var(--chip);font-size:.875rem;color:var(--sub);overflow-wrap:anywhere}.coverage.warning{color:var(--warn);background:var(--warn-bg)}.coverage p{margin:4px 0 0}.queue-section{margin:24px 16px}.queue-section h2{font-size:1.0625rem;margin:0 4px 8px;display:flex;justify-content:space-between;gap:8px}.count{font-size:.875rem;font-weight:500;color:var(--muted)}.list{list-style:none;margin:0;padding:0;background:var(--card);border-radius:14px;overflow:hidden}.list li+li{border-top:1px solid var(--line)}.row{display:block;text-align:left;width:100%;padding:14px 16px;border-radius:0;background:transparent;font-weight:400;overflow-wrap:anywhere}.row[aria-current=true]{background:color-mix(in srgb,var(--tint) 12%,var(--card))}.row .title{display:block;font-size:.9375rem;font-weight:600;line-height:1.35;margin:4px 0}.row .meta{display:block;font-size:.75rem;color:var(--muted)}.row .summary{display:block;font-size:.8125rem;color:var(--sub);margin-top:5px}.row .state{display:block;margin-top:6px;font-size:.75rem;color:var(--warn)}.empty{padding:18px 16px;background:var(--card);border-radius:14px;font-size:.875rem;color:var(--muted)}
.detail{min-width:0;background:var(--card);padding:24px 32px 64px}.detail-inner{max-width:74ch;margin:0 auto}.detail-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:24px}.detail-nav a{font-size:.875rem}.back{display:none}.placeholder{padding:48px 0;color:var(--muted)}.placeholder h2{color:var(--fg)}.detail-heading{margin-bottom:24px}.detail-heading .muted{margin-bottom:6px}.links{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:14px;font-size:.875rem}.section{padding:24px 0;border-top:1px solid var(--line)}.section h3{margin:0 0 10px}.context{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:8px 16px;margin:0;font-size:.9375rem}.context dt{color:var(--muted)}.context dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:14px 16px;border-radius:12px;background:var(--warn-bg);color:var(--warn);font-size:.9375rem;margin-bottom:20px;overflow-wrap:anywhere}.notice button{margin-top:12px}.notice.error{color:var(--bad);background:var(--bad-bg)}.notice.success{color:var(--ok);background:var(--ok-bg)}.notice:empty{display:none}.status{margin:0 0 20px}.form-section{padding:24px 0;border-top:1px solid var(--line)}fieldset{min-width:0;border:0;padding:0;margin:0 0 24px}legend{font-weight:600;font-size:1rem;margin-bottom:12px;padding:0;overflow-wrap:anywhere;width:100%}.option{display:flex;gap:10px;padding:12px;margin:6px 0;border:1px solid var(--line);border-radius:10px;cursor:pointer;overflow-wrap:anywhere}.option:has(input:checked){border-color:var(--tint);background:color-mix(in srgb,var(--tint) 8%,var(--card))}.option .description{display:block;color:var(--sub);font-size:.875rem;margin-top:3px}.field-label{display:block;font-size:.9375rem;font-weight:600;margin:16px 0 6px}.help{font-size:.875rem;color:var(--muted);margin:8px 0 12px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}.actions button{max-width:100%;overflow-wrap:anywhere}.manual{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}.manual button{margin-top:12px}.form-section h3{margin:0 0 8px}.history{list-style:none;padding:0;margin:0}.history li{padding:16px 0;border-top:1px solid var(--line)}.history b{font-size:.9375rem}.history .pre{margin-top:8px;font-size:.9375rem}summary{cursor:pointer;font-weight:600;min-height:44px;padding:10px 0}details .pre{padding:12px 0}#refresh-state{min-height:1.3em}.global-status{margin:0 16px 16px;font-size:.875rem;color:var(--bad);overflow-wrap:anywhere}
@media(min-width:900px){.shell{height:100vh;height:100dvh;overflow:hidden}.queue,.detail{overflow-y:auto;overscroll-behavior:contain}}
@media(max-width:899px){.shell{display:block;min-height:100dvh}.queue{border-right:0}.detail{padding:20px max(18px,env(safe-area-inset-right)) 48px max(18px,env(safe-area-inset-left));min-height:100dvh}.detail:not(.show){display:none}.shell.detail-open .queue{display:none}.back{display:inline-block}.queue-header{padding-top:calc(20px + env(safe-area-inset-top))}.detail-nav{margin-bottom:20px}.context{grid-template-columns:1fr;gap:4px}.context dd{margin-bottom:10px}}
@media(prefers-reduced-motion:no-preference){.row{transition:background-color 160ms ease-out}.notice{animation:notice-in 180ms ease-out}@keyframes notice-in{from{background-color:var(--chip)}to{}}}
@media(prefers-color-scheme:dark){button.primary{color:#001b38}}
`;

const CLIENT = String.raw`
(() => {
  let view = JSON.parse(document.getElementById('decision-data').textContent);
  let availability = view.availability || null;
  let availabilityError = '', recoveryPending = false;
  let selected = null, selectedSnapshot = null, stale = false, busy = false, refreshing = false;
  let refreshError = '', lastUpdated = Date.now();
  const drafts = new Map(), results = new Map(), completed = new Set(), uncertain = new Set();
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
  function rows() {
    const items = [];
    for (const host of view.hosts) {
      if (host.host === view.canonicalHost) {
        for (const ask of host.asks) items.push({host:host.host, backendInstanceId:host.backendInstanceId, target:'owner', id:ask.issueId, revision:ask.revision, data:ask});
      }
      for (const live of host.live) items.push({host:host.host, backendInstanceId:host.backendInstanceId, target:'live', id:JSON.stringify([live.agentId, live.requestId]), revision:live.revision, data:live});
    }
    return items;
  }
  function receipts() {
    return view.hosts.flatMap(host => host.history.map(receipt => ({host:host.host, backendInstanceId:host.backendInstanceId, target:'receipt', id:receipt.id, revision:receipt.revision, data:receipt})))
      .sort((a, b) => Date.parse(b.data.at) - Date.parse(a.data.at));
  }
  function other(row) {
    const data = row.data;
    const deferred = data.deferredUntil && Date.parse(data.deferredUntil) > Date.now();
    return row.target === 'owner' ? data.attention !== 'owner' || (data.disposition && data.disposition !== 'deferred') || deferred : deferred;
  }
  function state(row) {
    const data = row.data;
    if (row.target === 'receipt') return data.action + ' · delivery: ' + data.delivery;
    if (data.deferredUntil && Date.parse(data.deferredUntil) > Date.now()) return 'Deferred until ' + date(data.deferredUntil);
    if (row.target === 'live') return data.kind === 'permission' ? 'Permission · choose an original action' : 'Live question';
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
    if (!host || view.unreachable.includes(row.host)) return 'This host is unavailable. Its displayed source may be stale; actions are paused.';
    if (row.target === 'owner' && row.host !== view.canonicalHost) return 'The canonical owner-ask host changed. Select the current canonical ask before acting.';
    return '';
  }
  function coverage() {
    const warnings = [];
    if (unavailable()) warnings.push(availabilityReason());
    if (!view.canonicalHost) warnings.push('Canonical Linear owner-ask host unavailable. Owner asks are not shown.');
    else if (!view.hosts.some(host => host.host === view.canonicalHost)) warnings.push('Canonical Linear owner-ask host ' + view.canonicalHost + ' is missing.');
    for (const host of view.unreachable) warnings.push(host + ' unavailable; its decisions may be missing.');
    for (const host of view.hosts) if (host.error) warnings.push(host.host + ' partial or unavailable: ' + host.error);
    if (!view.hosts.length) warnings.push('No hosts returned a decision snapshot. This is not an empty inbox.');
    if (refreshError) warnings.push(refreshError + ' Displayed decisions are the last received snapshot.');
    const element = document.getElementById('coverage');
    element.classList.toggle('warning', warnings.length > 0);
    element.innerHTML = warnings.length ? '<b>Incomplete coverage</b>' + warnings.map(text => '<p>' + escape(text) + '</p>').join('') :
      '<b>Connected hosts</b><p>' + view.hosts.map(host => escape(host.host)).join(' · ') + '</p><p>Linear owner asks: ' + escape(view.canonicalHost) + '</p>';
    document.getElementById('refresh-state').textContent = refreshing ? 'Refreshing…' : unavailable() ? 'Read-only — the checked backend is not reachable' : 'Updated ' + date(availability.lastCheckedAt || new Date(lastUpdated).toISOString()) + ' · refreshes every 30 seconds';
  }
  function queueRow(row) {
    const data = row.data;
    const title = row.target === 'receipt' ? data.identifier + ' · ' + data.action : data.title;
    const meta = [data.identifier, row.host, row.target === 'owner' ? data.ticketIdentifier : ''].filter(Boolean).join(' · ');
    return '<li><button type="button" class="row" data-key="' + escape(key(row)) + '" aria-current="' + (selected && key(selected) === key(row) ? 'true' : 'false') + '">' +
      '<span class="meta">' + escape(meta) + '</span><span class="title">' + escape(title) + '</span>' +
      (data.summary ? '<span class="summary">' + escape(data.summary) + '</span>' : '') +
      '<span class="state">' + escape(state(row)) + '</span></button></li>';
  }
  function renderQueue() {
    const focused = queue.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = row => terms.every(term => JSON.stringify([row.host, row.data]).toLocaleLowerCase().includes(term));
    const all = rows();
    const groups = [
      ['Owner decisions', all.filter(row => row.target === 'owner' && !other(row))],
      ['Live questions & permissions', all.filter(row => row.target === 'live' && !other(row))],
      ['Other waits', all.filter(other)],
      ['Recent receipts', receipts()]
    ];
    let found = 0;
    queue.innerHTML = groups.map(([title, items]) => {
      const filtered = items.filter(matches);
      found += filtered.length;
      if (terms.length && !filtered.length) return '';
      const empty = title === 'Recent receipts' ? 'No receipts in the returned history.' : 'No items in the received snapshot. Check host coverage above.';
      return '<section class="queue-section"><h2>' + title + '<span class="count">' + filtered.length + (terms.length ? ' of ' + items.length : '') + '</span></h2>' +
        (filtered.length ? '<ul class="list">' + filtered.map(queueRow).join('') + '</ul>' : '<p class="empty">' + empty + '</p>') + '</section>';
    }).join('') + (terms.length && !found ? '<section class="queue-section"><p class="empty">No matching decisions or receipts. Try the ticket, host, title, or original source.</p></section>' : '');
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
    const current = rows().find(item => item.host === row.host && item.target === 'owner' && item.id === row.data.issueId);
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
    const why = row.target === 'owner' ? data.attentionReason || 'No owner-attention reason was supplied.' : permission ? 'The agent is waiting for an explicit permission decision.' : 'The agent is waiting for your answer to its original questions.';
    // Receipts have issue IDs, not live request IDs. Never invent a live-request join.
    const history = receipts().filter(receipt => receipt.host === row.host && (row.target === 'live' || receipt.data.issueId === row.id));
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
      (row.target === 'owner' ? '<section class="section"><h3>Ask summary <span class="muted">' + (data.extracted ? '· generated' : '· extraction pending') + '</span></h3><p class="pre">' + escape(data.summary || 'No summary available. Read the original source below.') + '</p><p class="help">The summary is not an approval or an answer. Your explicit choice is sent.</p></section>' : '') +
      '<section class="section"><h3>Decision context</h3><dl class="context"><dt>Why it needs you</dt><dd>' + escape(why) + '</dd><dt>Wait / group</dt><dd>' + escape(state(row)) + '</dd>' +
      (row.target === 'owner' ? '<dt>Blocker</dt><dd>' + escape(data.blockerIdentifier || 'No blocker identified in this snapshot.') + '</dd><dt>Answer route</dt><dd>' + escape(data.route) + (data.agentId ? ' · agent ' + escape(data.agentId) : '') + '</dd>' : '<dt>Request</dt><dd>' + escape(data.requestId) + '</dd><dt>Agent</dt><dd>' + escape(data.agentId) + '</dd>') +
      '<dt>Revision</dt><dd>' + escape(row.revision) + '</dd></dl></section>' +
      '<section class="section"><h3>Original source</h3><pre class="pre">' + escape(data.source || 'No source text supplied.') + '</pre></section>' +
      '<form id="answer-form" class="form-section"><h3>' + (permission ? 'Permission decision' : 'Your answer') + '</h3>' + answer +
      (row.target === 'owner' && !data.questions.length ? '<label class="field-label" for="note">Your reply</label><textarea id="note" maxlength="4000">' + escape(saved.note) + '</textarea>' : row.target === 'owner' || permission ? '<label class="field-label" for="note">' + noteLabel + '</label><textarea id="note" maxlength="4000">' + escape(saved.note) + '</textarea>' : '') +
      '<p class="help">Nothing is preselected. Sending confirms delivery only, not completion of the work.</p><div class="actions"><button class="primary" type="submit"' + (permission && !data.actions.length ? ' disabled' : '') + '>' + (permission ? 'Send permission decision' : row.target === 'live' && !data.questions.length ? 'Continue current round' : 'Send answer') + '</button></div>' +
      (permission ? '<p class="help">A reason is sent with Deny only. Leave it empty when allowing the displayed action.</p>' : '') +
      (manual ? '<div class="manual"><b>Manual work completed?</b><p class="help">Use Done only after you have performed the requested work. This is separate from sending an answer and may close the Linear ask.</p><button type="button" data-operation="done">Done — I completed the manual work</button></div>' : '') + '</form>' +
      (!permission ? '<form id="scope-form" class="form-section"><h3>Research or delegate</h3><p class="help">Request scoped work, not approval. State the task and what must not change.</p>' +
      '<label class="field-label" for="scope">Scope / question to resolve</label><textarea id="scope" maxlength="3000">' + escape(saved.scope) + '</textarea>' +
      '<label class="field-label" for="boundaries">Boundaries / stop conditions</label><textarea id="boundaries" maxlength="1000">' + escape(saved.boundaries) + '</textarea>' +
      '<div class="actions"><button type="submit" data-triage="research">Request research</button><button type="submit" data-triage="delegate">Delegate scoped work</button></div></form>' +
      '<section class="form-section"><h3>Timing</h3><p class="help">Defer pauses this decision; it does not answer or approve it. Tomorrow means 9:00 in this browser’s local time.</p><div class="actions"><button type="button" data-operation="hour">Defer 1 hour</button><button type="button" data-operation="tomorrow">Defer until tomorrow</button>' +
      (data.disposition || data.deferredUntil ? '<button type="button" data-operation="reopen">Reopen decision</button>' : '') + '</div></section>' : '') +
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
    warning.hidden = !stale && !problem;
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
    if (refreshing || busy) return;
    refreshing = true;
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
    } catch (error) {
      refreshError = error instanceof Error ? error.message : 'Decision refresh failed.';
    } finally {
      refreshing = false;
      renderQueue();
      refreshSelection();
    }
  }
  function baseAction(row, operation) {
    return {host:row.host, ...(row.backendInstanceId ? {backendInstanceId:row.backendInstanceId} : {}), target:row.target, operation, revision:row.revision, ...(row.target === 'owner' ? {issueId:row.id} : {agentId:row.data.agentId, requestId:row.data.requestId})};
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
    const button = event.target.closest('[data-key]');
    if (!button || busy) return;
    const row = [...rows(), ...receipts()].find(item => key(item) === button.dataset.key);
    if (row) select(row);
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
  search.addEventListener('input', renderQueue);
  document.getElementById('refresh').addEventListener('click', () => { void refresh(); });
  addEventListener('focus', () => { void checkAvailability(); void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void checkAvailability(); void refresh(); } });
  addEventListener('pageshow', event => { void checkAvailability(); if (event.persisted) void refresh(); });
  setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
  setInterval(() => { if (!document.hidden) void checkAvailability(); }, 5000);
  renderQueue();
  renderDetail();
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
<div class="shell"><aside class="queue" aria-label="Decision queue">
<header class="queue-header"><div class="top"><h1>Decision inbox</h1><button id="refresh" type="button">Refresh</button></div><p id="refresh-state" class="muted" role="status" aria-live="polite"></p><label class="search" for="search">Search decisions &amp; history</label><input id="search" type="search" placeholder="Ticket, title, host, or source" autocomplete="off"></header>
<div id="coverage" class="coverage" role="status" aria-live="polite"></div><div id="queue-list"></div>
</aside><main id="detail" class="detail" tabindex="-1" aria-label="Selected decision"><div class="detail-inner"><nav class="detail-nav" aria-label="Inbox navigation"><button id="back" class="back" type="button">Back to decisions</button><a href="/">Plan review inbox</a></nav><div id="detail-content"></div></div></main></div>
<noscript><p class="coverage warning">JavaScript is required to load decisions and send explicit answers. No actions are sent without it.</p></noscript>
<script type="application/json" id="decision-data">${data}</script><script>${CLIENT}</script></body></html>`;
}
