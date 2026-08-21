# Onboarding a New Service

Full walkthrough for adding a new service to the deployment pipeline.

## 1. Create a Helm Chart

In `mops-charts/charts/<service>/`:

```bash
cd mops-charts
./scripts/new-app.sh <service> "Description"
# Or with secrets: ./scripts/new-app.sh --with-secrets <service> "Description"
```

This creates a chart depending on `mds-base`. Configure:

- `Chart.yaml`: name, version (`0.1.0`), `mds-base` dependency
- `values.yaml`: defaults for all environments
- `linter_values.yaml`: minimal values that pass `helm lint`

For multi-service apps (e.g., server + worker + migration), alias `mds-base`
multiple times in `Chart.yaml`:

```yaml
dependencies:
  - name: mds-base
    version: "1.0.0"
    repository: https://artifactory.int.vastspace.com/vast-helm
    alias: server
  - name: mds-base
    version: "1.0.0"
    repository: https://artifactory.int.vastspace.com/vast-helm
    alias: worker
```

Run `helm dependency update` to pull dependencies. Verify with
`helm template .` and `helm lint -f linter_values.yaml`.

## 2. Publish the Chart

Open a PR to `mops-charts`. On merge to main, CI auto-publishes to
Artifactory (`vast-helmoci/<chart-name>`).

## 3. Add GitOps Manifests

In `gitops-msw/manifests/<team>/<service>/`:

```
manifests/<team>/<service>/
  ├── values.yaml              ← shared config (resources, ports, etc.)
  ├── dev/
  │   ├── values.yaml          ← dev-specific (hostnames, DB host, flags)
  │   └── tag.values.yaml      ← image tags only
  ├── stg/
  │   ├── values.yaml
  │   └── tag.values.yaml
  └── prd/
      ├── values.yaml
      └── tag.values.yaml
```

`tag.values.yaml` contains only image tags so automated tools can update
it without touching other config:

```yaml
server:
  application:
    image:
      tag: v1.0.0
```

## 4. Add ArgoCD Application

In `gitops-msw/apps/<env>/<team>/<service>.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <service>-msw-dev
  annotations:
    kargo.akuity.io/authorized-stage: "<kargo-project>:dev"
spec:
  project: msw-dev-<team>
  destination:
    namespace: <service>
    name: msw-dev
  sources:
    - repoURL: https://code.vastspace.com/Vast/gitops-msw.git
      targetRevision: main
      ref: gitops
    - repoURL: artifactory.int.vastspace.com/vast-helmoci
      chart: <service>
      targetRevision: 0.1.0
      helm:
        releaseName: <service>
        valueFiles:
          - $gitops/manifests/<team>/<service>/values.yaml
          - $gitops/manifests/<team>/<service>/dev/values.yaml
          - $gitops/manifests/<team>/<service>/dev/tag.values.yaml
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
```

Repeat for stg and prd with corresponding cluster names and value paths.

## 5. Add Kargo Project

In `gitops-msw/kargo/<service>/values.yaml`, define warehouses, stages,
promotion tasks, and RBAC. See `references/kargo.md` for the full schema
and example.

## 6. Set Up Secrets

Use `secrets-base` chart dependency for ExternalSecrets:

- Doppler: add a `serviceTokenSecretName` in the env values
- AWS Secrets Manager: configure IRSA and secret paths

Secrets are fetched by ExternalSecrets Operator at runtime, not stored in Git.

## 7. Set Up Networking

In the service's env values, enable the ListenerSet:

```yaml
server:
  listenerSet:
    enabled: true
    annotations:
      cert-manager.io/cluster-issuer: internal-letsencrypt-prod
    listeners:
      <service>:
        hostname: <service>-dev.int.vastspace.com

  httpRoute:
    hostnames:
      - <service>-dev.int.vastspace.com

  grpcRoute:   # if the service exposes gRPC
    hostnames:
      - <service>-dev.int.vastspace.com
```

cert-manager handles TLS certificate provisioning automatically.

## Checklist

- [ ] Helm chart in mops-charts, published to Artifactory
- [ ] Base + per-env values in gitops manifests
- [ ] ArgoCD Application YAML for each environment
- [ ] Kargo project with warehouses, stages, promotion tasks
- [ ] `kargo.akuity.io/authorized-stage` annotation on each Application
- [ ] Secrets configured (Doppler/Infisical ExternalSecrets)
- [ ] Networking (ListenerSet + HTTPRoute/GRPCRoute)
- [ ] CI pipeline in source repo (build image, push to Artifactory)
