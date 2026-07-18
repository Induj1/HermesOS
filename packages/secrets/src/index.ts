/**
 * @hermes/secrets — Secret sourcing and leak-resistant handling.
 *
 * Wrap sensitive values in `Secret` so they never reach a log, an error, or a
 * JSON body by accident, and source them from where a deployment actually keeps
 * them — the environment, a mounted secret file, or a chain of both:
 *
 * ```ts
 * const source = new ChainSecretSource([
 *   new EnvSecretSource(process.env, nodeFileReader()), // NAME and NAME_FILE
 *   new FileSecretSource('/run/secrets', nodeFileReader()), // Docker mounts
 * ]);
 * const secrets = await loadSecretsOrThrow(source, ['OPENAI_API_KEY', 'DATABASE_URL']);
 * fetch(url, { headers: { authorization: `Bearer ${secrets.OPENAI_API_KEY.expose()}` } });
 * console.log(secrets); // { OPENAI_API_KEY: Secret([redacted]), ... }
 * ```
 *
 * The sources are pure functions of an injected env record and `FileReader`;
 * `nodeFileReader` (in `node.ts`) is the only piece that touches the filesystem.
 */

export { Secret, isSecret } from './secret.js';

export {
  ChainSecretSource,
  EnvSecretSource,
  FileSecretSource,
  MemorySecretSource,
  type EnvRecord,
  type FileReader,
  type SecretSource,
} from './source.js';

export {
  MissingSecretsError,
  loadOptionalSecret,
  loadSecrets,
  loadSecretsOrThrow,
  type SecretsResult,
} from './manager.js';

export { nodeFileReader } from './node.js';
