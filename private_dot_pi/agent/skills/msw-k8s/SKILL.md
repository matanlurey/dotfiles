---
name: msw-k8s
description: >
  MSW Kubernetes cluster access, log inspection, and live incident triage.
  Covers AWS SSO profiles, kubectl contexts, MSW app namespaces, and common
  debugging commands for dev/stg/prd EKS clusters. Use when asked to check
  pod status, read logs, investigate crashes, inspect HPA scaling, or
  troubleshoot MSW services on Kubernetes.
---

# MSW Kubernetes Access & Incident Triage

## AWS SSO Profiles

Four profiles exist (run `aws configure list-profiles` to verify):

| Profile | Account | What's on it |
|---------|---------|--------------|
| `307246178335_AdministratorAccess` | 307246178335 | **MSW app namespaces** (dev + stg) |
| `mission-ops-prod` | 580044490602 | Platform infra only (authentik, monitoring, karpenter). No MSW app namespaces. |
| `mission-ops-pre-prod` | — | Mirrors prod. No MSW app namespaces. |
| `580044490602_Vast-ReadOnly` | 580044490602 | Read-only on the 580044490602 account |

The naming is misleading: `mission-ops-prod` does NOT have MSW services.
MSW apps only live on the `307246178335_AdministratorAccess` account (dev/stg
clusters). Production MSW deployments are not yet on the prd cluster.

## kubectl Contexts

| Context | Cluster | AWS Profile |
|---------|---------|-------------|
| `msw-dev` | Dev (307246178335) | `307246178335_AdministratorAccess` |
| `msw-stg` | Stg (307246178335) | `307246178335_AdministratorAccess` |
| `msw-prd` | Prd (580044490602) | `mission-ops-prod` |

Always prefix kubectl with the AWS profile:

```bash
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <namespace> <command>
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-stg -n <namespace> <command>
```

## SSO Login

If kubectl returns `Token has expired and refresh failed`:

```bash
aws sso login --profile 307246178335_AdministratorAccess
```

## MSW App Namespaces (dev/stg)

These namespaces contain MSW services on the dev and stg clusters:

| Namespace | Service |
|-----------|---------|
| `schema-registry` | Schema Registry (server + worker pods) |
| `codec` | Codec service |
| `commands` | Command server |
| `telemetry-server` | Telemetry server |
| `asset-registry` | Asset registry |
| `mops-ui` | MOPS UI |
| `telescope` | Telescope |
| `sine` | Sine data pipeline |
| `strimzi` | Kafka (Strimzi operator) |
| `temporal-worker-controller` | Temporal worker controller |
| `mds-observability` | Alloy/OTEL collector |
| `mds-ingress` | Ingress / gateway |

OTEL collector endpoint (for service configs):
`http://mds-observability-alloy.mds-observability.svc.cluster.local:4317`

## Triage Commands

All examples use dev. Replace `msw-dev` with `msw-stg` for staging.

```bash
# List pods with restart counts
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> get pods

# CPU/memory usage
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> top pods

# HPA status (scaling state, current vs desired replicas)
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> get hpa

# Live logs (last 50 lines)
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> logs <pod> --tail=50

# Previous container logs (after a crash/restart)
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> logs <pod> --previous

# Pod details (crash reason, resource limits, events)
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> describe pod <pod>

# Recent events in a namespace (sorted by time)
AWS_PROFILE=307246178335_AdministratorAccess kubectl --context msw-dev -n <ns> get events --sort-by='.lastTimestamp'
```

## Interpreting Crashes

When running `describe pod`, look at the **Last State** section:

| Exit Code | Reason | Meaning |
|-----------|--------|---------|
| 137 | OOMKilled | Pod exceeded its memory limit. Check resource requests/limits in the Helm values. |
| 1 | Error | Application error on startup. Check logs with `--previous` for the stack trace. |

Common crash patterns:
- **OOMKilled (137)**: Increase `resources.limits.memory` in the service's
  Helm values (`gitops-msw`).
- **Error (1) + missing env var**: A required environment variable is not set
  in the configmap. Check the service's `values.yaml` for the affected
  environment.
- **CrashLoopBackOff with high restart count**: The pod keeps crashing on
  startup. Use `logs --previous` to see what happened in the last attempt.

## GitOps Config

MSW uses ArgoCD + `Vast/gitops-msw`. See the `msw-deploy` skill for full
details. Quick reference for fetching live config:

```bash
# Service values (shared)
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/manifests/mds/<service>/values.yaml \
  --jq '.content' | base64 -d

# Environment-specific overrides
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/manifests/mds/<service>/dev/values.yaml \
  --jq '.content' | base64 -d

# Current image tag
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/gitops-msw/contents/manifests/mds/<service>/dev/tag.values.yaml \
  --jq '.content' | base64 -d
```

## Known Gotchas

- `mission-ops-prod` has no MSW app namespaces. If `kubectl get ns` shows only
  infra namespaces (authentik, monitoring, karpenter), you're on the wrong
  profile/context. Switch to `307246178335_AdministratorAccess` + `msw-dev`
  or `msw-stg`.
- OTLP is enabled by default in most MSW Go services. If the
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` env var is missing from the configmap,
  the service will fatal on startup (exit code 1). The endpoint should point to
  the `mds-observability` Alloy instance.
- Kafka buffer size changes (`INGRESS_BUFFER_SIZE`, `INTERNAL_BUFFER_SIZE`) can
  cause session timeouts and message redelivery loops. If a service is
  CPU-pegged with no code changes, check recent gitops commits for buffer size
  reductions.
