# Private deployment guide

This guide migrates the CookOrder level-design tool from public GitHub Pages to a private GitHub repository with automatic Cloudflare Pages deployment and server-side email access control.

The target architecture is:

```text
Private GitHub repository
        |
        | push to master / pull request
        v
Cloudflare Pages CI/CD
        |
        v
Cloudflare Access exact-email allowlist
        |
        v
Vite application, bundled JSON, and bundled CSV
        |
        v
Google OAuth + private Google Sheet sharing
```

Cloudflare Access is the security boundary. It authenticates a visitor before Cloudflare serves `index.html`, JavaScript, JSON, CSV, or images. Do not replace it with a password check implemented only in browser JavaScript; a technical user can bypass a client-side check or request the assets directly.

## What this setup guarantees

- The source repository is visible only to approved GitHub collaborators.
- Pushes to `master` automatically build and deploy the application.
- Pull-request and branch previews can use the same authentication protection.
- Only email addresses in the Cloudflare Access policy can download the deployed application or its bundled level data.
- Only Google accounts shared on the Google Sheet can read or write live Sheet data.

An authorized user can still copy data that the application permits them to view. No browser-based system can prevent an authorized reader from using developer tools, saving network responses, or taking screenshots.

## Cost and expected limits

This setup is intended for a team of fewer than 10 people:

- GitHub private repository: available on GitHub's free plan.
- Cloudflare Pages: free tier is sufficient for this Vite application.
- Cloudflare Access / Zero Trust: free for up to 50 users at the time this guide was written.
- A custom domain is optional. The generated `PROJECT.pages.dev` hostname can be protected.

Review current limits before migration:

