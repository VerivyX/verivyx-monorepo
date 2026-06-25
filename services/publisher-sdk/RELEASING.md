# Releasing the Verivyx Publisher SDK

This document covers how to publish all four packages in this workspace to npm, either manually or via CI (GitHub Actions Trusted Publishing).

## Packages (publish in this order)

| Package | Workspace path |
|---|---|
| `@verivyx/paywall` | `packages/core` |
| `@verivyx/paywall-express` | `packages/express` |
| `@verivyx/paywall-next` | `packages/next` |
| `@verivyx/paywall-hono` | `packages/hono` |

Core must be published before the adapters because each adapter declares `@verivyx/paywall@^0.1.0` as a direct `dependencies` entry. If core is not yet on the registry when an adapter is published, consumers will not be able to resolve it.

---

## Prerequisites

- An npm account that belongs to the `@verivyx` org with publish rights.
- Either:
  - An npm **auth token** with `publish` scope set as the `NPM_TOKEN` environment variable (manual path), or
  - **npm Trusted Publishing** (OIDC) configured on npmjs.com for each package AND on the GitHub repository (CI path — see below).

---

## Version bumps

For 0.x releases, bump all four packages **in lockstep**: keep `packages/core/package.json`, `packages/express/package.json`, `packages/next/package.json`, and `packages/hono/package.json` at the same version. Each adapter's dependency on the core (`@verivyx/paywall`) should be updated to reference the new published version before publishing.

---

## Manual publish path

Run all commands from `services/publisher-sdk/`.

### 1. Install dependencies

```bash
npm ci
```

### 2. Build all packages

```bash
npm -w packages/core run build
npm -w packages/express run build
npm -w packages/next run build
npm -w packages/hono run build
```

### 3. Publish in order

```bash
npm publish -w packages/core --access public
npm publish -w packages/express --access public
npm publish -w packages/next --access public
npm publish -w packages/hono --access public
```

Ensure `NPM_TOKEN` is set in your environment or that you are already authenticated via `npm login`.

---

## CI path (GitHub Actions Trusted Publishing)

CI publishing is **not committed by default** (no workflow file lives in the repo). To enable it, create `.github/workflows/release.yml` with the recipe below; then pushing a tag matching `sdk-v*` (e.g. `sdk-v0.2.0`) publishes all four packages using OIDC provenance (no long-lived npm token needed).

```yaml
name: Release SDK
on:
  push:
    tags: ["sdk-v*"]
permissions:
  contents: read
  id-token: write          # npm Trusted Publishing (OIDC) + provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/publisher-sdk
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm -w packages/core run build
      - run: npm -w packages/express run build
      - run: npm -w packages/next run build
      - run: npm -w packages/hono run build
      - run: npm publish -w packages/core --provenance --access public
      - run: npm publish -w packages/express --provenance --access public
      - run: npm publish -w packages/next --provenance --access public
      - run: npm publish -w packages/hono --provenance --access public
```

**This workflow is inert until you complete the one-time Trusted-Publishing setup below.**

### One-time setup: enable Trusted Publishing on npmjs

For each of the four packages, go to the package settings on npmjs.com and add a Trusted Publishing entry pointing to this GitHub repository. Repeat for:

- `@verivyx/paywall`
- `@verivyx/paywall-express`
- `@verivyx/paywall-next`
- `@verivyx/paywall-hono`

Until this is done, the workflow will fail with an OIDC authentication error. Use the manual path above in the meantime.

### Triggering a release

Once Trusted Publishing is configured:

```bash
git tag sdk-v0.2.0
git push origin sdk-v0.2.0
```

The workflow checks out the repo, installs dependencies, builds every package, then publishes core → express → next → hono with `--provenance`.

---

## First-publish checklist

- [ ] Core package is **not yet on the registry** (first publish must use `--access public`).
- [ ] Bump all four `package.json` files to the same version.
- [ ] Build all packages (`npm ci` + four build commands above).
- [ ] Publish `packages/core` first and confirm it appears on the registry.
- [ ] Publish `packages/express`, `packages/next`, `packages/hono` in any order after core is live.
- [ ] Verify each package resolves correctly: `npm info @verivyx/paywall` etc.
