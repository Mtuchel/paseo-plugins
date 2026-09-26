import type { PaseoProject } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { branchesRpc, cachedOverviewRpc, connectRpc, countIssuesRpc, dispatchStatusRpc, agentStatusRpc, issueContextRpc, disconnectRpc, getDefaultPromptRpc, getSettingsRpc, listIssuesRpc, launchAgentRpc, searchIssuesRpc, setDefaultPromptRpc, setSettingsRpc, statusRpc, type DispatchSettingsValue, type DispatchStatus, type Issue, type RelatedTicket, type TicketDetail, type WritebackSettingsValue } from "../shared/contracts";
import { filterIssues, formatIssueDate, formatPriority, formatRelativeDate, hasPriority, issueStatus, statusChangesText, statusCounts, type DependencyFilter, type SortDirection, type SortField } from "./issue-list";

import { ChoicePicker } from "./choice-picker";
import { Icon, copyText } from "@getpaseo/plugin/client/react-native";
import { BrandMark, Button, Callout, Divider, EmptyState, FieldLabel, LabelChip, MetaItem, PriorityMark, ProviderMark, SectionHeading, Segmented, Skeleton, StatusBadge, StatusMark, SurfaceProvider } from "./ui";
import { tokensFor } from "./design";
import { openExternalUrl } from "./open-link";
import { MarkdownPreview } from "./markdown-preview";
import { restoreLaunchSelection, type LaunchPreference } from "./launch-preferences";
import { mappedBaseBranch, mappingKey, mappingLabel, resolveMapping, type MappingSource, type ProjectMapping } from "../shared/mapping";

const dispatchDraftFor = (value: DispatchSettingsValue) => ({ label: value.label, teamKeys: value.teamKeys.join(", "), intervalSeconds: String(value.intervalSeconds), maxRunning: String(value.maxRunning) });
const WRITEBACK_OPTIONS: { key: keyof WritebackSettingsValue; on: string; off: string }[] = [
  { key: "status", on: "Move the ticket to In Progress when its agent starts working", off: "Leave the ticket status alone when work starts" },
  { key: "summaries", on: "Comment each finished turn's reply on the ticket", off: "No turn summaries" },
  { key: "blocked", on: "Comment and label the ticket while its agent waits on you", off: "No blocked alerts" },
  { key: "pullRequests", on: "Attach pull requests the agent opens and move the ticket to review", off: "No pull request links" },
  { key: "autoResume", on: "Start a new agent automatically when one fails (at most once an hour per ticket)", off: "Offer Resume in Linear when an agent stops" },
  { key: "mentions", on: "Deliver your \"@paseo …\" comments to the ticket's agent", off: "Comments stay in Linear" },
];

type ThinkingOption = { id: string; label: string; description?: string; isDefault?: boolean };
type ModelChoice = { id: string; label: string; provider: string; description?: string; thinkingOptions: ThinkingOption[]; defaultThinkingOptionId?: string };
type ModeChoice = { id: string; label: string; description?: string; icon?: string };
type LinkedAgent = { id: string; title: string | null; status: string; updatedAt: string };

const CACHE_MAX_AGE_MS = 5 * 60_000;

function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
// Used only for request deduplication, never as a security token.
function requestId() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16);
}); }

