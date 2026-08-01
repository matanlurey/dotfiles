/**
 * GitHub App authentication and the REST surface the worker needs.
 *
 * Auth flow: sign a short-lived RS256 JWT with the App private key, exchange it
 * for an installation access token (~1h), cache it on disk, refresh on expiry.
 * Installation tokens double as git credentials via x-access-token, so pushes
 * and commits are attributed to the App rather than to a human.
 *
 * No SDK dependency: node:crypto signs the JWT and fetch does the rest.
 */

import { createSign } from "node:crypto";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { TOKEN_CACHE } from "./config.ts";

const API = "https://api.github.com";
const UA = "matanlurey-agent-worker";

export type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string }[];
  user: { login: string };
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
};

export type Comment = {
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at: string;
};

export type PullRequest = {
  number: number;
  state: string;
  draft: boolean;
  merged: boolean | null;
  merged_at: string | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  html_url: string;
};

export type Review = {
  id: number;
  state: string;
  body: string | null;
  user: { login: string };
  submitted_at: string;
};

export type ReviewComment = {
  id: number;
  body: string;
  path: string;
  line: number | null;
  user: { login: string };
  created_at: string;
  in_reply_to_id?: number;
};

export type CheckConclusion =
  | "pending"
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "skipped"
  | "none";

export type CheckSummary = {
  conclusion: CheckConclusion;
  failing: { name: string; url: string }[];
  total: number;
};

type Installation = {
  id: number;
  account: string;
  /** "all" or "selected". "all" means every repo on that account. */
  selection: string;
};

