# Production Deployment Checklist

From `Vast/docusaurus/standards/production-deployment.md`. Fetch the
latest version:

```bash
GH_HOST=code.vastspace.com gh api \
  /repos/Vast/docusaurus/contents/docs/software-internal/mission-software/standards/production-deployment.md \
  --jq '.content' | base64 -d
```

## One-Time Setup (before first prod deployment)

### Access and Repository
- [ ] CODEOWNERS configured for production files
- [ ] Branch protection: require PR, 1 approval, dismiss stale approvals,
      require status checks, require up-to-date, require conversation
      resolution, no force pushes
- [ ] No individual developers have admin access

### Artifacts and Process
- [ ] Artifacts categorized as configuration, state, or software
- [ ] Standard promotion and rollback procedure documented
- [ ] Rollback possible without rebuilding code
- [ ] State recovery process documented

### Observability
- [ ] Logs flowing to central observability
- [ ] Key metrics identified, documented, sent to central observability
- [ ] Alerting configured for downtime indicators
- [ ] Observability scoped to application guarantees/requirements

### Infrastructure and GitOps
- [ ] Infra and app deployment defined in Git
- [ ] Continuous reconciliation (ArgoCD AutoSync)
- [ ] GHA pipeline builds, versions, and publishes artifacts to Artifactory
- [ ] Compute resource requests and limits set

### Documentation and Ownership
- [ ] Runbooks written for common admin actions
- [ ] Software registered in the service catalog
- [ ] Responsible Engineer (RE) identified
- [ ] On-call schedule established (if warranted)

## Per-Release Promotion

### Automated
- [ ] Regression tests pass in staging
- [ ] Performance measured, no unacceptable regressions
- [ ] Artifact built, tagged, sourced from `main`

### Manual
- [ ] Running successfully in staging for an extended duration
- [ ] Acceptance/smoke tests performed in staging
- [ ] Stakeholders notified of deployment window with lead time
- [ ] Rollback plan documented (including deviations from standard)
- [ ] Infisical change requests approved for secret/config changes

### Documentation Updates
- [ ] Design doc updated (if applicable)
- [ ] User-facing docs updated (if applicable)
- [ ] Release notes written
- [ ] Runbook updated (if applicable)
- [ ] Triage matrix updated (if applicable)
