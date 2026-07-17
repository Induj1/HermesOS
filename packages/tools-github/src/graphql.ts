/**
 * The GraphQL client — a thin layer over the REST client's transport.
 *
 * GitHub's GraphQL API is one endpoint (`POST /graphql`) that always answers 200,
 * even for a query error, putting failures in an `errors` array in the body. So
 * the interesting work is not transport — {@link GitHubClient} already does auth,
 * retries, and rate limiting — but *turning a 200-with-errors into a thrown
 * error*, which a caller expects and REST semantics would otherwise hide.
 */

import type { GitHubClient } from './client.js';
import { GitHubError } from './errors.js';

export interface GraphQLError {
  readonly message: string;
  readonly type?: string;
  readonly path?: readonly (string | number)[];
}

export interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly GraphQLError[];
}

export class GraphQLClient {
  readonly #client: GitHubClient;

  constructor(client: GitHubClient) {
    this.#client = client;
  }

  /**
   * Run a query or mutation, returning its `data` or throwing on `errors`.
   *
   * A partial result — `data` *and* `errors` both present, which GraphQL permits
   * — is treated as a failure, because a caller that got half its fields and no
   * signal would use the missing half as `undefined` and be silently wrong. The
   * errors are attached for inspection.
   */
  async query<T>(
    query: string,
    variables?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const response = await this.#client.request<GraphQLResponse<T>>(
      'POST',
      '/graphql',
      {
        body: { query, ...(variables === undefined ? {} : { variables }) },
      },
    );

    const { data, errors } = response.data;
    if (errors !== undefined && errors.length > 0) {
      const summary = errors.map((e) => e.message).join('; ');
      throw new GitHubError('GRAPHQL_ERROR', `GraphQL error: ${summary}`, {
        response: errors,
      });
    }
    if (data === undefined) {
      throw new GitHubError('GRAPHQL_ERROR', 'GraphQL response contained no data', {
        response: response.data,
      });
    }
    return data;
  }
}
