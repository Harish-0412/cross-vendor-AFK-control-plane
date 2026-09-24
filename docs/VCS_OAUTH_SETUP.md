# Source-control OAuth setup

Odysseus uses Google only for application sign-in. GitHub, GitLab, and Bitbucket are separate server-side OAuth connections used to list repositories and create reviewed pull requests. Provider access tokens are encrypted by the Control Plane and are never returned to the browser.

## Production URLs

The production Control Plane callback base is:

`https://odysseus-control-plane.onrender.com/api/v1/integrations`

Configure these exact callback URLs in the provider applications:

| Provider        | OAuth application type | Callback URL                                                                               | Required scope          |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| GitHub          | OAuth App              | `https://odysseus-control-plane.onrender.com/api/v1/integrations/github/oauth/callback`    | `repo`                  |
| GitLab          | Application            | `https://odysseus-control-plane.onrender.com/api/v1/integrations/gitlab/oauth/callback`    | `api`                   |
| Bitbucket Cloud | OAuth consumer         | `https://odysseus-control-plane.onrender.com/api/v1/integrations/bitbucket/oauth/callback` | `repository`, `account` |

Create the applications under the organization that owns the respective repositories. Do not make a client secret public, commit it, add it to Vercel, or paste it into a browser field.

## Render environment configuration

In the `odysseus-control-plane` Render service, set the following server-side environment variables. Use Render's secret-value control for every `*_SECRET` value.

```text
FRONTEND_URL=https://cross-vendor-afk-control-plane.vercel.app

GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://odysseus-control-plane.onrender.com/api/v1/integrations/github/oauth/callback

GITLAB_CLIENT_ID=...
GITLAB_CLIENT_SECRET=...
GITLAB_CALLBACK_URL=https://odysseus-control-plane.onrender.com/api/v1/integrations/gitlab/oauth/callback

BITBUCKET_CLIENT_ID=...
BITBUCKET_CLIENT_SECRET=...
BITBUCKET_CALLBACK_URL=https://odysseus-control-plane.onrender.com/api/v1/integrations/bitbucket/oauth/callback
```

Restart or redeploy the service after saving these variables. A provider is shown as **Setup required** in the website until all three variables for it are present.

## Google sign-in check

Google sign-in remains Firebase Authentication. In Firebase Console, enable Google under **Authentication → Sign-in method** and allow the production Vercel hostname. The frontend needs its public `NEXT_PUBLIC_FIREBASE_*` configuration, while the Control Plane needs its Firebase Admin credentials to verify ID tokens. These are separate from VCS OAuth secrets.

## Verify a connection safely

1. Sign in to Odysseus with Google.
2. Open **Integrations**, choose a configured provider, and approve the provider’s consent screen.
3. Odysseus exchanges the one-time authorization code server-side, fetches the provider profile, and stores the credential only if that verification succeeds.
4. Open **Projects → Project settings → Link repository**. The repository list comes directly from the connected account.
5. Select a repository. Odysseus performs one more provider-side repository lookup before it links the project, so a manually entered or inaccessible repository cannot be saved.
6. Use **Disconnect** to erase that provider credential. Existing project bindings remain visible but cannot create a pull request until the provider is reconnected and access is verified again.

GitHub and GitLab connections use PKCE with opaque, single-use state values. Bitbucket Cloud uses its confidential OAuth client flow with the client secret kept only on Render.
