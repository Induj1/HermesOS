# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's **Security** tab), or contact
the maintainers privately if that is not available.

Please include:

- a description of the vulnerability and its impact,
- the affected component (package/app/service) and version or commit,
- minimal steps to reproduce, and
- any suggested remediation.

We will acknowledge your report, work with you on a fix, and coordinate a
disclosure timeline. Please give us reasonable time to remediate before any
public disclosure.

## Scope

HermesOS is a monorepo of composable subsystems. Security-relevant surfaces and
the controls at each are documented in
[`docs/security/audit.md`](docs/security/audit.md), and a point-in-time review
is recorded in [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md). In brief, the design
leans on:

- **argv-not-shell** command execution (`@hermes/tools-shell`),
- **path rooting** with no realpath TOCTOU (`@hermes/tools-fs`,
  `@hermes/tools-git`),
- an **SSRF policy** re-checked on every redirect (`@hermes/tools-http`),
- **constant-time** credential/signature comparison (`@hermes/auth`,
  `@hermes/telegram`, `@hermes/tools-github`),
- **default-deny, deny-override** authorization (`@hermes/authz`),
- **secret redaction** by construction (`@hermes/secrets`, `@hermes/config`),
- crypto-quality randomness for ids and trace/span identifiers.

## Supported versions

Until a tagged release exists, `main` is the supported line. After the first
release, this section will list the versions that receive security fixes.
