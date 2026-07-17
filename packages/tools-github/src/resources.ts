/**
 * The resource APIs — typed wrappers over the REST client for the objects an
 * agent actually works with: repositories, issues, pull requests, workflow runs,
 * and releases.
 *
 * These are deliberately thin. Each method builds a path, calls
 * {@link GitHubClient.request} or {@link GitHubClient.paginate}, and types the
 * result — no caching, no cleverness. The value is in the *shape*: a caller
 * writes `github.pulls.merge(owner, repo, 7)` instead of remembering that a merge
 * is `PUT /repos/{o}/{r}/pulls/{n}/merge`, and gets a typed body back. The full
 * surface of GitHub is enormous; this covers the common lifecycle and extends by
 * the same pattern.
 *
 * The types below carry the fields the tools use, not every field GitHub returns
 * — a response has more, and a caller that needs an uncovered field reads it off
 * the untyped extra via a widening cast, or the type grows. They are documentation
 * of what is relied on, not an exhaustive schema.
 */

import type { GitHubClient } from './client.js';
import { GraphQLClient } from './graphql.js';

export interface Repository {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch: string;
  readonly html_url: string;
}

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly body: string | null;
  readonly html_url: string;
}

export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
  readonly html_url: string;
}

export interface WorkflowRun {
  readonly id: number;
  readonly name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly head_branch: string | null;
  readonly html_url: string;
}

export interface Release {
  readonly id: number;
  readonly tag_name: string;
  readonly name: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly html_url: string;
}

const enc = encodeURIComponent;

/**
 * A typed facade over a {@link GitHubClient}, grouped by resource.
 *
 * ```ts
 * const github = new GitHub(client);
 * const repo = await github.repos.get('octocat', 'hello-world');
 * for await (const issue of github.issues.list('octocat', 'hello-world', { state: 'open' })) { ... }
 * ```
 */
export class GitHub {
  readonly #client: GitHubClient;
  /** The GraphQL client sharing this facade's transport and auth. */
  readonly graphql: GraphQLClient;

  constructor(client: GitHubClient) {
    this.#client = client;
    this.graphql = new GraphQLClient(client);
  }

  get repos() {
    const client = this.#client;
    return {
      async get(
        owner: string,
        repo: string,
        signal?: AbortSignal,
      ): Promise<Repository> {
        const res = await client.request<Repository>(
          'GET',
          `/repos/${enc(owner)}/${enc(repo)}`,
          sig(signal),
        );
        return res.data;
      },
      listBranches(
        owner: string,
        repo: string,
        signal?: AbortSignal,
      ): AsyncGenerator<{ name: string }> {
        return client.paginate<{ name: string }>(
          `/repos/${enc(owner)}/${enc(repo)}/branches`,
          sig(signal),
        );
      },
    };
  }

  get issues() {
    const client = this.#client;
    return {
      list(
        owner: string,
        repo: string,
        options: { state?: 'open' | 'closed' | 'all'; signal?: AbortSignal } = {},
      ): AsyncGenerator<Issue> {
        return client.paginate<Issue>(`/repos/${enc(owner)}/${enc(repo)}/issues`, {
          query: { state: options.state ?? 'open' },
          ...sig(options.signal),
        });
      },
      async get(
        owner: string,
        repo: string,
        number: number,
        signal?: AbortSignal,
      ): Promise<Issue> {
        const res = await client.request<Issue>(
          'GET',
          `/repos/${enc(owner)}/${enc(repo)}/issues/${String(number)}`,
          sig(signal),
        );
        return res.data;
      },
      async create(
        owner: string,
        repo: string,
        input: { title: string; body?: string; labels?: readonly string[] },
        signal?: AbortSignal,
      ): Promise<Issue> {
        const res = await client.request<Issue>(
          'POST',
          `/repos/${enc(owner)}/${enc(repo)}/issues`,
          {
            body: input,
            ...sig(signal),
          },
        );
        return res.data;
      },
      async comment(
        owner: string,
        repo: string,
        number: number,
        body: string,
        signal?: AbortSignal,
      ): Promise<{ id: number }> {
        const res = await client.request<{ id: number }>(
          'POST',
          `/repos/${enc(owner)}/${enc(repo)}/issues/${String(number)}/comments`,
          { body: { body }, ...sig(signal) },
        );
        return res.data;
      },
    };
  }

