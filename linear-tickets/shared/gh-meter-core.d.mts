export declare const METER_ENV: {
  caller: "LINEAR_TICKETS_GH_CALLER";
  run: "LINEAR_TICKETS_GH_RUN";
  call: "LINEAR_TICKETS_GH_CALL";
  next: "LINEAR_TICKETS_GH_NEXT";
  meterDir: "LINEAR_TICKETS_GH_METER_DIR";
  basis: "LINEAR_TICKETS_GH_BASIS";
  dir: "LINEAR_TICKETS_USAGE_DIR";
};

export type MeterMode = "include" | "own" | "untouched";
export type MeterShape = {
  command: string;
  commandIndex: number;
  method: string | null;
  write: boolean;
  graphql: boolean;
  cache: boolean;
  local: boolean;
  mode: MeterMode;
};
export type HeaderBlock = { status: number; headers: Map<string, string> };
export type ResponseClass = "free" | "refused" | "charged" | "uncertain" | "cached";
export type UsageResponse = {
  status: number;
  class: ResponseClass;
  resource: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  reset: number | null;
  retryAfter?: number;
};
export type AccountBasis = "guard rule" | "router" | "none";
export type Account = "bot" | "owner" | "unknown";
export type UsageRecord = {
  at: string;
  host: string;
  call: string;
  caller: string;
  run: string | null;
  command: string;
  method: string | null;
  write: boolean;
  responses: UsageResponse[];
  pages: number | "unknown";
  account: Account;
  basis: AccountBasis;
  exit: number | string | null;
};
export type RunRecord = {
  kind: "run";
  at: string;
  host: string;
  run: string;
  caller: string;
  size: Record<string, number>;
};

export declare function meterShape(args: readonly string[]): MeterShape;
export declare function meteredArgs(args: string[], shape: MeterShape): string[];
export declare function splitIncluded<T extends string | Buffer>(output: T): { block: HeaderBlock | null; body: T };
export declare function responseOf(block: HeaderBlock, options: { cachePossible: boolean; startedAt: number; text?: string }): UsageResponse;
export declare function accountOf(basis: AccountBasis, shape: Pick<MeterShape, "write">, env?: NodeJS.ProcessEnv): { account: Account; basis: AccountBasis };
export declare function usageDir(env?: NodeJS.ProcessEnv): string;
export declare function usageFile(dir: string, at: number): string;
export declare function usageLine(record: UsageRecord | RunRecord): string;
export declare function appendUsage(dir: string, record: UsageRecord | RunRecord): void;
export declare function withoutDir(path: string | undefined, dir: string | undefined): string;
