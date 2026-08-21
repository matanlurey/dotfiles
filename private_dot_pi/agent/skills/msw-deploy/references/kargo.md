# Kargo Promotion System

Kargo is a continuous promotion engine that sits on top of ArgoCD. ArgoCD
handles "deploy what's in Git." Kargo handles "update what's in Git when
new artifacts appear."

## Core Concepts

### Warehouses

Watch Artifactory for new chart/image versions and create **Freight**
(a bundle of specific versions).

Standard pattern uses two warehouses per service:

- **`<name>-newest`**: `imageSelectionStrategy: NewestBuild` for dev
  (every CI build)
- **`<name>`**: `imageSelectionStrategy: SemVer` for stg/prd (tagged
  releases only)

```yaml
warehouses:
  schema-registry-newest:
    freightCreationPolicy: Automatic
    subscriptions:
      - chart:
          repoURL: oci://artifactory.int.vastspace.com/vast-helmoci/schema-registry
      - image:
          repoURL: artifactory.int.vastspace.com/vast-docker/schema-registry-server
          imageSelectionStrategy: NewestBuild
          discoveryLimit: 5

  schema-registry:
    freightCreationPolicy: Automatic
    subscriptions:
      - chart:
          repoURL: oci://artifactory.int.vastspace.com/vast-helmoci/schema-registry
      - image:
          repoURL: artifactory.int.vastspace.com/vast-docker/schema-registry-server
          imageSelectionStrategy: SemVer
          discoveryLimit: 5
```

### Stages

Define the promotion pipeline. Each stage pulls freight from a warehouse
(direct) or from a previous stage (must be verified there first).

```
Warehouse: newest ──► dev (auto) ──┐
                                    │ verified in dev
Warehouse: semver ─────────────────► stg (auto) ──► prd (manual gate)
```

### Promotion Policies

```yaml
promotionPolicies:
  - stageSelector: { name: dev }
    autoPromotionEnabled: true
  - stageSelector: { name: stg }
    autoPromotionEnabled: true
  - stageSelector: { name: prd }
    autoPromotionEnabled: false   # requires manual click in Kargo UI
```

### Promotion Tasks

The standard `promote-via-pr` task runs these steps:

1. `git-clone` the gitops repo
2. `yaml-update` chart version in the ArgoCD Application (`targetRevision`)
3. `yaml-update` image tags in `tag.values.yaml`
4. `git-commit` with message like `chore(promote): schema-registry/dev`
5. `git-push` to branch `kargo/promotion/<name>`
6. `git-open-pr` titled `DVOP-000: 🚀 promote <chart>:<ver> / <image>:<tag>`
7. `git-wait-for-pr` until merged
8. `argocd-update` to trigger sync

PRs from Kargo appear as `argocd-operator[bot]`.

## Self-Service Onboarding

Add a values file at `<gitops-repo>/kargo/<project>/values.yaml`:

```yaml
tenant: mds
project: schema-registry

promotionPolicies:
  - stageSelector: { name: dev }
    autoPromotionEnabled: true
  - stageSelector: { name: prd }
    autoPromotionEnabled: false

roles:
  admins:
    groups: ["msw::devops", "msw::mds"]
  promoters:
    groups: ["msw::mas", "msw::mds"]
  viewers:
    groups: ["msw"]

warehouses:
  # define subscriptions...

stages:
  dev:
    requestedFreight:
      - origin: { kind: Warehouse, name: <name>-newest }
        sources: { direct: true }
    promotionTemplate:
      spec:
        steps:
          - task: { name: promote-via-pr }
            as: promote
            vars:
              - name: repoURL
                value: https://code.vastspace.com/Vast/gitops-msw
              - name: appManifestPath
                value: ./repo/apps/dev/mds/<service>.yaml
              - name: imageTagValues
                value: ./repo/manifests/mds/<service>/dev/tag.values.yaml
              - name: chartRepoURL
                value: oci://artifactory.int.vastspace.com/vast-helmoci/<chart>
              - name: imageRepoURL
                value: artifactory.int.vastspace.com/vast-docker/<image>
              - name: argoAppName
                value: <service>-msw-dev

promotionTasks:
  promote-via-pr:
    # steps defined in full above
```

An ApplicationSet in `gitops-devops` watches `kargo/*/values.yaml` across
all tenant repos and deploys the Kargo resources automatically. No DevOps
ticket needed.

Also add the `kargo.akuity.io/authorized-stage` annotation to each ArgoCD
Application that Kargo will promote:

```yaml
annotations:
  kargo.akuity.io/authorized-stage: "schema-registry:dev"
```

## RBAC Roles

| Role | Access |
|------|--------|
| `admins` | Full CRUD on all project resources |
| `promoters` | Can promote all stages (except prd by default) |
| `viewers` | Read-only |
| `stagePromoters.<stage>` | Can only promote the named stage |

Roles bind to OIDC groups (`msw::devops`, `msw::mds`, etc.).

## Kargo vs ArgoCD Image Updater

| Feature | Image Updater | Kargo |
|---------|--------------|-------|
| Track images | Yes | Yes |
| Track Helm charts | No | Yes |
| Multi-stage pipeline | No | Yes |
| PR-based promotion | No | Yes |
| Freight bundling | No | Yes |
| RBAC | No | Yes |

Image Updater is still used for simple dev-only apps (docusaurus, blueprint).
Kargo is for anything promoted through multiple environments.
