/**
 * The GraphQL client — turning a 200-with-errors into a thrown error.
 */

import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/client.js';
import { GraphQLClient } from '../src/graphql.js';
import { FakeGitHubServer, type FakeGitHubOptions } from '../src/fake-server.js';

const clientWith = (graphql: FakeGitHubOptions['graphql']): GraphQLClient => {
  const server = new FakeGitHubServer(graphql === undefined ? {} : { graphql });
  return new GraphQLClient(new GitHubClient({ http: server, userAgent: 't' }));
};

describe('GraphQLClient', () => {
  it('returns data on success', async () => {
    const gql = clientWith(() => ({ data: { viewer: { login: 'octocat' } } }));
    const data = await gql.query<{ viewer: { login: string } }>(
      'query { viewer { login } }',
    );
    expect(data.viewer.login).toBe('octocat');
  });

  it('passes variables through', async () => {
    const server = new FakeGitHubServer({
      graphql: (_q, variables) => ({ data: { vars: variables } }),
    });
    const gql = new GraphQLClient(new GitHubClient({ http: server, userAgent: 't' }));
    const data = await gql.query<{ vars: unknown }>('query($n:Int){x}', { n: 5 });
    expect(data.vars).toEqual({ n: 5 });
  });

  it('throws on a GraphQL errors array', async () => {
    const gql = clientWith(() => ({ errors: [{ message: 'Field does not exist' }] }));
    await expect(gql.query('query { nope }')).rejects.toMatchObject({
      code: 'GRAPHQL_ERROR',
    });
  });

  it('treats a partial result (data + errors) as a failure', async () => {
    const gql = clientWith(() => ({
      data: { x: 1 },
      errors: [{ message: 'partial' }],
    }));
    await expect(gql.query('query { x }')).rejects.toThrow(/partial/);
  });

  it('throws when there is neither data nor errors', async () => {
    const gql = clientWith(() => ({}));
    await expect(gql.query('query { x }')).rejects.toThrow(/no data/);
  });
});