- [Cloudflare plans](https://www.cloudflare.com/plans/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

## Phase 0: information and access to prepare

Complete this section before changing the repository or deployment.

### 0.1 Collect the approved-user list

Create the exact list of people allowed to use the deployed tool:

```text
owner@example.com
designer1@example.com
designer2@example.com
```

Use individual addresses instead of allowing an entire public domain such as `@gmail.com`. Keep this list in a private administrative location, not in the repository.

Decide separately who needs source-code access. Application users do not need to be GitHub collaborators.

### 0.2 Confirm GitHub permissions

The person performing the migration needs:

- Admin access to `vuquangdai9x/vuquangdai9x-CookOrder-WebDesignTool`.
- Permission to change repository visibility.
- Permission to manage GitHub Pages and Actions.
- Permission to install or authorize the Cloudflare GitHub App for this repository.

Turn on two-factor authentication for the GitHub account before continuing.

### 0.3 Create and secure a Cloudflare account

1. Create an account at [Cloudflare](https://dash.cloudflare.com/sign-up).
2. Verify the account email.
3. Turn on two-factor authentication under the Cloudflare profile's authentication settings.
4. In the Cloudflare dashboard, open **Zero Trust**.
5. Create the Zero Trust organization/team when prompted.
6. Select the **Free** plan.
7. Choose a permanent team name carefully; it is used by the Access login experience.
8. Make sure the account owner can manage Workers & Pages, Zero Trust applications, identity providers, and policies.

No custom domain is required. If a custom domain will be used, add the domain to Cloudflare and verify its DNS setup before configuring Access.

### 0.4 Prepare Google access

The person performing the migration needs access to:

- The Google Cloud project that owns OAuth client ID `929291550627-g1ev8er3cqo12lv8mnbip4uu6o9kdk7t.apps.googleusercontent.com`.
- The OAuth client's **Authorized JavaScript origins** settings.
- The Google Sheet's sharing settings.

Share the Sheet only with the approved Google accounts. Prefer using the same email list as Cloudflare Access.

If the Google OAuth consent screen is still in testing mode, add every approved Google account as a test user or configure the consent screen appropriately for the organization.

### 0.5 Audit the currently public repository

Before making the repository private:

1. Check whether public forks exist. Public forks may remain public after the source repository becomes private.
2. Review the Git history for credentials.
3. Rotate any committed client secret, service-account key, private API key, or password.
4. Remember that making a repository private cannot retract copies already cloned while it was public.

The OAuth client ID in `src/data/googleOAuth.ts` is a public identifier and is expected to appear in browser code. A Google OAuth client **secret** must never be included in this Vite application.

## Phase 1: create Cloudflare Pages CI/CD

Cloudflare's Git integration is the recommended CI/CD path. It reads the private GitHub repository through a narrowly scoped GitHub App, builds after pushes, and creates preview deployments for eligible branches and pull requests.

### 1.1 Connect the private repository

1. In Cloudflare, open **Workers & Pages**.
2. Select **Create application** and then **Pages**.
3. Select **Connect to Git**.
4. Choose GitHub.
5. When GitHub asks for repository access, select **Only select repositories**.
6. Grant access only to `vuquangdai9x-CookOrder-WebDesignTool`.
7. Return to Cloudflare and select that repository.

Cloudflare documents the GitHub connection and repository-scoping flow here: [Cloudflare Pages GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/).

### 1.2 Configure the build

Use these settings:

```text
Production branch: master
Build command: npm run build
Build output directory: dist
Root directory: /
Node version: 20
```

If the UI requests an environment variable for Node, set:

```text
NODE_VERSION=20
```

Do not put passwords, Google OAuth client secrets, Sheet tokens, or long-lived credentials in Vite variables. Any variable prefixed with `VITE_` can be included in the browser bundle.

### 1.3 Deploy once and record the hostname

Run the first deployment and record the assigned hostname:

```text
PROJECT.pages.dev
```

Do not distribute this URL yet. Pages deployments are public until the Access policies in Phase 2 are complete.

## Phase 2: protect every Cloudflare hostname

The recommended login method is an email one-time PIN. It avoids a shared password and allows one person's access to be revoked independently.

### 2.1 Enable email one-time PIN authentication

1. Open **Zero Trust** in Cloudflare.
2. Open **Settings** and then the authentication or login-method section.
3. Enable **One-time PIN**.
4. Keep only the login methods the team intends to use.

Optionally configure Google as an identity provider instead. The Access policy must still restrict exact email addresses; enabling Google login by itself does not authorize everyone with a Google account.

### 2.2 Create the reusable allow policy

Create an Access Allow policy with:

```text
Policy name: CookOrder approved users
Action: Allow
Include selector: Emails
Values: each approved email address
Session duration: 8 to 12 hours
```

Do not configure any of these permissive rules:

- Include Everyone
- Include all valid emails
- Allow an entire public email domain
- Bypass authentication

Cloudflare Access is deny-by-default when a visitor does not match an Allow policy. See [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

### 2.3 Protect production

Protect the exact production hostname:

```text
PROJECT.pages.dev
```

Cloudflare Pages' automatic Access setup may initially protect only wildcard preview deployments. Follow Cloudflare's production-hostname procedure:

1. Open the Pages project.
2. Open **Settings → General**.
3. Enable the Access policy.
4. Open the generated application under **Zero Trust → Access → Applications**.
5. Configure an application whose public hostname is exactly `PROJECT.pages.dev`, without a wildcard.
6. Attach the `CookOrder approved users` policy.

Cloudflare's current Pages-specific instructions are at [Enable Access on the `pages.dev` domain](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain).

### 2.4 Protect all previews

Create or retain a second Access application for:

```text
*.PROJECT.pages.dev
```

Attach the same approved-user policy. This protects branch aliases and immutable commit-preview URLs, not just production.

When finished, the Access application list should effectively contain:

```text
CookOrder production  -> PROJECT.pages.dev
CookOrder previews    -> *.PROJECT.pages.dev
```

### 2.5 Protect a custom domain, if used

If the application uses `tool.example.com`:

1. Add and verify the custom domain on the Pages project.
2. Create a separate self-hosted Access application for `tool.example.com`.
3. Attach the same approved-user policy.
4. Keep protection on both the custom domain and `PROJECT.pages.dev`; otherwise the generated Pages hostname becomes a bypass.

If adding a custom domain and Access during the same migration, follow Cloudflare's documented order and certificate-validation notes on the Pages known-issues page.

## Phase 3: update Google OAuth and Sheet permissions

### 3.1 Add the production origin

In Google Cloud Console:

1. Open **APIs & Services → Credentials**.
2. Open the Web OAuth client used by `src/data/googleOAuth.ts`.
3. Under **Authorized JavaScript origins**, add:

   ```text
   https://PROJECT.pages.dev
   ```

4. If using a custom domain, also add:

   ```text
   https://tool.example.com
   ```

5. Save and wait for Google's configuration to propagate.

Do not add wildcard preview origins unless previews genuinely need live Sheet access. Prefer limiting live OAuth access to production.

### 3.2 Match Google Sheet sharing

For the Sheet used by the application:

1. Set **General access** to **Restricted**.
2. Remove obsolete users and link-based access.
3. Add each approved Google account with the minimum required role:
   - Viewer if the user only reads.
   - Editor if the user must publish changes.
4. Test with an account that is approved by Cloudflare but not shared on the Sheet. The application must receive a Google Sheets `403`.

This repository already performs per-user Google OAuth and handles unauthorized Sheet responses. Cloudflare protects the application bundle; Google protects the live Sheet independently.

## Phase 4: make GitHub private and retire GitHub Pages

Perform this phase after the Cloudflare deployment and Access policies pass the tests in Phase 5. If public exposure must stop immediately, disable GitHub Pages first and accept temporary downtime.

### 4.1 Change repository visibility

1. Open the GitHub repository.
2. Open **Settings → General**.
3. Scroll to **Danger Zone**.
4. Select **Change repository visibility**.
5. Choose **Private** and confirm the repository name.
6. Review **Collaborators and teams** and remove anyone who no longer needs source access.

Confirm that the Cloudflare GitHub App still has access after the visibility change. Trigger a small safe commit or manually retry a build to verify CI/CD.

### 4.2 Disable the old GitHub Pages deployment

The current `.github/workflows/deploy.yml` publishes `dist` to GitHub Pages. After Cloudflare production is verified:

1. Open **GitHub → Settings → Pages**.
2. Unpublish or disable the site.
3. Remove the Pages deployment job from `.github/workflows/deploy.yml`, or replace the workflow with test/build validation only.
4. Remove these permissions when Pages deployment is gone:

   ```yaml
   pages: write
   id-token: write
   ```

5. Remove these Pages-specific actions:

   ```yaml
   actions/configure-pages
   actions/upload-pages-artifact
   actions/deploy-pages
   ```

GitHub Actions can remain as repository CI:

```yaml
- run: npm ci
- run: npm test
- run: npm run build
```

Cloudflare handles deployment after a push to `master`; GitHub Actions verifies the same revision independently.

### 4.3 Verify the old origin is gone

Open the old GitHub Pages URL in a private browser window. It must return `404` or another unpublished response. If a custom domain formerly pointed to GitHub Pages, update or remove its old DNS records.

## Phase 5: security and deployment verification

Do not announce the new URL until all checks pass.

### 5.1 Anonymous-access tests

In an incognito/private browser:

- Open `https://PROJECT.pages.dev`.
- Confirm that Cloudflare authentication appears before any application UI.
- Enter an unapproved email and confirm access is denied.
- Request a known JavaScript asset URL directly and confirm it also requires Access authentication.
- Request a known CSV or JSON asset directly and confirm it also requires authentication.

A direct asset request must not return `200` without a valid Access session.

### 5.2 Approved-user tests

- Enter an approved email.
- Receive and submit the one-time PIN.
- Confirm the application loads normally.
- Reload and confirm the Access session behaves as expected.
- Confirm the Google OAuth popup accepts the new production origin.
- Confirm an approved and Sheet-shared Google account can load data.

### 5.3 Rejected-data tests

- Use a Cloudflare-approved email so the application loads.
- Sign into Google with an account not shared on the Sheet.
- Confirm Sheet access fails with `403` and does not reveal live data.

### 5.4 Preview tests

- Create or update a non-production branch or pull request.
- Wait for its Cloudflare preview deployment.
- Open the preview URL in an incognito window.
- Confirm the preview requires the same Access authentication.

### 5.5 Repository and CI/CD tests

- Open the GitHub repository while logged out and confirm it is not visible.
- Push a harmless change to a test branch and confirm CI runs.
- Merge or push to `master` and confirm Cloudflare deploys automatically.
- Confirm a failed build does not replace the last successful production deployment.
- Confirm the old GitHub Pages URL remains unpublished.

## Ongoing administration

When adding a user:

1. Add the exact email to the Cloudflare Access policy.
2. If live Sheet access is required, share the Sheet with the matching Google account.
3. Do not add the person as a GitHub collaborator unless they need source access.

When removing a user:

1. Remove the email from the Cloudflare Access policy.
2. Remove the Google account from the Sheet.
3. Revoke GitHub access if the person was a developer.
4. Reduce the Access session duration temporarily if rapid revocation is important.

Review the following at least quarterly:

- Cloudflare Access email list and authentication methods.
- Google Sheet share list.
- GitHub collaborators and installed GitHub Apps.
- GitHub Actions and Cloudflare deployment history.
- OAuth authorized origins.

## Access needed if Codex performs the migration

To automate the account-level setup, connect these integrations in Codex:

- **GitHub**: repository administration, visibility, collaborators, Actions, Pages settings, and repository file updates.
- **Cloudflare**: Pages projects, GitHub repository connection, build settings, Zero Trust applications, authentication methods, and Access policies.

The user must still provide or confirm:

- The final approved email list.
- The Cloudflare account/team to use.
- Whether to use only `pages.dev` or also a custom domain.
- Permission to make the repository private and unpublish the old site.
- Access to the Google Cloud OAuth client and Google Sheet sharing settings, or completion of those Google steps manually.

Repository code can be updated and tested locally without those integrations. Account settings cannot be safely inferred or created without authenticated access to the corresponding accounts.

## Rollback

If Cloudflare deployment fails before GitHub Pages is disabled, keep the old site temporarily and do not distribute the Cloudflare URL.

After GitHub Pages has been disabled, rollback should mean restoring the last successful Cloudflare Pages deployment—not making the repository public again. Cloudflare Pages keeps deployment history and supports rolling production back to a previously successful deployment.

