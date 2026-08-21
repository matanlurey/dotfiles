---
name: msw-deploy
description: >
  MSW deployment operations: deploying, promoting, and rolling back services
  across dev/stg/prd environments using GitOps (ArgoCD), Helm charts
  (mops-charts), and Kargo promotion pipelines. Use when asked to deploy a
  service, promote a version, roll back, onboard a new service, update Helm
  charts, or debug deployment issues.
---

# MSW Deployment Operations

## Architecture at a Glance

MSW runs ~20 services on EKS (AWS GovCloud) across three environments.
All deployments are GitOps: merge a PR, ArgoCD syncs the cluster.

```
Source repo (git tag) → GHA CI (build image + chart) → Artifactory
    → Kargo detects new version → opens PR to gitops repo
    → PR merged → ArgoCD syncs cluster
```

### Environments

| Env | Cluster | Promotion |
|-----|---------|-----------|
| **dev** | `msw-dev` | Auto-promote newest builds |
| **stg** | `msw-stg` | Auto-promote tagged releases (usually) |
| **prd** | `msw-prd` | Manual gate, human approval |

### Key Repos

| Repo | Purpose |
|------|---------|
| `gitops-msw` | MDS + MAS app deployments (dev/stg/prd) |
| `gitops-appeng` | Sine API, porygon2-writer (stg/prd) |
| `gitops-devops` | Cluster platform (ArgoCD, Kargo, tenants) |
| `mops-charts` | Shared Helm charts (`mds-base`, `secrets-base`, app charts) |

All repos live in the `Vast` org on `code.vastspace.com`. Use
`GH_HOST=code.vastspace.com gh ...` for API access.

## Common Operations

### Deploy a new version to dev

**With Kargo** (most services): Tag a release in the source repo (`v1.2.3`).
CI builds and pushes to Artifactory. Kargo detects it, opens a PR to the
gitops repo, and auto-merges for dev. ArgoCD syncs. Zero human steps.

**Without Kargo** (manual): Open a PR to the gitops repo updating
`tag.values.yaml` (image tag) and the Application's `targetRevision`
(chart version). Merge. ArgoCD syncs.

### Promote dev → stg

If `autoPromotionEnabled: true` for stg (the default for most services),
Kargo handles it automatically after dev succeeds.

Otherwise: Kargo UI → find the freight → click Promote to stg. Kargo opens
a PR. Review and merge.

### Promote stg → prd

1. Verify the version has soaked in stg.
2. Kargo UI → find the freight verified in stg → Promote to prd.
3. Kargo opens a PR. Review it carefully.
4. Merge. ArgoCD syncs. Monitor the rollout.

For the full checklist, read `references/production-checklist.md`.

### Roll back

1. Find the gitops PR that deployed the broken version.
2. Revert that PR (`git revert` or GitHub UI).
3. Merge the revert. ArgoCD syncs the previous version.

Artifacts are immutable in Artifactory, so the old image is still there.
No rebuild needed.

### Update a Helm chart

1. Edit in `mops-charts/charts/<chart>/`.
2. Bump version in `Chart.yaml` (semver: breaking → MAJOR, feature → MINOR, fix → PATCH).
3. Update CHANGELOG.md for library charts.
4. `helm lint` and `helm template` locally.
5. Open PR → CI validates. Merge → auto-publishes to Artifactory.
6. Consumers update their dependency version + `helm dependency update`.

## GitOps Repo Structure

For details on the App of Apps pattern, ArgoCD Application anatomy, values
layering, and CI validation, read `references/gitops-structure.md`.

## Kargo Promotion System

For details on Warehouses, Stages, Freight, promotion tasks, self-service
onboarding, and RBAC, read `references/kargo.md`.

## Onboarding a New Service

For the full walkthrough of adding a new service (chart, gitops manifests,
Kargo project, networking, secrets), read `references/new-service.md`.

## Helm Chart Library

For details on the `mds-base` and `secrets-base` library charts, the
multi-service pattern, built-in integrations, and versioning rules,
read `references/helm-charts.md`.

## Fetching Live Config

When you need to inspect actual deployed state or current config:

```bash
# Get an ArgoCD Application manifest
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/apps/dev/mds/schema-registry.yaml \
  --jq '.content' | base64 -d

# Get a service's environment values
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/manifests/mds/schema-registry/dev/values.yaml \
  --jq '.content' | base64 -d

# Get the current image tag for a service/env
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/manifests/mds/schema-registry/dev/tag.values.yaml \
  --jq '.content' | base64 -d

# Get the Kargo project config
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/kargo/schema-registry/values.yaml \
  --jq '.content' | base64 -d

# List services deployed in an environment
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/apps/dev/mds --jq '.[].name'

# Check recent promotion PRs
GH_HOST=code.vastspace.com gh search prs "promote" -R Vast/gitops-msw \
  --sort=updated --limit=10 --json title,url,state,updatedAt
```

Replace `gitops-msw` with `gitops-appeng` for Sine-specific services.

## Who to Ask

| Topic | People |
|-------|--------|
| Kargo | Anthony Inlavong, Michael Fedell |
| Helm charts | Ethan Totten, Ryan Mangum |
| Cluster/platform | Michael Fedell, Benjamin Leeds |
| Sine deployments | Ethan Totten |
| MDS backend | Ryan Mangum |
