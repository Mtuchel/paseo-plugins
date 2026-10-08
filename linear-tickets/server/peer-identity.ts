import { join } from "node:path";
import { z } from "zod";
import { activationDirectory, JsonFile, postToPeer, readActivationSecret, type RequestLike } from "./activation";
import type { Settings } from "./settings";

// The peer host's Paseo Linear app user (README, "Several hosts"). Each host installs its own app,
// so a ticket an agent or planner filed on the other host has that host's app as its creator, and
// the trust rule (starter.ts isUntrusted) must know it. The peer says it on its authenticated
// `/activation/health`; the answer is kept on disk per peer origin, so a peer that is offline (or
// restarting) keeps its last known id. Until the peer has answered once there is no id: nothing is
// trusted beyond this host's own app.
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5_000;

const knownSchema = z.object({ peer: z.string().min(1), appUserId: z.string().min(1), at: z.string().min(1) });
type Known = z.infer<typeof knownSchema>;
type PeerFile = { known: Known | null };
// A file from an older or broken write is no id at all, never a guess.
const peerFile = (raw: unknown): PeerFile => ({ known: z.object({ known: knownSchema }).safeParse(raw).data?.known ?? null });
const healthSchema = z.object({ appUserId: z.string().min(1) });

export type PeerAppUserDeps = {
  settings: Pick<Settings, "read">;
  home?: string;
  secret?: () => Promise<string | null>;
  request?: RequestLike;
  now?: () => number;
  log?: (message: string) => void;
};

export class PeerAppUser {
  private readonly file: JsonFile<PeerFile>;
  private attemptAt = Number.NEGATIVE_INFINITY;
  private asking: Promise<void> | null = null;

  constructor(private readonly deps: PeerAppUserDeps) {
    this.file = new JsonFile(join(activationDirectory(deps.home), "peer-app-user.json"), () => ({ known: null }), peerFile);
  }

  // The configured peer's app user, or null when there is no peer or it has never answered. Asks
  // the peer at most every 10 minutes while the id is missing or older than 6 hours; a known id
  // stays in use while the peer cannot be reached.
  async id(): Promise<string | null> {
    const { peer } = (await this.deps.settings.read()).activation;
    if (!peer) return null;
    const now = this.deps.now?.() ?? Date.now();
    const current = await this.current(peer);
    if ((!current || now - Date.parse(current.at) >= REFRESH_MS) && now - this.attemptAt >= RETRY_MS) {
      this.attemptAt = now;
      this.asking ??= this.ask(peer, now).finally(() => { this.asking = null; });
      await this.asking;
      return (await this.current(peer))?.appUserId ?? null;
    }
    return current?.appUserId ?? null;
  }

  private async current(peer: string): Promise<Known | null> {
    const { known } = await this.file.load().catch(() => ({ known: null }));
    return known?.peer === peer ? known : null;
  }

  private async ask(peer: string, now: number): Promise<void> {
    const secret = await (this.deps.secret ?? readActivationSecret)();
    if (!secret) return;
    try {
      const answer = healthSchema.safeParse(await postToPeer(this.deps.request ?? (fetch as unknown as RequestLike), peer, "/activation/health", secret, {}, TIMEOUT_MS));
      // A peer without the app (or an older plugin) names none; the last known id stays.
      if (!answer.success) return;
      const id = answer.data.appUserId;
      await this.file.update((value) => { value.known = { peer, appUserId: id, at: new Date(now).toISOString() }; });
    } catch (error) {
      (this.deps.log ?? console.error)(`[linear-tickets] reading the peer host's Paseo app user failed; its tickets stay untrusted until it answers: ${error instanceof Error ? error.message : error}`);
    }
  }
}