type TokenCache = Record<string, { token: string; expiresAt: string }>;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign the App-level JWT used to mint installation tokens. */
function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // A numeric App ID must be sent as a JSON integer; GitHub rejects the string
  // form with "'Issuer' claim ('iss') must be an Integer". Client IDs (Iv23li...)
  // are also valid issuers and stay strings.
  const iss = /^\d+$/.test(appId) ? Number(appId) : appId;
  // Backdate iat by 60s to tolerate clock skew; GitHub caps exp at 10 minutes.
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKeyPem, "base64url")}`;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  #cfg: Config;
  /** installation id -> token. An App may be installed on several accounts. */
  #tokens = new Map<number, { token: string; expiresAt: number }>();
  #installations: Installation[] | undefined;
  /** repo full name -> installation id that can reach it. */
  #repoIndex: Map<string, number> | undefined;
  #botLogin: string | undefined;
  #botUserId: number | undefined;

  constructor(cfg: Config) {
    this.#cfg = cfg;
    // Reuse cached tokens across daemon restarts so a bounce doesn't burn a
    // fresh token per installation every time.
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf-8")) as TokenCache;
      for (const [id, entry] of Object.entries(cached)) {
        const expiry = Date.parse(entry.expiresAt);
        if (expiry - Date.now() > 60_000) {
          this.#tokens.set(Number(id), { token: entry.token, expiresAt: expiry });
        }
      }
    } catch {
      // Missing or corrupt cache is fine; we mint new tokens.
    }
  }

  #persistTokens(): void {
    const out: TokenCache = {};
    for (const [id, entry] of this.#tokens) {
      out[String(id)] = {
        token: entry.token,
        expiresAt: new Date(entry.expiresAt).toISOString(),
      };
    }
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify(out), { mode: 0o600 });
  }

  #privateKey(): string {
    return fs.readFileSync(this.#cfg.privateKeyPath, "utf-8");
  }

  async #appRequest<T>(path: string): Promise<T> {
    const jwt = signAppJwt(this.#cfg.appId, this.#privateKey());
    const res = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        `App request ${path} failed: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Every installation of this App, across user and org accounts. */
  async installations(): Promise<Installation[]> {
    if (this.#installations) return this.#installations;
    const raw = await this.#appRequest<
      { id: number; account: { login: string }; repository_selection: string }[]
    >("/app/installations");
    if (raw.length === 0) {
      throw new GitHubError(
        404,
        "The App has no installations. Install it on your account/org and grant it the target repos.",
      );
    }
    this.#installations = raw.map((i) => ({
      id: i.id,
      account: i.account.login,
      selection: i.repository_selection,
    }));
    return this.#installations;
  }

  /**
   * Map every reachable repo to the installation that can reach it.
   *
   * An App installed on both a user and an org has one installation per
   * account, each with its own token. Using the wrong one yields a confusing
   * 404, so routing is resolved up front.
   */
  async #buildRepoIndex(): Promise<Map<string, number>> {
    if (this.#repoIndex) return this.#repoIndex;
    const index = new Map<string, number>();
    for (const inst of await this.installations()) {
      try {
        const body = await this.requestAs<{ repositories: { full_name: string }[] }>(
          inst.id,
          "/installation/repositories?per_page=100",
        );
        for (const r of body.repositories) index.set(r.full_name, inst.id);
      } catch {
        // One unreachable installation must not hide the others.
      }
    }
    this.#repoIndex = index;
    return index;
  }

  /** Which installation can reach this repo, if any. */
  async installationForRepo(repo: string): Promise<number | undefined> {
    return (await this.#buildRepoIndex()).get(repo);
  }

  /** Mint (or reuse) a token for one installation. */
  async tokenFor(installationId: number): Promise<string> {
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

    const jwt = signAppJwt(this.#cfg.appId, this.#privateKey());
    const res = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        `Could not mint installation token: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    this.#tokens.set(installationId, {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    });
    this.#persistTokens();
    return body.token;
  }

  /** Token for whichever installation owns this repo. */
  async token(repo?: string): Promise<string> {
    if (repo) {
      const id = await this.installationForRepo(repo);
      if (id === undefined) {
        throw new GitHubError(
          404,
          `No installation of this App can reach ${repo}. Install it on ${repo.split("/")[0]} and grant that repo.`,
        );
      }
      return this.tokenFor(id);
    }
    const [first] = await this.installations();
    return this.tokenFor(first.id);
  }

  /** Issue a request against a specific installation. */
  async requestAs<T>(
    installationId: number,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    return this.#send<T>(await this.tokenFor(installationId), path, init);
  }

  async #send<T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      throw new GitHubError(
        res.status,
        `${init.method ?? "GET"} ${path} failed: ${res.status} ${await res.text()}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Request routed to the right installation.
   *
   * The owner/repo in a /repos/... path decides which token to use, so callers
   * never have to think about installation routing.
   */
  async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)/);
    return this.#send<T>(await this.token(m ? m[1] : undefined), path, init);
  }

  /** Every repo reachable across all installations. The effective allowlist. */
  async installedRepos(): Promise<string[]> {
    return [...(await this.#buildRepoIndex()).keys()];
  }

  async appSlug(): Promise<string> {
    if (this.#botLogin) return this.#botLogin;
    const app = await this.#appRequest<{ slug: string }>("/app");
    this.#botLogin = `${app.slug}[bot]`;
    return this.#botLogin;
  }

  /** Bot user id, needed to build the noreply commit email. */
  async botUserId(): Promise<number> {
    if (this.#botUserId !== undefined) return this.#botUserId;
    const login = await this.appSlug();
    const user = await this.request<{ id: number }>(
      `/users/${encodeURIComponent(login)}`,
    );
    this.#botUserId = user.id;
    return user.id;
  }

  async gitIdentity(): Promise<{ name: string; email: string }> {
    const login = await this.appSlug();
    const id = await this.botUserId();
    return { name: login, email: `${id}+${login}@users.noreply.github.com` };
  }

  async issuesWithLabel(repo: string, label: string): Promise<Issue[]> {
    const issues = await this.request<Issue[]>(
      `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100`,
    );
    // The issues endpoint also returns PRs; drop them.
    return issues.filter((i) => !i.pull_request);
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    return this.request<Issue>(`/repos/${repo}/issues/${number}`);
  }

  async issueComments(repo: string, number: number): Promise<Comment[]> {
    return this.request<Comment[]>(
      `/repos/${repo}/issues/${number}/comments?per_page=100`,
    );
  }

  async comment(repo: string, issue: number, body: string): Promise<Comment | undefined> {
    if (this.#cfg.dryRun) return undefined;
    return this.request<Comment>(`/repos/${repo}/issues/${issue}/comments`, {
      method: "POST",
      body: { body },
    });
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = await this.request<{ default_branch: string }>(`/repos/${repo}`);
    return r.default_branch;
  }

  async createPr(
    repo: string,
    opts: { title: string; body: string; head: string; base: string; draft: boolean },
  ): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${repo}/pulls`, {
      method: "POST",
      body: opts,
    });
  }

  async getPr(repo: string, number: number): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${repo}/pulls/${number}`);
  }

  async closePr(repo: string, number: number): Promise<void> {
    await this.request(`/repos/${repo}/pulls/${number}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
  }

  async markPrReady(repo: string, number: number): Promise<void> {
    // Marking a draft ready is GraphQL-only; the REST draft field is read-only.
    const pr = await this.getPr(repo, number);
    if (!pr.draft) return;
    const token = await this.token(repo);
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": UA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`,
        variables: { id: await this.#prNodeId(repo, number) },
      }),
    });
    if (!res.ok) throw new GitHubError(res.status, `markPrReady failed: ${await res.text()}`);
  }

  async #prNodeId(repo: string, number: number): Promise<string> {
    const pr = await this.request<{ node_id: string }>(`/repos/${repo}/pulls/${number}`);
    return pr.node_id;
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.request(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "DELETE",
      });
    } catch (e) {
      // Already gone (deleted on merge) is not an error worth surfacing.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
    }
  }

  async reviews(repo: string, number: number): Promise<Review[]> {
    return this.request<Review[]>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  }

  async reviewComments(repo: string, number: number): Promise<ReviewComment[]> {
    return this.request<ReviewComment[]>(
      `/repos/${repo}/pulls/${number}/comments?per_page=100`,
    );
  }

  async replyToReviewComment(
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    if (this.#cfg.dryRun) return;
    await this.request(
      `/repos/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { method: "POST", body: { body } },
    );
  }

  /** Roll up check runs and legacy commit statuses for a head SHA. */
  async checks(repo: string, sha: string): Promise<CheckSummary> {
    const runs = await this.request<{
      total_count: number;
      check_runs: {
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
      }[];
    }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);

    const status = await this.request<{
      state: string;
      statuses: { context: string; state: string; target_url: string | null }[];
    }>(`/repos/${repo}/commits/${sha}/status`);

    const failing: { name: string; url: string }[] = [];
    let pending = false;

    for (const run of runs.check_runs) {
      if (run.status !== "completed") {
        pending = true;
        continue;
      }
      if (run.conclusion === "failure" || run.conclusion === "timed_out") {
        failing.push({ name: run.name, url: run.html_url });
      }
    }
    for (const s of status.statuses) {
      if (s.state === "pending") pending = true;
      if (s.state === "failure" || s.state === "error") {
        failing.push({ name: s.context, url: s.target_url ?? "" });
      }
    }

    const total = runs.total_count + status.statuses.length;
    if (total === 0) return { conclusion: "none", failing: [], total: 0 };
    if (failing.length > 0) return { conclusion: "failure", failing, total };
    if (pending) return { conclusion: "pending", failing: [], total };
    return { conclusion: "success", failing: [], total };
  }

  /** Clone URL carrying the installation token so git can push as the App. */
  async authenticatedRemote(repo: string): Promise<string> {
    const token = await this.token(repo);
    return `https://x-access-token:${token}@github.com/${repo}.git`;
  }
}
