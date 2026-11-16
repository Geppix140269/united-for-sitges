# Community Agent: Meta permissions and platform capabilities

Researched 16 November 2026 from official Meta documentation. Items marked **UNVERIFIED** could not be confirmed on an official page and must be checked in the App Dashboard before use. No Meta app, Page, token or Instagram account has been verified in this work.

## 1. Graph API version

Latest version on the changelog: **v27.0**, released 4 November 2026 (v26.0: 29 July 2026; v25.0: 18 February 2026). Source: https://developers.facebook.com/docs/graph-api/changelog. The code defaults to `v27.0`; pin with `META_GRAPH_VERSION` after confirming in the App Dashboard. The v27.0 changelog page itself returned 404 on the research date.

## 2. Webhooks

Source: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- Verification: GET with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; respond with the challenge. Implemented.
- Payload signature: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the raw payload with the App Secret. Implemented with constant-time comparison.
- Retries: immediately, then with decreasing frequency for up to 36 hours; duplicates must be expected. Batches up to 1000 updates. HTTPS required, self-signed certificates not supported. Response-time limit: **UNVERIFIED** (we acknowledge immediately after storage).

## 3. Facebook Page permissions (implemented features only)

| Feature | Endpoint | Permissions | Page task | Source |
| --- | --- | --- | --- | --- |
| Subscribe app to Page feed | `POST /{page-id}/subscribed_apps?subscribed_fields=feed` | `pages_manage_metadata`, `pages_show_list` | CREATE_CONTENT, MANAGE or MODERATE | https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps |
| Receive comment events | `feed` webhook field (`item=comment`, `verb` add/edit/edited/remove/delete/hide) | `pages_manage_metadata`, `pages_show_list` | as above; app must be installed on the Page | https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages |
| Read a comment and context | `GET /{comment-id}`, `GET /{comment-id}/comments` | `pages_read_engagement` and/or `pages_read_user_content` | MODERATE for comments on Page posts | https://developers.facebook.com/docs/pages-api/comments-mentions |
| Reply as the Page | `POST /{comment-id}/comments` (`message`) | `pages_manage_engagement` (depends on `pages_read_user_content`, `pages_show_list`) | MODERATE | https://developers.facebook.com/docs/graph-api/reference/object/comments |
| Publish a Page post | `POST /{page-id}/feed` (`message`, `link`) or `POST /{page-id}/photos` (`url`, `caption`) | `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` | CREATE_CONTENT | https://developers.facebook.com/docs/graph-api/reference/page/feed |
| Post metrics | `GET /{post-id}/insights` | `read_insights` and `pages_read_engagement` (**UNVERIFIED** combination for current version) | ANALYZE (**UNVERIFIED**) | https://developers.facebook.com/docs/graph-api/reference/insights |
| Token check | `GET /debug_token` with an app token | none beyond app credentials | n/a | Graph API reference |

Not requested: `pages_messaging`, advertising permissions, `publish_to_groups`, `business_management`. Comment hiding (`POST /{comment-id}` with `is_hidden`) is **not implemented**; the exact permission is UNVERIFIED and the brief forbids silent moderation.

Publish response: documented as `{"id": "..."}`; the `{page-id}_{post-id}` form is UNVERIFIED for publish responses, so the adapter fetches `permalink_url` after publishing.

Insights: `post_impressions` and `post_impressions_unique` are deprecated above v25 and Page Insights metrics were scheduled for removal across versions by 15 June 2026. The adapter uses `post_media_view`, `post_clicks` and `post_reactions_by_type_total`, and records metrics as unavailable when the API refuses.

