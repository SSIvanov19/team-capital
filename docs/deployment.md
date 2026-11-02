# Production

Public game: https://team-capital.dressr.fashion

Source: https://github.com/SSIvanov19/team-capital

GitOps manifests and operating instructions: https://github.com/SSIvanov19/TC.Deployment

Pull requests run lint, type checking, automated rules/API tests, a production build and browser tests on Node 24. Successful main builds smoke-test the Linux AMD64 container, publish a commit-tagged GHCR image, then update the deployment repository with its immutable digest. Argo CD reconciles that commit on dressr-vm-k8s. Ordinary releases use no Kubernetes or SSH credentials.

Production uses a fresh SQLite database on a persistent volume, with one application replica. Rollbacks revert the image digest in the deployment repository and keep the volume. Package visibility is public; registry credentials are not required by the cluster. The deployment repository remains private, with separate CI-write and Argo-read deploy keys.

Database backup, restore, bootstrap and shared Cloudflare routing procedures are maintained in TC.Deployment. Runtime data and credentials must never be committed to either repository.

Run `npm run smoke:production` manually against production, or set `SMOKE_URL` for another HTTPS deployment. It creates two test teams (2 and 3 players) and completes all five rounds using actual server timers. It checks saved votes, private clues, shared events, balances and ranks; allow about six minutes fifteen seconds. The report goes to the ignored `output/production-smoke.json`.
