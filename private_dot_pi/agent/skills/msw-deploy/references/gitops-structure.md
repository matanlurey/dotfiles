# GitOps Repo Structure

## App of Apps Pattern

A root ArgoCD Application watches the `apps/` directory. Adding a service
is adding a YAML file.

```
apps/
  ├── dev/
  │   ├── common/     ← shared infra (secrets operators, etc.)
  │   ├── mas/        ← MAS team apps (telescope, blueprint, avit-web)
  │   ├── mds/        ← MDS team apps (schema-registry, codec, commands, ...)
  │   └── preview/    ← ephemeral preview envs
  ├── stg/
  │   ├── common/
  │   ├── mas/
  │   └── mds/
  └── prd/
      ├── common/
      ├── mas/
      └── mds/
```

## ArgoCD Application Anatomy

Each YAML file in `apps/` declares a Helm release with multi-source values:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: schema-registry-msw-dev
  annotations:
    kargo.akuity.io/authorized-stage: "schema-registry:dev"
spec:
  project: msw-dev-mds       # RBAC boundary
  destination:
    namespace: schema-registry
    name: msw-dev             # cluster reference
  sources:
    # Source 1: gitops repo (for values files)
    - repoURL: https://code.vastspace.com/Vast/gitops-msw.git
      targetRevision: main
      ref: gitops

    # Source 2: Helm chart from Artifactory
    - repoURL: artifactory.int.vastspace.com/vast-helmoci
      chart: schema-registry
      targetRevision: 1.0.1   # ← Kargo updates this
      helm:
        releaseName: schema-registry
        valueFiles:
          - $gitops/manifests/mds/schema-registry/values.yaml       # base
          - $gitops/manifests/mds/schema-registry/dev/values.yaml    # env override
          - $gitops/manifests/mds/schema-registry/dev/tag.values.yaml # image tags
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
```

The `sources` array separates "what chart to deploy" (from Artifactory) from
"how to configure it" (values from the gitops repo).

## Values Layering

Each service has a base values file plus per-environment overrides:

```
manifests/mds/schema-registry/
  ├── values.yaml              ← shared defaults (replicas, resources)
  ├── dev/
  │   ├── values.yaml          ← dev-specific (hostnames, DB endpoints)
  │   └── tag.values.yaml      ← image tags (updated by Kargo)
  ├── stg/
  │   ├── values.yaml
  │   └── tag.values.yaml
  └── prd/
      ├── values.yaml
      └── tag.values.yaml
```

`tag.values.yaml` is isolated so that automated tools only touch image tags,
keeping diffs minimal and reviewable.

## CI Validation

| Check | What it does |
|-------|--------------|
| **kube-linter** | Validates Kubernetes manifests for best practices |
| **helm lint + docs-check** | Lints charts, checks README freshness |
| **version-check** | Requires Chart.yaml version bump for `charts/` changes |
| **ArgoCD diff preview** | Renders before/after manifests and shows the diff |

## Cluster Enrollment

Clusters are enrolled with ArgoCD via Terraform in
`gitops-msw/terraform/{dev,stg,prd}/main.tf`.

## gitops-appeng

Sine API and porygon2-writer use `gitops-appeng` (separate appeng clusters).
The structure is identical but with `apps/{stg,prd}/` (no dev directory;
dev is handled differently for Sine).
