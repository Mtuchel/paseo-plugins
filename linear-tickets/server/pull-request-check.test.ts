import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestNotFoundError } from "./pr-watch";
import { GitHubRateLimitedError } from "./rate-budget";
import { ticketPullRequest, type PullRequestText } from "./pull-request-check";

const URL = "https://github.com/o/r/pull/1";
const shows = (pullRequest: Partial<PullRequestText>) => async (): Promise<PullRequestText> => ({ title: "", body: "", headRefName: "", ...pullRequest });
const fails = (error: unknown) => async (): Promise<PullRequestText> => { throw error; };
// What execFile rejects with when gh exits non-zero.
const ghFailed = (stderr: string) => Object.assign(new Error(`Command failed: gh pr view ${URL}`), { stderr });

test("a pull request gh cannot find, or in a repository it cannot see, is not the ticket's", async () => {
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", fails(new PullRequestNotFoundError("GraphQL: Could not resolve to a PullRequest with the number of 1. (repository.pullRequest)"))), { link: false, reason: "no such pull request" });
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", fails(ghFailed("GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)\n"))), { link: false, reason: "no such repository, or this host's gh cannot see it" });
});

test("an existing pull request is the ticket's when its title, description or head branch names the ticket as a whole word", async () => {
  const linked = { link: true };
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", shows({ title: "ENG-1: fix sign-in" })), linked);
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", shows({ title: "Fix sign-in", body: "Part of ENG-1" })), linked);
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", shows({ title: "Fix sign-in", headRefName: "mtuchel/eng-1-fix" })), linked);
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", shows({ title: "eng-1 fix sign-in" })), linked);
  assert.deepEqual(await ticketPullRequest(URL, "ENG-1", shows({ title: "ENG-10: other work", body: "Part of ENG-10", headRefName: "mtuchel/eng-10-other" })), { link: false, reason: "the pull request does not name ENG-1 in its title, description or branch" });
  // The agent's own branch is no proof: branch names repeat across repositories.
  assert.equal((await ticketPullRequest(URL, "ENG-1", shows({ title: "Fix sign-in", body: null, headRefName: "fix-sign-in" }))).link, false);
});

test("throttling and any other gh failure throw a message the write-back retries, so the pull request is kept", async () => {
  await assert.rejects(ticketPullRequest(URL, "ENG-1", fails(new GitHubRateLimitedError("GitHub is throttling gh: HTTP 429"))), { message: `Could not reach GitHub to check ${URL}: GitHub is throttling gh: HTTP 429` });
  await assert.rejects(ticketPullRequest(URL, "ENG-1", fails(ghFailed("error connecting to api.github.com\ncheck your internet connection\n"))), { message: `Could not reach GitHub to check ${URL}: error connecting to api.github.com` });
  await assert.rejects(ticketPullRequest(URL, "ENG-1", fails(new Error("spawn gh ETIMEDOUT"))), { message: `Could not reach GitHub to check ${URL}: spawn gh ETIMEDOUT` });
});