Errors (https://developers.facebook.com/docs/graph-api/guides/error-handling, https://developers.facebook.com/docs/graph-api/overview/rate-limiting): code 190 invalid/expired token (subcodes 458, 459, 460, 463, 464, 467, 492); throttling 4, 17, 32, 613, 80001 (Pages BUC, 4800 x engaged users per 24 h). Headers `X-App-Usage`, `X-Business-Use-Case-Usage` (with `estimated_time_to_regain_access`, honoured for backoff).

## 4. Instagram: two separate login models (do not mix)

| | Instagram API with Instagram Login (recommended for this project) | Instagram API with Facebook Login |
| --- | --- | --- |
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Facebook Page needed | No | Yes, account linked to a Page |
| Permissions | `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_content_publish` (`instagram_business_manage_messages` not requested) | `instagram_basic`, `instagram_manage_comments`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` (+ `ads_management` or `ads_read` if Page role comes via Business Manager) |
| Old scope names | `business_basic` etc. deprecated 27 January 2025 | n/a |
| Source | https://developers.facebook.com/docs/instagram-platform/overview, https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login | https://developers.facebook.com/docs/instagram-platform/content-publishing |

The adapter implements **Instagram Login** only. Metrics permission (`instagram_business_manage_insights`) is **UNVERIFIED** and metrics are not implemented for Instagram.

Publishing lifecycle (https://developers.facebook.com/docs/instagram-platform/content-publishing): `POST /{ig-user-id}/media` (public `image_url`, `caption`) returns a container; poll `GET /{container-id}?fields=status_code` (EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED; once a minute up to 5 minutes); `POST /{ig-user-id}/media_publish` with `creation_id`. Containers expire after 24 h. The adapter stores the container id and resumes it on the next run instead of creating a new one.

Image rules: JPEG only, at most 8 MB, aspect ratio 4:5 to 1.91:1, width 320 to 1440 px. Text-only posts are impossible; the system uses first-party branded category cards (`assets/agent/cards/`, 1080x1350) validated before publishing.

Publishing limit: documentation is inconsistent (100 vs 50 per 24 h). The adapter reads `GET /{ig-user-id}/content_publishing_limit` and treats exhausted quota as a rate limit. Replies: `POST /{ig-comment-id}/replies`.

## 5. Facebook Groups

The Groups API (including `publish_to_groups`) was deprecated in v19 (23 January 2024) and removed 90 days later (https://developers.facebook.com/blog/post/2024/01/23/introducing-facebook-graph-and-marketing-api-v19/). The exact removal date is UNVERIFIED. No group integration, scraping or browser automation exists. External discussions are logged manually in the console (External notes).

## 6. Access levels and App Review

Source: https://developers.facebook.com/docs/graph-api/overview/access-levels, https://developers.facebook.com/docs/pages-api/overview
- Standard Access needs no App Review but works only for people with a role on the app (or in the claiming Business).
- Advanced Access needs App Review per permission and Business Verification.
- Instagram: Standard is sufficient for accounts you own and add in the App Dashboard.
- Inference (not explicitly stated for Pages): if every Page admin who authorises the app has an app role, Standard Access should suffice for this single-Page use. Confirm in the App Dashboard before relying on it.

## 7. Outstanding owner actions

1. Confirm the Facebook Page exists, is owned by the project, and record its Page ID.
2. Create (or identify) a Meta App of type Business owned by the project; add the owner as app admin. Record App ID; keep App Secret only in Vercel.
3. Generate a long-lived Page access token for that Page via the owner's own login, with only: `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement` (moderation replies) and, only when autonomous publishing is approved, `pages_manage_posts` (plus `read_insights` for metrics).
4. Store tokens as Vercel env vars (`META_PAGE_ACCESS_TOKEN`), never in the database or repository.
5. Configure the webhook callback `https://unitedforsitges.com/api/agent/meta-webhook` with a random `META_VERIFY_TOKEN`; subscribe the app to the Page `feed` field.
6. Confirm whether an Instagram Professional account exists; if so choose Instagram Login and generate a token with the three `instagram_business_*` permissions.
7. In the console: add channels, run "Verify token" (uses `debug_token`), check the recorded scopes.
8. Owner-authorised test publications on each platform before any live switch is turned on.