export function LinearTicketsSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const getBranches = useRpc(branchesRpc);
  const getStatus = useRpc(statusRpc), connect = useRpc(connectRpc), disconnect = useRpc(disconnectRpc);
  const getIssues = useRpc(listIssuesRpc), getIssuesCount = useRpc(countIssuesRpc), getCachedOverview = useRpc(cachedOverviewRpc), getDetail = useRpc(issueContextRpc), start = useRpc(launchAgentRpc);
  const searchAll = useRpc(searchIssuesRpc);
  const getTemplate = useRpc(getDefaultPromptRpc), saveTemplate = useRpc(setDefaultPromptRpc);
  const getSettings = useRpc(getSettingsRpc), saveSettings = useRpc(setSettingsRpc);
  const getDispatchStatus = useRpc(dispatchStatusRpc), getAgentStatus = useRpc(agentStatusRpc);
  const [markInProgress, setMarkInProgress] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateText, setTemplateText] = useState("");
  const [templateSaved, setTemplateSaved] = useState<string | null>(null);
  const [builtinTemplate, setBuiltinTemplate] = useState("");
  const [connection, setConnection] = useState<{ connected: boolean; source: "none" | "saved" | "environment" } | null>(null);
  const [key, setKey] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ total: number; byName: Record<string, number>; byType: Record<string, number>; complete: boolean } | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Issue[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchVersion, setSearchVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [dependency, setDependency] = useState<DependencyFilter>("all");
  const [showClosed, setShowClosed] = useState(false);
  const [dateField, setDateField] = useState<SortField>("updatedAt");
  const [dateDirection, setDateDirection] = useState<SortDirection>("newest");
  const [view, setView] = useState<"list" | "settings">("list");
  const [manageConnection, setManageConnection] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [projects, setProjects] = useState<PaseoProject[]>([]);
  const [projectId, setProjectId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<{ id: string; label: string }[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [branchesFor, setBranchesFor] = useState<string | null>(null);
  // A ticket's branch request, applied once branches are loaded for the selected project.
  const [wantedBranch, setWantedBranch] = useState<{ branch?: string } | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchesVersion, setBranchesVersion] = useState(0);
  const [providerGroup, setProviderGroup] = useState("");
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modes, setModes] = useState<Record<string, ModeChoice[]>>({});
  const [provider, setProvider] = useState("");
  const [modeId, setModeId] = useState("");
  const [thinkingOptionId, setThinkingOptionId] = useState("");
  const [launchPreferences, setLaunchPreferences] = useState<Record<string, LaunchPreference>>({});
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [projectMappings, setProjectMappings] = useState<Record<string, ProjectMapping>>({});
  const [agentLinearAccess, setAgentLinearAccess] = useState(true);
  const [dispatch, setDispatch] = useState<DispatchSettingsValue | null>(null);
  const [dispatchDraft, setDispatchDraft] = useState({ label: "", teamKeys: "", intervalSeconds: "", maxRunning: "" });
  const [writeback, setWriteback] = useState<WritebackSettingsValue | null>(null);
  const [dispatchStatus, setDispatchStatus] = useState<DispatchStatus | null>(null);
  const [agentStatus, setAgentStatus] = useState<{ installed: boolean; funnel: boolean; funnelNote: string | null; lastWebhookAt: string | null } | null>(null);
  const [mappingReason, setMappingReason] = useState<"saved" | "name" | null>(null);
  // The ticket whose mapping was applied or overridden by hand; the branch waits for the list.
  const mappedFor = useRef<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [showRelatedTickets, setShowRelatedTickets] = useState(false);
  const [contextCopied, setContextCopied] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<{ agentId: string; warnings: string[] } | null>(null);
  const [linkedAgents, setLinkedAgents] = useState<LinkedAgent[]>([]);
  const [linkedAgentsLoading, setLinkedAgentsLoading] = useState(false);
  const launchRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const restoredLaunchPreference = useRef(false);
  const statusRef = useRef<string | null>(null);
  const dependencyRef = useRef<DependencyFilter>("all");

  const run = async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(null);
    try { await task(); } catch (error) { setError(message(error)); }
    finally { busyRef.current = false; setBusy(null); }
  };

  const loadIssues = useCallback(async (next?: string, filter?: { status: string | null; dependency?: DependencyFilter }) => {
    const f = filter ?? { status: statusRef.current, dependency: dependencyRef.current };
    const page = await getIssues({
      ...(next ? { cursor: next } : {}),
      ...(f.status ? { stateNames: [f.status] } : {}),
      ...(f.dependency && f.dependency !== "all" ? { relation: f.dependency } : {}),
    });
    if (next && page.nextCursor === next) throw new Error("Linear repeated a page. Refresh the ticket list to continue.");
    setIssues((previous) => [...new Map((next ? [...previous, ...page.issues] : page.issues).map((issue) => [issue.id, issue])).values()]);
    setCursor(page.nextCursor);
    if (!next && !f.status) setLastUpdatedAt(new Date().toISOString());
    return page.nextCursor;
  }, [getIssues]);

  const refreshCounts = useCallback(async () => {
    try { setCounts(await getIssuesCount({})); } catch { /* counts are non-critical; the list still loads without them */ }
  }, [getIssuesCount]);

  const loadAllIssues = async () => {
    let next = cursor;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new Error("Linear repeated a page. Refresh tickets to continue.");
      seen.add(next);
      next = await loadIssues(next);
    }
  };

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true); setOptionsError(null);
    try {
      const [spaces, choices] = await Promise.all([
        paseo.projects.list().then((result) => result.projects),
        (async () => {
          const available = await paseo.providers.listAvailable();
          if (available.error) throw new Error(available.error);
          const results = await Promise.allSettled(available.providers.filter((p) => p.available).map(async (p) => {
            const [modelResult, modeResult] = await Promise.allSettled([paseo.providers.listModels(p.provider), paseo.providers.listModes(p.provider)]);
            if (modelResult.status === "rejected") throw modelResult.reason;
            if (modelResult.value.error) throw new Error(modelResult.value.error);
            const models = (modelResult.value.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
              id: `${p.provider}/${model.id}`, label: model.label, provider: p.provider, description: model.description,
              thinkingOptions: model.thinkingOptions ?? [], defaultThinkingOptionId: model.defaultThinkingOptionId,
            }));
            if (modeResult.status === "rejected" || modeResult.value.error) return { provider: p.provider, models, modes: [] };
            return { provider: p.provider, models, modes: (modeResult.value.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label, description: mode.description, icon: mode.icon })) };
          }));
          const models = results.flatMap((result) => result.status === "fulfilled" ? result.value.models : []);
          const modes = Object.fromEntries(results.flatMap((result) => result.status === "fulfilled" ? [[result.value.provider, result.value.modes]] : []));
          if (results.some((result) => result.status === "rejected")) setOptionsError("Some agent models could not be loaded. Retry to refresh them.");
          return { models, modes };
        })(),
      ]);
      setProjects(spaces); setModels(choices.models); setModes(choices.modes);
      setProjectId((current) => spaces.some((p) => p.projectId === current) ? current : "");
      setProviderGroup((current) => choices.models.some((m) => m.provider === current) ? current : "");
      setProvider((current) => choices.models.some((m) => m.id === current) ? current : "");
    } catch (error) { setOptionsError(message(error)); }
    finally { setOptionsLoading(false); }
  }, [paseo]);

  useEffect(() => {
    void run("Loading connection", async () => {
      const status = await getStatus({}); setConnection(status);
      if (status.connected) {
        const cached = await getCachedOverview({}).catch(() => null);
        if (cached) {
          setIssues(cached.issues); setCursor(cached.nextCursor); setCounts(cached.counts ?? null); setLastUpdatedAt(cached.updatedAt);
        }
        const cachedTime = cached ? Date.parse(cached.updatedAt) : Number.NaN;
        if (!Number.isFinite(cachedTime) || Date.now() - cachedTime >= CACHE_MAX_AGE_MS) {
          await loadIssues(undefined, { status: null }); void refreshCounts();
        } else if (!cached?.counts) void refreshCounts();
      }
    });
    void loadOptions();
  }, [getStatus, getCachedOverview, loadIssues, loadOptions, refreshCounts]);

  useEffect(() => {
    void getTemplate({}).then((result) => {
      setBuiltinTemplate(result.builtin);
      setTemplateSaved(result.template);
      setTemplateText(result.template ?? result.builtin);
    }, () => { setTemplateOpen(false); });
  }, [getTemplate]);

  useEffect(() => {
    void getSettings({}).then((value) => {
      setMarkInProgress(value.markInProgress); setShowClosed(value.showClosed);
      setLaunchPreferences(value.launchPreferences); setLastProvider(value.lastProvider);
      setProjectMappings(value.projectMappings); setAgentLinearAccess(value.agentLinearAccess);
      setDispatch(value.dispatch); setDispatchDraft(dispatchDraftFor(value.dispatch)); setWriteback(value.writeback);
    }, () => {}).finally(() => setSettingsLoaded(true));
  }, [getSettings]);

  // The dispatcher runs on the host; this only mirrors its latest poll while the surface is open.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getDispatchStatus({}).then((value) => { if (!cancelled) setDispatchStatus(value); }, () => {});
      void getAgentStatus({}).then((value) => { if (!cancelled) setAgentStatus(value); }, () => {});
    };
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [getDispatchStatus, getAgentStatus]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null); setDetailError(null); setShowContext(false); setShowRelatedTickets(false); setContextCopied(false);
    if (!selected) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void getDetail({ id: selected.id }).then((value) => {
      if (!cancelled) setDetail(value);
    }, (error) => { if (!cancelled) setDetailError(message(error)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected, getDetail, detailVersion]);

  useEffect(() => {
    let cancelled = false;
    setLinkedAgents([]);
    if (!selected) { setLinkedAgentsLoading(false); return; }
    setLinkedAgentsLoading(true);
    void paseo.agents.list({
      filter: { labels: { "linear.issueId": selected.id }, includeArchived: false },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 20 },
    }).then((result) => {
      if (!cancelled) setLinkedAgents(result.entries.map(({ agent }) => ({ id: agent.id, title: agent.title, status: agent.status, updatedAt: agent.updatedAt })));
    }, () => { if (!cancelled) setLinkedAgents([]); })
      .finally(() => { if (!cancelled) setLinkedAgentsLoading(false); });
    return () => { cancelled = true; };
  }, [paseo, selected]);

  useEffect(() => {
    if (!selected) return;
    return paseo.agents.subscribe((update) => {
      if (update.kind === "remove") {
        setLinkedAgents((previous) => previous.filter((item) => item.id !== update.agentId));
        return;
      }
      const linkedIssueId = update.agent.labels?.["linear.issueId"];
      if (update.agent.archivedAt || linkedIssueId !== selected.id) {
        setLinkedAgents((previous) => previous.filter((item) => item.id !== update.agent.id));
        return;
      }
      const linked = { id: update.agent.id, title: update.agent.title, status: update.agent.status, updatedAt: update.agent.updatedAt };
      setLinkedAgents((previous) => [linked, ...previous.filter((item) => item.id !== linked.id)]);
    });
  }, [paseo, selected]);

  // Workspace-wide search: a short pause after typing, then Linear's own search over every
  // team the key can see. Results render in their own section, de-duplicated against the
  // loaded assignments; the local list keeps its fast client-side filtering.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || !connection?.connected) { setSearchResults([]); setSearchError(null); return; }
    setSearching(true); setSearchError(null);
    let cancelled = false;
    const handle = setTimeout(() => {
      void searchAll({ term })
        .then((page) => { if (!cancelled) setSearchResults(page.issues); })
        .catch((error) => { if (!cancelled) setSearchError(message(error)); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); setSearching(false); };
  }, [query, connection?.connected, searchAll, searchVersion]);

  const project = projects.find((item) => item.projectId === projectId);
  useEffect(() => {
    let cancelled = false;
    setBranches([]); setDefaultBranch(null); setBranchesFor(null); setBaseBranch(""); setBranchesError(null);
    if (!project || project.projectKind !== "git") { setBranchesLoading(false); setBranchesFor(projectId); return; }
    setBranchesLoading(true);
    void getBranches({ projectId: project.projectId }).then((result) => {
      if (cancelled) return;
      setBranches(result.branches); setDefaultBranch(result.defaultBranch); setBranchesFor(project.projectId);
      setBaseBranch(result.defaultBranch ?? "");
    }, (error) => { if (!cancelled) setBranchesError(message(error)); })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [project?.projectId, project?.projectKind, project?.projectRootPath, getBranches, branchesVersion]);
  useEffect(() => {
    if (!wantedBranch || branchesLoading || branchesFor !== projectId) return;
    setWantedBranch(null);
    setBaseBranch(mappedBaseBranch(wantedBranch.branch, branches, defaultBranch));
  }, [wantedBranch, branchesLoading, branchesFor, projectId, branches, defaultBranch]);
  const mappingSource: MappingSource | null = detail ? { projectId: detail.projectId, projectName: detail.issue.project, teamId: detail.teamId, teamName: detail.issue.team } : null;
  useEffect(() => {
    if (!detail || !mappingSource || detail.issue.id !== selected?.id || !settingsLoaded || optionsLoading || mappedFor.current === selected.id) return;
    mappedFor.current = selected.id;
    const resolved = resolveMapping(mappingSource, projectMappings, projects);
    setMappingReason(resolved?.reason ?? null);
    setWantedBranch(resolved?.baseBranch ? { branch: resolved.baseBranch } : {});
    if (!resolved || resolved.projectId === projectId) return;
    setProjectId(resolved.projectId); setBaseBranch(""); setBranches([]);
    // mappingSource is derived from detail; the effect runs once per opened ticket.
  }, [detail, selected, settingsLoaded, optionsLoading, projects, projectMappings]);
  const providerGroups = [...new Set(models.map((model) => model.provider))];
  const selectedModel = models.find((model) => model.id === provider);
  const activeModes = modes[providerGroup] ?? [];
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];
  const selectProvider = useCallback((group: string) => {
    const restored = restoreLaunchSelection(group, launchPreferences[group], models, modes);
    setProviderGroup(group); setProvider(restored.model); setModeId(restored.modeId); setThinkingOptionId(restored.thinkingOptionId);
  }, [launchPreferences, models, modes]);
  useEffect(() => {
    if (restoredLaunchPreference.current || !settingsLoaded || optionsLoading || !models.length) return;
    restoredLaunchPreference.current = true;
    if (lastProvider && models.some((model) => model.provider === lastProvider)) selectProvider(lastProvider);
  }, [lastProvider, models, optionsLoading, selectProvider, settingsLoaded]);
  useEffect(() => {
    if (modeId && !activeModes.some((mode) => mode.id === modeId)) setModeId("");
  }, [activeModes, modeId]);
  useEffect(() => {
    if (!thinkingOptions.length) { if (thinkingOptionId) setThinkingOptionId(""); return; }
    if (!thinkingOptions.some((option) => option.id === thinkingOptionId)) {
      setThinkingOptionId(selectedModel?.defaultThinkingOptionId ?? thinkingOptions.find((option) => option.isDefault)?.id ?? "");
    }
  }, [selectedModel?.defaultThinkingOptionId, provider, thinkingOptionId, thinkingOptions]);
  const canLaunch = Boolean(detail && project && provider && !optionsLoading && !branchesLoading
    && (project.projectKind !== "git" || (baseBranch && !branchesError)));

  const t = useMemo(() => tokensFor(theme, layout), [theme, layout]);
  const colors = t.colors;

  const visible = filterIssues(issues, query, status, dateField, dateDirection, dependency);
  const searchTerm = query.trim();
  const loadedIds = useMemo(() => new Set(issues.map((issue) => issue.id)), [issues]);
  const remoteVisible = searchResults.filter((issue) => !loadedIds.has(issue.id));
  // Chips: server-side counts across all assignments once the count pass lands; until then
  // (or if it failed) fall back to the distinct names in the loaded pages.
  const statuses: [string, number][] = counts
    ? [...Object.entries(counts.byName)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)
    : statusCounts(issues);
  // A chip is grouped by state name; use the first loaded ticket's workflow category for its accent.
  const statusTypeFor = (name: string) => issues.find((issue) => issueStatus(issue) === name)?.statusType ?? "";
  // Keep a selected filter visible even when its last ticket leaves the loaded pages.
  if (status && !statuses.some(([name]) => name === status)) statuses.push([status, counts?.byName[status] ?? 0]);
  const ticketsLoading = busy === "Loading connection" || busy === "Refreshing tickets" || busy === "Loading tickets" || busy === "Loading all tickets";
  const current = detail?.issue ?? selected;
  const relatedTickets = detail ? [
    ...(detail.relations.parent ? [{ ...detail.relations.parent, relationLabel: "Parent" }] : []),
    ...detail.relations.subissues.map((ticket) => ({ ...ticket, relationLabel: "Subissue" })),
    ...detail.relations.related.map((ticket) => ({ ...ticket, relationLabel: ticket.direction })),
  ] : [];
  const missingRequirement = !project ? "Choose a project"
    : project.projectKind === "git" && !baseBranch ? "Choose a base branch"
      : !provider ? "Choose a model"
        : optionsLoading || branchesLoading ? "Loading choices…"
          : !detail ? "Loading ticket details…" : "";
  const changeStatus = (name: string | null) => {
    statusRef.current = name; setStatus(name); setIssues([]); setCursor(null);
    void run("Loading tickets", async () => { await loadIssues(undefined, { status: name, dependency: dependencyRef.current }); });
  };
  const changeDependency = (value: DependencyFilter) => {
    dependencyRef.current = value; setDependency(value); setIssues([]); setCursor(null);
    void run("Loading tickets", async () => { await loadIssues(undefined, { status: statusRef.current, dependency: value }); });
  };
  const choose = (issue: Issue) => {
    setSelected(issue); setAgent(null); setError(null); setInstructions(""); launchRequest.current = null;
    mappedFor.current = null; setWantedBranch(null); setMappingReason(null);
  };
  const chooseRelated = (ticket: RelatedTicket) => choose({
    id: ticket.id, identifier: ticket.identifier, title: ticket.title, url: ticket.url,
    status: ticket.status, statusType: ticket.statusType, branchName: "", priority: "",
    dueDate: null, estimate: null, project: "", description: "", team: "", labels: [],
    updatedAt: "", createdAt: "", blockingCount: 0, blockedByCount: 0,
  });
  const launch = () => void run("Starting agent", async () => {
    if (!selected || !canLaunch) return;
    const fingerprint = JSON.stringify([selected.id, projectId, baseBranch, provider, modeId, thinkingOptionId, instructions, markInProgress]);
    if (launchRequest.current?.fingerprint !== fingerprint) launchRequest.current = { fingerprint, id: requestId() };
    const result = await start({ id: selected.id, projectId, baseBranch: project?.projectKind === "git" ? baseBranch : undefined, provider, modeId: modeId || undefined, thinkingOptionId: thinkingOptionId || undefined, instructions, markInProgress, requestId: launchRequest.current.id });
    setAgent(result);
    const launchPreference = { model: provider, ...(modeId ? { modeId } : {}), ...(thinkingOptionId ? { thinkingOptionId } : {}) };
    setLaunchPreferences((previous) => ({ ...previous, [providerGroup]: launchPreference }));
    setLastProvider(providerGroup);
    // One patch per launch: the model choice and the project mapping are saved together.
    const key = mappingSource ? mappingKey(mappingSource) : null;
    const projectMapping = key && mappingSource ? { key, projectId, label: mappingLabel(mappingSource), ...(project?.projectKind === "git" && baseBranch ? { baseBranch } : {}) } : undefined;
    void saveSettings({ launchPreference: { provider: providerGroup, ...launchPreference }, ...(projectMapping ? { projectMapping } : {}) })
      .then((saved) => setProjectMappings(saved.projectMappings), () => {
        setOptionsError("Agent started, but its model and project choices could not be remembered.");
      });
    setLinkedAgents((previous) => previous.some((item) => item.id === result.agentId) ? previous : [{ id: result.agentId, title: `${selected.identifier}: ${selected.title}`, status: "initializing", updatedAt: new Date().toISOString() }, ...previous]);
  });
  const copyContext = () => {
    if (!detail) return;
    void copyText(detail.context).then(() => { setContextCopied(true); setTimeout(() => setContextCopied(false), 1600); }, () => setContextCopied(false));
  };

  const connectionPill = connection?.connected ? <View style={{ flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 }}>
    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.statusSuccess }} />
    <Text style={{ ...t.muted, fontSize: 12, fontWeight: "600" }}>{connection.source === "environment" ? "Host key" : "Connected"}</Text>
  </View> : null;

  const metaLine = (issue: Issue) => {
    const chips = issue.labels.slice(0, layout.compact ? 1 : 2);
    const extra = issue.labels.length - chips.length;
    const places = [issue.project, issue.team].filter(Boolean).join(" · ");
    const due = issue.dueDate ? `Due ${formatIssueDate(issue.dueDate)}` : "";
    const estimate = issue.estimate ? `${issue.estimate} pts` : "";
    const dependencies = [issue.blockingCount ? `Blocks ${issue.blockingCount}` : "", issue.blockedByCount ? `Blocked by ${issue.blockedByCount}` : ""].filter(Boolean);
    if (!places && !chips.length && !extra && !due && !estimate && !dependencies.length) return null;
    return <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0 }}>
      {!!places && <Text numberOfLines={1} style={t.muted}>{places}</Text>}
      {chips.map((label) => <LabelChip key={label} label={label} t={t} />)}
      {extra > 0 && <Text style={t.muted}>+{extra}</Text>}
      {due && <Text style={{ ...t.muted, color: colors.accent, fontSize: 11 }}>{due}</Text>}
      {estimate && <Text style={{ ...t.muted, fontSize: 11 }}>{estimate}</Text>}
      {dependencies.map((item) => <View key={item} style={{ backgroundColor: colors.surface2, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 }}><Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>{item}</Text></View>)}
    </View>;
  };

  const renderIssueRow = (issue: Issue, index: number) => {
    const isHovered = hovered === issue.id;
    const rightText = dateField === "priority" ? (hasPriority(issue.priority) ? formatPriority(issue.priority) : "—") : formatRelativeDate(issue[dateField] ?? "");
    const dependencyText = [issue.blockingCount ? `blocks ${issue.blockingCount}` : "", issue.blockedByCount ? `blocked by ${issue.blockedByCount}` : ""].filter(Boolean).join(", ");
    return <Pressable key={issue.id} accessibilityRole="button" accessibilityLabel={`View ${issue.identifier}: ${issue.title}, ${issueStatus(issue)}, ${rightText}${dependencyText ? `, ${dependencyText}` : ""}`} disabled={Boolean(busy)} onPress={() => choose(issue)}
      onHoverIn={() => setHovered(issue.id)} onHoverOut={() => setHovered(null)}
      style={({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: layout.compact ? 14 : 15, borderTopWidth: index ? 1 : 0, borderTopColor: colors.surface2, backgroundColor: pressed || isHovered ? colors.surface2 : colors.surface1, gap: 8 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, flexWrap: layout.compact ? "wrap" : "nowrap" }}>
        {!layout.compact && <View style={{ width: 20, alignItems: "center" }}><PriorityMark priority={issue.priority} t={t} /></View>}
        {!layout.compact && <Text style={{ color: colors.accent, width: 82, fontFamily: "monospace", fontSize: 12 }}>{issue.identifier}</Text>}
        <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
          {layout.compact && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PriorityMark priority={issue.priority} t={t} />
            <Text style={{ color: colors.accent, fontFamily: "monospace", fontSize: 12 }}>{issue.identifier}</Text>
          </View>}
          <Text numberOfLines={layout.compact ? 2 : 1} style={{ ...t.strong, fontSize: 15, lineHeight: 21 }}>{issue.title}</Text>
          {metaLine(issue)}
        </View>
        {!layout.compact && <>
          <View style={{ width: 130 }}><StatusBadge status={issueStatus(issue)} statusType={issue.statusType} t={t} /></View>
          <Text style={{ ...t.muted, width: 88, textAlign: "right" }}>{rightText}</Text>
          <Icon name="ChevronRight" size={15} color={isHovered ? colors.accent : colors.foregroundMuted} />
        </>}
        {layout.compact && <Icon name="ChevronRight" size={15} color={isHovered ? colors.accent : colors.foregroundMuted} />}
      </View>
      {layout.compact && <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <StatusBadge status={issueStatus(issue)} statusType={issue.statusType} t={t} /><Text style={t.muted}>{rightText}</Text>
      </View>}
    </Pressable>;
  };

  const settingsCard = <View style={{ ...t.card, gap: 14 }}>
    <SectionHeading title="Settings" subtitle="Saved on this host and applied to the ticket list and new launches." icon="Settings" t={t} />
    <FieldLabel title="Ticket status" icon="ListTodo" hint="when the agent starts" t={t} />
    <Button title={markInProgress ? "Mark the ticket In Progress when the agent starts" : "Keep the ticket in its current state"} icon={markInProgress ? "Check" : "CircleDashed"} stretch chosen={markInProgress}
      onPress={() => void run("Saving setting", async () => {
        const next = !markInProgress;
        setMarkInProgress(next);
        setMarkInProgress((await saveSettings({ markInProgress: next })).markInProgress);
      })} />
    <Text style={t.muted}>Off keeps the plugin read-only. The ticket only moves when its team has an In Progress state and it is not already in one.</Text>
    <Divider t={t} spaced />
    <FieldLabel title="Tickets shown" icon="Eye" hint="in the list and the status counts" t={t} />
    <Button title={showClosed ? "Show completed, canceled and duplicated tickets" : "Hide completed, canceled and duplicated tickets"} icon={showClosed ? "Check" : "CircleDashed"} stretch chosen={showClosed}
      onPress={() => void run("Updating ticket list", async () => {
        const next = !showClosed;
        setShowClosed(next);
        setShowClosed((await saveSettings({ showClosed: next })).showClosed);
        setStatus(null); setIssues([]); setCursor(null);
        await loadIssues(undefined, { status: null });
        void refreshCounts();
      })} />
    <Text style={t.muted}>Off keeps the list focused on open work; finished, canceled and duplicated tickets stay hidden from the list and the counts.</Text>
    <Divider t={t} spaced />
    <FieldLabel title="Agent access to Linear" icon="KeyRound" hint="for agents started from a ticket" t={t} />
    <Button title={agentLinearAccess ? "Agents can comment on, move and link their own ticket" : "Agents cannot change Linear"} icon={agentLinearAccess ? "Check" : "CircleDashed"} stretch chosen={agentLinearAccess}
      onPress={() => void run("Saving setting", async () => {
        const next = !agentLinearAccess;
        setAgentLinearAccess(next);
        setAgentLinearAccess((await saveSettings({ agentLinearAccess: next })).agentLinearAccess);
      })} />
    <Text style={t.muted}>On gives each new agent linear_ticket tools that act only on the ticket it started from, using this host's Linear key; canceling or marking duplicate stays with people. It needs a key with write access. Existing agents keep what they started with.</Text>
    <Divider t={t} spaced />
    <FieldLabel title="Auto-dispatch" icon="Zap" hint="start agents for labeled tickets" t={t} />
    {dispatch && <>
      <Button title={dispatch.enabled ? "Start an agent for every open ticket with the trigger label" : "Auto-dispatch is off"} icon={dispatch.enabled ? "Check" : "CircleDashed"} stretch chosen={dispatch.enabled}
        onPress={() => void run("Saving setting", async () => {
          setDispatch((await saveSettings({ dispatch: { enabled: !dispatch.enabled } })).dispatch);
        })} />
      <View style={{ flexDirection: layout.compact ? "column" : "row", gap: 8 }}>
        <TextInput accessibilityLabel="Trigger label" editable={!busy} autoCapitalize="none" autoCorrect={false} value={dispatchDraft.label} onChangeText={(label) => setDispatchDraft((draft) => ({ ...draft, label }))}
          placeholder="paseo" placeholderTextColor={colors.foregroundMuted} style={{ ...t.input, flex: layout.compact ? undefined : 1 }} />
        <TextInput accessibilityLabel="Team keys, comma-separated" editable={!busy} autoCapitalize="characters" autoCorrect={false} value={dispatchDraft.teamKeys} onChangeText={(teamKeys) => setDispatchDraft((draft) => ({ ...draft, teamKeys }))}
          placeholder="ENG, OPS" placeholderTextColor={colors.foregroundMuted} style={{ ...t.input, flex: layout.compact ? undefined : 2 }} />
        <TextInput accessibilityLabel="Poll interval in seconds" editable={!busy} keyboardType="number-pad" value={dispatchDraft.intervalSeconds} onChangeText={(intervalSeconds) => setDispatchDraft((draft) => ({ ...draft, intervalSeconds }))}
          placeholder="60" placeholderTextColor={colors.foregroundMuted} style={{ ...t.input, flex: layout.compact ? undefined : 1 }} />
        <TextInput accessibilityLabel="Maximum ticket agents at once, 0 for no limit" editable={!busy} keyboardType="number-pad" value={dispatchDraft.maxRunning} onChangeText={(maxRunning) => setDispatchDraft((draft) => ({ ...draft, maxRunning }))}
          placeholder="max agents (0 = no limit)" placeholderTextColor={colors.foregroundMuted} style={{ ...t.input, flex: layout.compact ? undefined : 1 }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <Button title="Save auto-dispatch" icon="Save" size="sm" disabled={JSON.stringify(dispatchDraft) === JSON.stringify(dispatchDraftFor(dispatch))}
          onPress={() => void run("Saving setting", async () => {
            const saved = await saveSettings({ dispatch: {
              label: dispatchDraft.label.trim(),
              teamKeys: dispatchDraft.teamKeys.split(",").map((key) => key.trim()).filter(Boolean),
              intervalSeconds: Number(dispatchDraft.intervalSeconds),
              maxRunning: Number(dispatchDraft.maxRunning || 0),
            } });
            setDispatch(saved.dispatch); setDispatchDraft(dispatchDraftFor(saved.dispatch));
          })} />
      </View>
      <Text style={t.muted}>Tickets in these teams carrying the label start an agent in their mapped project with your last-used provider, whoever they are assigned to — anyone who can label a ticket can start an agent on this host. The label is swapped for “{dispatch.label}-running” (or “{dispatch.label}-failed” with a comment explaining why). Unmapped projects are not guessed.</Text>
      {dispatchStatus && <Text style={t.muted}>{dispatchStatus.active ? "Polling" : "Idle"}{dispatchStatus.lastPollAt ? ` · last poll ${formatRelativeDate(dispatchStatus.lastPollAt)}` : " · waiting for first poll"}{dispatchStatus.lastError ? ` · error: ${dispatchStatus.lastError}` : ""}{dispatchStatus.recent.length ? ` · ${dispatchStatus.recent.slice(0, 3).map((item) => `${item.identifier} ${item.outcome}`).join(", ")}` : ""}</Text>}
    </>}
    <Divider t={t} spaced />
    <FieldLabel title="Linear agent" icon="Bot" hint="assign or @mention Paseo in Linear" t={t} />
    <Text style={t.muted}>{!agentStatus ? "Checking…" : !agentStatus.installed ? "The Paseo Linear app is not installed on this host (see README: Native Linear agent)." : `Installed · webhooks ${agentStatus.funnel ? "public via Tailscale Funnel" : `not public (${agentStatus.funnelNote ?? "Funnel off"}); missed sessions are picked up within a minute`}${agentStatus.lastWebhookAt ? ` · last event ${formatRelativeDate(agentStatus.lastWebhookAt)}` : ""}`}</Text>
    <Divider t={t} spaced />
    <FieldLabel title="Sync with Linear" icon="MessageSquare" hint="for agents linked to a ticket" t={t} />
    {writeback && WRITEBACK_OPTIONS.map(({ key, on, off }) => <Button key={key} title={writeback[key] ? on : off} icon={writeback[key] ? "Check" : "CircleDashed"} stretch chosen={writeback[key]}
      onPress={() => void run("Saving setting", async () => {
        setWriteback((await saveSettings({ writeback: { [key]: !writeback[key] } })).writeback);
      })} />)}
    <Text style={t.muted}>Uses this host's Linear key (write access needed), independent of the agent's own linear_ticket tools. Subagents do not report. Your comments starting with @paseo answer the agent's pending question, approve or deny a pending action (“@paseo approve” / “@paseo deny reason”), or otherwise become a message; 👀 marks delivered comments.</Text>
    <Divider t={t} spaced />
    <FieldLabel title="Project mappings" icon="Folder" hint="Linear project → Paseo project" t={t} />
    {Object.keys(projectMappings).length ? Object.entries(projectMappings).sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([key, mapping]) => {
      const target = projects.find((item) => item.projectId === mapping.projectId);
      const targetName = target ? target.projectCustomName || target.projectDisplayName : "Project no longer in Paseo";
      const branch = mapping.baseBranch ? ` · ${mapping.baseBranch.replace(/^refs\/(heads|remotes)\//, "")}` : "";
      return <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Text style={{ ...t.strong, flex: 1, minWidth: 160 }} numberOfLines={1}>{mapping.label} → {targetName}{branch}</Text>
        <Button title="Forget" icon="X" size="sm" onPress={() => void run("Saving setting", async () => {
          setProjectMappings((await saveSettings({ forgetProjectMapping: key })).projectMappings);
        })} />
      </View>;
    }) : <Text style={t.muted}>None yet. Starting an agent from a ticket remembers its project and base branch for that Linear project; until then a Paseo project with the same name is preselected.</Text>}
    <Divider t={t} spaced />
    <FieldLabel title="Default prompt" icon="PenLine" hint="the system prompt used when you start an agent" t={t} />
    {templateOpen ? <View style={{ gap: 8 }}>
      <TextInput accessibilityLabel="Default prompt template" editable={!busy} multiline maxLength={8000} value={templateText} onChangeText={setTemplateText}
        placeholder="How the agent should work on this ticket…" placeholderTextColor={colors.foregroundMuted} style={{ ...t.mono, minHeight: 120, textAlignVertical: "top" }} />
      <Text style={t.muted}>Placeholders: {"{{ticket}}"} = ticket ID and title · {"{{instructions}}"} = the extra direction you type at launch · {"{{context}}"} = the ticket snapshot (required) · {"{{linear_access}}"} = what the agent may change in Linear (appended when missing).</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button title="Save default prompt" icon="Check" onPress={() => void run("Saving default prompt", async () => {
          const result = await saveTemplate({ template: templateText });
          setTemplateSaved(result.template); setTemplateText(result.template ?? result.builtin); setTemplateOpen(false);
        })} />
        <Button title="Reset to built-in" icon="RotateCcw" onPress={() => void run("Resetting default prompt", async () => {
          const result = await saveTemplate({ template: "" });
          setTemplateSaved(null); setTemplateText(result.builtin); setTemplateOpen(false);
        })} />
      </View>
    </View> : <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Button title="Edit default prompt" icon="PenLine" size="sm" disabled={Boolean(busy)} onPress={() => { setTemplateText(templateSaved ?? builtinTemplate); setTemplateOpen(true); }} />
      <Text style={t.muted}>{templateSaved ? "A custom template is used for new agents." : "The built-in default is used for new agents."}</Text>
    </View>}
    <Button title="Back to tickets" icon="ArrowLeft" size="sm" onPress={() => setView("list")} />
  </View>;

  return <SurfaceProvider t={t} busy={Boolean(busy)}><ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28, gap: layout.compact ? 18 : 22, width: "100%", maxWidth: 1280, alignSelf: "center" }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 16, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 15, flex: 1, minWidth: 230 }}>
        <View style={{ width: 52, height: 52, borderRadius: 17, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}>
          <BrandMark brand="linear" label="Linear" theme={theme} size={26} radius={17} />
        </View>
        <View style={{ gap: 3, flex: 1 }}>
          <Text style={{ ...t.eyebrow, textTransform: "uppercase" }}>Linear · My work</Text>
          <Text style={t.title}>Linear tickets</Text>
          <Text style={t.muted}>{selected ? "A little context. A clear starting point." : "Your next idea, fix, or feature starts here."}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {connectionPill}
        {connection?.connected && <>
          <Button title="Connection" icon="Plug" iconOnly size="md" chosen={manageConnection} onPress={() => setManageConnection(!manageConnection)} />
          <Button title="Settings" icon="Settings" iconOnly size="md" chosen={view === "settings"} onPress={() => setView(view === "settings" ? "list" : "settings")} />
          <Button title="Refresh tickets" icon="RefreshCw" iconOnly onPress={() => void run("Refreshing tickets", async () => { await loadIssues(); void refreshCounts(); })} />
        </>}
      </View>
    </View>
    {busy && !ticketsLoading && <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}><ActivityIndicator color={colors.accent} /><Text style={t.muted}>{busy}…</Text></View>}
    {error && <Callout message={error} tone="danger" t={t} />}

    {!connection?.connected ? <View style={{ ...t.card, gap: 14 }}>
      <SectionHeading title="Connect your work" subtitle="Bring your assigned Linear tickets into Paseo." icon="Plug" t={t} />
      <View style={{ gap: 10 }}>
        {[
          "Create a personal API key in Linear → Settings → Security & access.",
          "Paste it below, or set LINEAR_API_KEY in the daemon environment.",
          "A read-only key covers browsing; write permission is only needed for the optional \"mark the ticket In Progress\" step.",
        ].map((step, index) => <View key={step} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: colors.accent, fontSize: 11, fontWeight: "700" }}>{index + 1}</Text>
          </View>
          <Text style={{ ...t.body, flex: 1 }}>{step}</Text>
        </View>)}
      </View>
      <Callout t={t} tone="info" message="The key is stored privately on this Paseo host and is shared by clients connected to it. It is never added to ticket context or agent prompts." />
      <FieldLabel title="Linear API key" icon="KeyRound" t={t} />
      <TextInput accessibilityLabel="Linear API key" secureTextEntry autoCapitalize="none" autoCorrect={false} value={key} onChangeText={setKey} placeholder="lin_api_…" placeholderTextColor={colors.foregroundMuted} style={t.input} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button title="Connect Linear" icon="Plug" primary disabled={!key.trim()} onPress={() => void run("Connecting Linear", async () => {
          setConnection(await connect({ apiKey: key.trim() })); setKey(""); await loadIssues(); void refreshCounts();
        })} />
        <Button title="Retry saved connection" icon="RefreshCw" onPress={() => void run("Loading connection", async () => {
          const status = await getStatus({}); setConnection(status);
          if (status.connected) { await loadIssues(); void refreshCounts(); }
        })} />
      </View>
    </View> : <>
      {manageConnection && <View style={{ ...t.card, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ gap: 3, flex: 1, minWidth: 220 }}>
          <Text style={t.strong}>Linear connection</Text>
          <Text style={t.muted}>{connection.source === "environment" ? "Key supplied by the daemon environment (LINEAR_API_KEY)." : "Key saved on this Paseo host."}</Text>
        </View>
        {connection.source !== "environment" && <Button title="Disconnect" icon="Unplug" tone="danger" onPress={() => void run("Disconnecting", async () => {
          setConnection(await disconnect({})); setIssues([]); setCounts(null); setLastUpdatedAt(null); setSearchResults([]); setSearchError(null); setSelected(null); setAgent(null); setCursor(null); statusRef.current = null; setStatus(null); setQuery("");
        })} />}
      </View>}

      {view === "settings" ? settingsCard : selected && current ? <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button title="Tickets" icon="ArrowLeft" onPress={() => { setSelected(null); setAgent(null); setError(null); }} />
          {/^https:\/\/linear\.app\//.test(selected.url) && <Button title="Open in Linear" icon="ExternalLink" onPress={() => void run("Opening Linear", async () => { await openExternalUrl(selected.url, { platform: layout.platform, linking: Linking }); })} />}
        </View>
        <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: "flex-start", gap: 20 }}>
          <View style={{ ...t.card, gap: 14, flex: layout.compact ? undefined : 1.15, width: layout.compact ? "100%" : undefined, minWidth: 0, borderTopWidth: 3, borderTopColor: colors.accent }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surface2, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
                  <Icon name="Ticket" size={13} color={colors.accent} />
                  <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "700", fontFamily: "monospace" }}>{current.identifier}</Text>
                </View>
                <PriorityMark priority={current.priority} t={t} showLabel />
              </View>
              <StatusBadge status={current.status} statusType={current.statusType} t={t} />
            </View>
            <Text style={t.cardTitle}>{current.title}</Text>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, backgroundColor: colors.surface0, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 14 }}>
              <MetaItem icon="Folder" label="Project" value={current.project || "—"} t={t} />
              <MetaItem icon="Users" label="Team" value={current.team || "—"} t={t} />
              <MetaItem icon="Tag" label="Labels" chips={current.labels} t={t} />
              <MetaItem icon="Calendar" label="Created" value={formatIssueDate(current.createdAt)} t={t} />
              <MetaItem icon="Clock" label="Updated" value={formatRelativeDate(current.updatedAt)} t={t} />
              {current.dueDate && <MetaItem icon="CalendarClock" label="Due" value={formatIssueDate(current.dueDate)} t={t} />}
              {current.estimate ? <MetaItem icon="Hash" label="Estimate" value={`${current.estimate} pts`} t={t} /> : null}
            </View>

            {detail && statusChangesText(detail.context) && <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="History" size={13} color={colors.foregroundMuted} />
              <Text style={{ ...t.muted, fontSize: 12 }}>Status history: {statusChangesText(detail.context)}</Text>
            </View>}

            {!!relatedTickets.length && <View style={{ gap: 10 }}>
              <Button title={`${showRelatedTickets ? "Hide" : "Show"} related tickets · ${relatedTickets.length}`} icon={showRelatedTickets ? "ChevronUp" : "ChevronDown"} chosen={showRelatedTickets} stretch onPress={() => setShowRelatedTickets(!showRelatedTickets)} />
              {showRelatedTickets && <View style={{ gap: 8 }}>
                <FieldLabel title="Related tickets" icon="GitBranch" hint="your assigned tickets are highlighted" t={t} />
                {relatedTickets.map((ticket) => <Pressable key={`${ticket.relationLabel}:${ticket.id}`} accessibilityRole="button" accessibilityLabel={`View ${ticket.relationLabel} ticket ${ticket.identifier}: ${ticket.title}${ticket.assignedToViewer ? ", assigned to you" : ""}`} onPress={() => chooseRelated(ticket)}
                style={({ pressed }) => ({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, borderWidth: ticket.assignedToViewer ? 2 : 1, borderColor: ticket.assignedToViewer ? colors.accent : colors.border, borderRadius: 10, padding: 10, backgroundColor: pressed || ticket.assignedToViewer ? colors.surface2 : colors.surface0 })}>
                  <Text style={{ ...t.eyebrow, color: colors.accent, width: 76, textTransform: "capitalize" }}>{ticket.relationLabel}</Text>
                  <Text style={{ ...t.mono, color: colors.accent }}>{ticket.identifier}</Text>
                  <Text numberOfLines={1} style={{ ...t.strong, flex: 1, minWidth: 140 }}>{ticket.title}</Text>
                  <Text style={{ ...t.muted, color: ticket.assignedToViewer ? colors.accent : colors.foregroundMuted, fontWeight: ticket.assignedToViewer ? "700" : "400" }}>{ticket.assignedToViewer ? "Assigned to you" : ticket.assignee || "Unassigned"}</Text>
                  {!!ticket.status && <StatusBadge status={ticket.status} statusType={ticket.statusType} t={t} />}
                  <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
                </Pressable>)}
              </View>}
            </View>}

            {(linkedAgentsLoading || linkedAgents.length > 0) && <View style={{ gap: 8 }}>
              <FieldLabel title="Paseo agents" icon="Bot" hint={linkedAgentsLoading ? "loading linked agents…" : `${linkedAgents.length} linked`} t={t} />
              {linkedAgents.slice(0, 4).map((linked) => <View key={linked.id} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Text numberOfLines={1} style={t.strong}>{linked.title || `Agent ${linked.id.slice(0, 8)}`}</Text>
                  <Text style={t.muted}>{linked.status} · {formatRelativeDate(linked.updatedAt)}</Text>
                </View>
                {navigation ? <Button title="Open agent" icon="ArrowUpRight" size="sm" onPress={() => navigation.openAgent({ agentId: linked.id })} /> : <Text selectable style={t.mono}>{linked.id}</Text>}
              </View>)}
            </View>}

            <Divider t={t} spaced />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <FieldLabel title="Description" icon="FileText" t={t} />
              {detailLoading && <ActivityIndicator color={colors.accent} size="small" />}
            </View>
            {detailLoading && <View style={{ gap: 9 }}><Skeleton t={t} width="100%" height={12} /><Skeleton t={t} width="92%" height={12} /><Skeleton t={t} width="64%" height={12} /></View>}
            {detailError && <Callout t={t} tone="danger" message={detailError} action={<Button title="Retry" icon="RefreshCw" size="sm" onPress={() => setDetailVersion((value) => value + 1)} />} />}
            {detail && <>
              <MarkdownPreview markdown={detail.issue.description || "No description provided."} t={t} platform={layout.platform} />
              {detail.warnings.map((warning) => <Callout key={warning} t={t} message={warning} />)}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Button title={showContext ? "Hide agent context" : "Preview agent context"} icon="FileText" onPress={() => setShowContext(!showContext)} />
                <Button title={contextCopied ? "Copied" : "Copy context"} icon={contextCopied ? "Check" : "Copy"} onPress={copyContext} />
              </View>
              {showContext && <ScrollView style={{ maxHeight: 320, backgroundColor: colors.surface0, borderRadius: 10, borderWidth: 1, borderColor: colors.border }} contentContainerStyle={{ padding: 14 }} nestedScrollEnabled>
                <Text selectable style={t.mono}>{detail.context}</Text>
              </ScrollView>}
            </>}
          </View>

          {agent ? <View style={{ ...t.card, gap: 14, flex: layout.compact ? undefined : 1, width: layout.compact ? "100%" : undefined, minWidth: 0 }}>
            <SectionHeading title="Agent started" subtitle="The ticket snapshot is in its first prompt." icon="CircleCheck" t={t} />
            {agent.warnings.map((warning) => <Callout key={warning} t={t} message={warning} />)}
            {navigation
              ? <Button title="Open agent" icon="ArrowUpRight" primary stretch onPress={() => navigation.openAgent({ agentId: agent.agentId })} />
              : <Text selectable style={t.mono}>Agent ID: {agent.agentId}</Text>}
            <Button title="Start another agent" icon="RotateCcw" onPress={() => { setAgent(null); launchRequest.current = null; }} />
          </View> : <View style={{ ...t.card, gap: 14, flex: layout.compact ? undefined : 1, width: layout.compact ? "100%" : undefined, minWidth: 0 }}>
            <SectionHeading title="Set your agent up" subtitle="Choose where it works and who takes the lead." icon="Bot" t={t} />
            {optionsError && <Callout t={t} message={optionsError} action={<Button title="Reload" icon="RefreshCw" size="sm" onPress={() => void loadOptions()} />} />}

            <FieldLabel title="Workspace" icon="Folder" hint="where the agent runs" t={t} />
            <ChoicePicker label="Projects" icon="Folder" placeholder="Choose a project" options={projects.map((item) => ({ id: item.projectId, label: item.projectCustomName || item.projectDisplayName, description: item.projectRootPath }))}
              value={projectId} onChange={(id) => { mappedFor.current = selected?.id ?? null; setWantedBranch(null); setMappingReason(null); if (id !== projectId) { setProjectId(id); setBaseBranch(""); setBranches([]); } }} t={t} disabled={Boolean(busy) || optionsLoading} />
            {mappingReason && project && <Text style={t.muted}>{mappingReason === "saved" ? `Remembered for ${mappingSource ? mappingLabel(mappingSource) : "this Linear project"}.` : "Matched by the Linear project name."} Starting an agent remembers the project you choose.</Text>}
            {!optionsLoading && !projects.length && <Callout t={t} tone="info" message="Open a project in Paseo, then reload the choices." />}
            {project?.projectKind === "git" && <>
              <FieldLabel title="Base branch" icon="GitBranch" hint="new worktree starts here" t={t} />
              <ChoicePicker label="Branches" icon="GitBranch" placeholder="Choose a base branch" options={branches} value={baseBranch} onChange={(id) => { mappedFor.current = selected?.id ?? null; setWantedBranch(null); setMappingReason(null); setBaseBranch(id); }} t={t} disabled={Boolean(busy) || branchesLoading} />
              {branchesLoading && <ActivityIndicator color={colors.accent} />}
              {branchesError && <Callout t={t} tone="danger" message={branchesError} />}
              {!branchesLoading && !branches.length && !branchesError && <Callout t={t} tone="info" message="No branches found. The repository needs at least one commit." />}
              <Text style={t.muted}>Creates a new ticket branch in its own worktree from this branch. Remote branches use the locally fetched version.</Text>
              <Button title="Refresh branches" icon="RefreshCw" size="sm" disabled={branchesLoading} onPress={() => { setWantedBranch({ ...(baseBranch ? { branch: baseBranch } : {}) }); setBranchesFor(null); setBranchesVersion((value) => value + 1); }} />
            </>}
            {project && project.projectKind !== "git" && <Text style={t.muted}>The agent will work in this project’s directory.</Text>}

            <Divider t={t} spaced />
            <FieldLabel title="Provider" icon="Bot" hint={`${models.length} model${models.length === 1 ? "" : "s"} available`} t={t} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {providerGroups.map((group) => <Button key={group} leading={<ProviderMark provider={group} theme={theme} size={15} />} title={`${group} · ${models.filter((model) => model.provider === group).length}`} chosen={providerGroup === group}
                onPress={() => { if (group !== providerGroup) selectProvider(group); }} />)}
            </View>
            {optionsLoading && <View style={{ gap: 9 }}><Skeleton t={t} width="40%" height={12} /><Skeleton t={t} width="100%" height={48} radius={10} /></View>}
            {!optionsLoading && !models.length && <Callout t={t} tone="info" message="Configure an agent provider in Paseo, then reload the choices." />}
            {providerGroup && <>
              <FieldLabel title="Model" icon="Cpu" t={t} />
              <ChoicePicker label="Models" icon="Cpu" placeholder="Choose a model" options={models.filter((model) => model.provider === providerGroup)} value={provider} onChange={(id) => {
                const model = models.find((candidate) => candidate.id === id);
                setProvider(id); setThinkingOptionId(model?.defaultThinkingOptionId ?? model?.thinkingOptions.find((option) => option.isDefault)?.id ?? "");
              }} leading={<ProviderMark provider={providerGroup} theme={theme} size={15} />} t={t} disabled={Boolean(busy)} />
              {!!activeModes.length && <>
                <FieldLabel title="Change mode" icon="SlidersHorizontal" t={t} />
                <ChoicePicker label="Modes" icon="SlidersHorizontal" placeholder="Use provider default" options={[{ id: "", label: "Provider default", description: "Use the default mode configured in Paseo." }, ...activeModes]} value={modeId} onChange={setModeId} t={t} disabled={Boolean(busy)} />
              </>}
              {!!thinkingOptions.length && <>
                <FieldLabel title="Reasoning" icon="BrainCircuit" t={t} />
                <ChoicePicker label="Reasoning" icon="BrainCircuit" placeholder="Choose a reasoning level" options={thinkingOptions} value={thinkingOptionId} onChange={setThinkingOptionId} t={t} disabled={Boolean(busy)} />
                <Text style={t.muted}>Reasoning levels come directly from this model’s Paseo provider.</Text>
              </>}
            </>}
            <Button title="Reload projects and models" icon="RefreshCw" size="sm" disabled={optionsLoading} onPress={() => void loadOptions()} />

            <Divider t={t} spaced />
            <FieldLabel title="A little extra direction" icon="MessageSquare" hint="optional" t={t} />
            <TextInput accessibilityLabel="Additional instructions for the agent" editable={!busy} multiline maxLength={10000} value={instructions} onChangeText={setInstructions}
              placeholder="Anything the agent should know before it starts…" placeholderTextColor={colors.foregroundMuted} style={{ ...t.input, minHeight: 84, textAlignVertical: "top" }} />

            <Divider t={t} spaced />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Button title="Settings" icon="Settings" size="sm" disabled={Boolean(busy)} onPress={() => setView("settings")} />
              <Text style={t.muted}>{markInProgress ? "Ticket will be marked In Progress at launch." : "Ticket stays in its current state at launch."} {templateSaved ? "Custom default prompt active." : "Built-in default prompt."}</Text>
            </View>

            <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, marginTop: 4, gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                <Icon name={canLaunch ? "CircleCheck" : "CircleDashed"} size={14} color={canLaunch ? colors.statusSuccess : colors.foregroundMuted} />
                <Text style={t.muted}>{canLaunch ? "Ticket context included. Ready when you are." : missingRequirement}</Text>
              </View>
              <Button title="Start agent with ticket" icon="Rocket" primary stretch disabled={!canLaunch} onPress={launch} />
            </View>
          </View>}
        </View>
      </> : <>
        <View style={{ ...t.card, gap: 16 }}>
          <View style={{ ...t.input, paddingVertical: 0, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Icon name="Search" size={17} color={colors.foregroundMuted} />
            <TextInput accessibilityLabel="Search tickets" value={query} onChangeText={setQuery} placeholder="Search loaded tickets — and all of Linear…" placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, paddingVertical: 12, fontSize: 14, flex: 1, minWidth: 0 }} />
            {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery("")}><Icon name="X" size={15} color={colors.foregroundMuted} /></Pressable>}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <FieldLabel title="Status" icon="ListFilter" t={t} />
            <Button size="sm" title={`All · ${counts ? (counts.complete ? counts.total : `${counts.total}+`) : issues.length}`} chosen={status === null} onPress={() => changeStatus(null)} />
            {statuses.map(([name, count]) => <Button key={name} size="sm" title={`${name} · ${count}`} chosen={status === name} leading={<StatusMark status={name} statusType={statusTypeFor(name)} t={t} />}
              onPress={() => changeStatus(status === name ? null : name)} />)}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <FieldLabel title="Dependencies" icon="GitBranch" t={t} />
            <Button size="sm" title="All" chosen={dependency === "all"} onPress={() => changeDependency("all")} />
            <Button size="sm" title="Blocking others" icon="Flag" chosen={dependency === "blocking"} onPress={() => changeDependency(dependency === "blocking" ? "all" : "blocking")} />
            <Button size="sm" title="Blocked" icon="Lock" chosen={dependency === "blocked"} onPress={() => changeDependency(dependency === "blocked" ? "all" : "blocked")} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <FieldLabel title="Sort" icon="ArrowDownUp" t={t} />
            <Segmented t={t} label="Sort field" value={dateField} onChange={(value) => setDateField(value)}
              options={[{ value: "updatedAt" as SortField, label: "Updated", icon: "Clock" }, { value: "createdAt" as SortField, label: "Created", icon: "Calendar" }, { value: "dueDate" as SortField, label: "Due", icon: "CalendarClock" }, { value: "priority" as SortField, label: "Priority", icon: "Flag" }]} />
            <Segmented t={t} label="Sort direction" value={dateDirection} onChange={(value) => setDateDirection(value)}
              options={[{ value: "newest" as SortDirection, label: dateField === "dueDate" ? "Latest" : dateField === "priority" ? "Highest" : "Newest", icon: "ArrowDown" }, { value: "oldest" as SortDirection, label: dateField === "dueDate" ? "Soonest" : dateField === "priority" ? "Lowest" : "Oldest", icon: "ArrowUp" }]} />
            {!!(status || query || dependency !== "all") && <Button size="sm" title="Clear filters" icon="X" onPress={() => { dependencyRef.current = "all"; setDependency("all"); changeStatus(null); setQuery(""); }} />}
          </View>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ ...t.muted, fontWeight: "600" }}>{visible.length} of {issues.length} tickets{!showClosed ? " (open)" : ""}{cursor ? " loaded" : ""}{status ? ` · ${status}` : ""}{lastUpdatedAt ? ` · Updated ${formatRelativeDate(lastUpdatedAt)}` : ""}</Text>
          <Text style={t.muted}>Sorted by {dateField === "priority" ? (dateDirection === "newest" ? "priority · highest first" : "priority · lowest first") : dateField === "dueDate" ? (dateDirection === "newest" ? "due date · latest first" : "due date · soonest first") : dateField === "updatedAt" ? (dateDirection === "newest" ? "last updated · newest first" : "last updated · oldest first") : dateDirection === "newest" ? "date created · newest first" : "date created · oldest first"}</Text>
        </View>

        {!busy && !visible.length && <EmptyState t={t} icon={issues.length ? "Search" : "CircleCheck"} title={issues.length ? "No matching tickets" : "You’re all caught up"}
          description={issues.length ? "Try another status or a different search term." : showClosed ? "Assigned tickets will appear here as soon as Linear has them." : "No open tickets are assigned to you right now. Enable the closed-states setting to also see finished work."}
          action={!!(status || query || dependency !== "all") ? <Button title="Clear filters" icon="X" onPress={() => { dependencyRef.current = "all"; setDependency("all"); changeStatus(null); setQuery(""); }} /> : undefined} />}

        {(!!visible.length || ticketsLoading) && <View style={{ backgroundColor: colors.surface1, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
          {!layout.compact && <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: colors.surface2 }}>
            <View style={{ width: 20 }} />
            <Text style={{ ...t.eyebrow, width: 82 }}>Issue</Text>
            <Text style={{ ...t.eyebrow, flex: 1 }}>Title</Text>
            <Text style={{ ...t.eyebrow, width: 130 }}>Status</Text>
            <Text style={{ ...t.eyebrow, width: 88, textAlign: "right" }}>{dateField === "priority" ? "Priority" : dateField === "dueDate" ? "Due date" : dateField === "updatedAt" ? "Updated" : "Created"}</Text>
            <View style={{ width: 14 }} />
          </View>}
          {ticketsLoading && !visible.length && [0, 1, 2, 3].map((row) => <View key={row} style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 18, borderTopWidth: row ? 1 : 0, borderTopColor: colors.surface2 }}>
            <Skeleton t={t} width={14} height={14} radius={7} />
            <Skeleton t={t} width={64} height={12} />
            <Skeleton t={t} width={`${52 + row * 8}%`} height={14} />
            <View style={{ flex: 1 }} />
            <Skeleton t={t} width={86} height={18} radius={9} />
          </View>)}
          {visible.map((issue, index) => renderIssueRow(issue, index))}
        </View>}

        {cursor && <View style={{ ...t.card, alignItems: "center", gap: 10 }}>
          <Text style={{ ...t.muted, textAlign: "center" }}>Search and sorting apply to loaded tickets. Load all to include every assignment.</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
            <Button title="Load more" icon="ChevronDown" onPress={() => void run("Loading tickets", async () => { await loadIssues(cursor); })} />
            <Button title="Load all tickets" icon="Layers" onPress={() => void run("Loading all tickets", loadAllIssues)} />
          </View>
        </View>}

        {searchTerm.length >= 2 && (searching || searchResults.length > 0 || searchError) && <View style={{ ...t.card, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <SectionHeading title="Across Linear" subtitle={`Workspace-wide matches for “${searchTerm}”`} icon="Search" t={t} />
            {searching && <ActivityIndicator color={colors.accent} size="small" />}
          </View>
          {searchError && <Callout t={t} tone="danger" message={searchError} action={<Button title="Retry" icon="RefreshCw" size="sm" onPress={() => setSearchVersion((value) => value + 1)} />} />}
          {remoteVisible.length ? <View style={{ backgroundColor: colors.surface1, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: colors.border }}>
            {remoteVisible.map((issue, index) => renderIssueRow(issue, index))}
          </View> : !searching && !searchError && <Text style={t.muted}>No other tickets in this workspace match “{searchTerm}”.</Text>}
        </View>}
      </>}
    </>}
  </ScrollView></SurfaceProvider>;
}