  get pulls() {
    const client = this.#client;
    return {
      list(
        owner: string,
        repo: string,
        options: { state?: 'open' | 'closed' | 'all'; signal?: AbortSignal } = {},
      ): AsyncGenerator<PullRequest> {
        return client.paginate<PullRequest>(`/repos/${enc(owner)}/${enc(repo)}/pulls`, {
          query: { state: options.state ?? 'open' },
          ...sig(options.signal),
        });
      },
      async get(
        owner: string,
        repo: string,
        number: number,
        signal?: AbortSignal,
      ): Promise<PullRequest> {
        const res = await client.request<PullRequest>(
          'GET',
          `/repos/${enc(owner)}/${enc(repo)}/pulls/${String(number)}`,
          sig(signal),
        );
        return res.data;
      },
      async create(
        owner: string,
        repo: string,
        input: {
          title: string;
          head: string;
          base: string;
          body?: string;
          draft?: boolean;
        },
        signal?: AbortSignal,
      ): Promise<PullRequest> {
        const res = await client.request<PullRequest>(
          'POST',
          `/repos/${enc(owner)}/${enc(repo)}/pulls`,
          {
            body: input,
            ...sig(signal),
          },
        );
        return res.data;
      },
      async merge(
        owner: string,
        repo: string,
        number: number,
        options: {
          method?: 'merge' | 'squash' | 'rebase';
          commitTitle?: string;
          signal?: AbortSignal;
        } = {},
      ): Promise<{ merged: boolean; sha: string }> {
        const res = await client.request<{ merged: boolean; sha: string }>(
          'PUT',
          `/repos/${enc(owner)}/${enc(repo)}/pulls/${String(number)}/merge`,
          {
            body: {
              merge_method: options.method ?? 'merge',
              ...(options.commitTitle === undefined
                ? {}
                : { commit_title: options.commitTitle }),
            },
            ...sig(options.signal),
          },
        );
        return res.data;
      },
    };
  }

  get actions() {
    const client = this.#client;
    return {
      listWorkflowRuns(
        owner: string,
        repo: string,
        signal?: AbortSignal,
      ): AsyncGenerator<WorkflowRun> {
        // The runs endpoint wraps its list in `{ total_count, workflow_runs }`,
        // so tell `paginate` which key the array lives under.
        return client.paginate<WorkflowRun>(
          `/repos/${enc(owner)}/${enc(repo)}/actions/runs`,
          {
            itemsKey: 'workflow_runs',
            ...sig(signal),
          },
        );
      },
      async dispatchWorkflow(
        owner: string,
        repo: string,
        workflowId: string | number,
        input: { ref: string; inputs?: Readonly<Record<string, string>> },
        signal?: AbortSignal,
      ): Promise<void> {
        await client.request<string>(
          'POST',
          `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${enc(String(workflowId))}/dispatches`,
          { body: input, ...sig(signal) },
        );
      },
    };
  }

  get releases() {
    const client = this.#client;
    return {
      list(owner: string, repo: string, signal?: AbortSignal): AsyncGenerator<Release> {
        return client.paginate<Release>(
          `/repos/${enc(owner)}/${enc(repo)}/releases`,
          sig(signal),
        );
      },
      async create(
        owner: string,
        repo: string,
        input: {
          tag_name: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
        },
        signal?: AbortSignal,
      ): Promise<Release> {
        const res = await client.request<Release>(
          'POST',
          `/repos/${enc(owner)}/${enc(repo)}/releases`,
          {
            body: input,
            ...sig(signal),
          },
        );
        return res.data;
      },
    };
  }
}

function sig(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
