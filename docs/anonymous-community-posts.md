# Anonymous community posts

Users choose anonymity for each new community post. Existing posts remain named.
The setting cannot be changed after publication. Authentication, rate limits,
ownership, moderation and reporting still use the stored author ID.

## Public contract

- `POST /posts` accepts the JSON boolean `isAnonymous` (default `false`).
- `GET /posts/composer-status` advertises `supportsAnonymous: true`. The web
  composer exposes the option only after receiving this capability, preventing
  an older backend from silently ignoring the anonymity flag during rollout.
- Anonymous post responses contain `authorId: null`, a neutral author with
  `id`, `username` and `avatarUrl` set to null, and `followingAuthor: false`.
  `isOwn` enables the real author's edit/delete controls without exposing identity.
- The same projection applies to creation, editing, feeds, detail, SEO, hashtags,
  venue listings and explore. The author's own comments/replies on that post are
  projected anonymously too. Other commenters retain their chosen account identity.
- Public account listings and the following feed exclude anonymous posts. An
  authenticated author may see their anonymous posts in their own account listing.
- Anonymous posts cannot represent an official/venue account or link a match.
- Admin moderation endpoints retain the private author, behind the existing admin guard.
- Community comment deletion uses `DELETE /post-comments/:id`; match comments
  already occupy `DELETE /comments/:id`. The web PostsApi uses the dedicated route.

Text, uploaded media and mentions remain user-authored content; the UI explains
that these can disclose identity. This is anonymity from other members, not from
moderators. It is not a media anonymization service.

## Deployment

1. Apply `20260928090000_anonymous_community_posts` using the normal Prisma
   migration deployment. It adds one non-null boolean with a false default.
2. Generate Prisma clients and deploy the API.
3. Deploy the web application. No new dependencies, background jobs or storage are required.

Do not drop the anonymity column or roll back to an API that returns raw authors
once anonymous posts exist. That would reveal the stored private authors.

## Verification

- `npm test -- --runInBand src/modules/posts`
- `node test/anonymous-posts.integration.cjs` (local API and local PostgreSQL only;
  creates temporary QA accounts and cleans them in `finally`). Covers JSON validation,
  named/anonymous creation, media, feeds, profiles, replies, notifications, edits,
  deletion, and admin access boundaries.
- Angular: `npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/features/app/pages/community/composer/post-composer.anonymous.spec.ts`
