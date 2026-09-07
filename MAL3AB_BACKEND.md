# Mal3ab Backend — Complete Reference

**Audience:** any AI assistant, mobile developer, or frontend developer picking this up with zero prior context. This document is self-contained — you should not need to read the source to understand what the API does, how it's shaped, and what it guarantees.

**Stack:** NestJS 11 (TypeScript) · Prisma 6 · PostgreSQL 14+ · Socket.IO · JWT auth. No Redis/Docker/PostGIS required to run locally.

**Product spec this implements:** `angular/PROJECT_BLUEPRINT.md` §1–21 — the committed product including partner onboarding (§20, 2026-09-04) and the owner operations dashboard (§21, 2026-09-05). Explicitly deferred Phase-2+ items stay out of scope: tournaments, coach marketplace, camera highlights, prediction games. Shared swimming-session inventory (`Slot.capacity`) remains a documented stub.

**Live API docs:** once the server is running, `GET /api/docs` (Swagger) has the exhaustive, always-current request/response shape for every endpoint — generated from the same DTOs listed below. This document is the narrative map; Swagger is the source of truth for exact field types.

### How humans and AI should use this repo

1. Read **this file** for architecture, invariants, stubs, and route map.
2. Use **`GET /api/docs`** (or `GET /api/docs-json`) for exact fields, examples, and enums.
3. DTOs live in `src/modules/<name>/dto/*.dto.ts` with `@ApiProperty` examples — if Swagger and this file disagree, **the DTO + Prisma schema win**.
4. Seed logins: `admin@mal3ab.app` / `owner@mal3ab.app` / username `elmalek` — password `Password123!`.
5. Global prefix is **`/api/v1`**. Successful bodies are `{ message, result, pagination? }`. Typed failures also include `code` when the message is a stable machine token (e.g. `SLOT_ALREADY_HELD`, `APPLICATION_VERSION_CONFLICT`).
6. Partner writes send `If-Match: <version>` or `body.version`. Stale writes return **409 `APPLICATION_VERSION_CONFLICT`**.

### Swagger 400: `property X should not exist`

`ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`. A query/body field that is **not on the DTO** is rejected.

Common mistake: Swagger Try-it-out pre-fills optional query boxes with junk like `Active` or `string`. **Clear unused query fields** before Execute.

| Endpoint | Optional filter | Allowed values (lowercase) |
|---|---|---|
| `GET /blog` | **none** — always `published` | do not send `status` |
| `GET /admin/blog` | `status` | `draft` \| `published` \| `archived` (`PublishStatus`) |
| `GET /admin/support` | `status` | `new` \| `read` |
| `GET /admin/moderation/reports` | `status` | `open` \| `resolved` \| `dismissed` |
| `GET /bookings/mine` | `scope` | `upcoming` \| `past` \| `all` |
| `GET /owner/venues/:id/bookings` | `status` | `held` \| `confirmed` \| `cancelled` \| `completed` \| `no_show` |
| `GET /friends` | `status` | `all` \| `online` \| `offline` \| `in_squad` (presence, not UserStatus) |
| `GET /feed/matches` | `status` | `open` \| `full` \| `played` \| `expired` \| `cancelled` |
| `GET /venues/search` | `district` | slug e.g. `nasr-city` (not a status) |
| `GET /venues/search` | `date` | `YYYY-MM-DD`; optional `from`/`to` as `HH:mm` |
| `GET /admin/partner-applications` | `status` | `draft` \| `pending` \| `changes_requested` \| `approved` \| `rejected` \| `suspended` |
| `PATCH /users/:id/status` (admin) | body `status` | `active` \| `suspended` \| `banned` |

There is **no** status value `Active` (capital A). User accounts use lowercase `active`. Blog posts never use Active — they use `PublishStatus`.

### Why `GET /blog?status=Active` returned 400

Public `GET /api/v1/blog` binds **only** `PageQueryDto` (`page`, `perPage`). The handler hard-codes `status = published` in the service. Swagger used to show a leftover `status` query box (Nest treated `@Query('status')` as required). Sending that box — especially the placeholder `Active` — hit `forbidNonWhitelisted` → `"property status should not exist"`.

Correct calls:

```
GET /api/v1/blog?page=1&perPage=20
GET /api/v1/admin/blog?page=1&perPage=20&status=draft   # admin JWT
```

### Status & enum catalog (Prisma — send these exact strings)

Source of truth: `prisma/schema.prisma`. All values are **lowercase**.

| Enum / field | Values | Used on |
|---|---|---|
| `UserRole` | `player` `owner` `staff` `admin` | JWT `roles`, register |
| `UserStatus` | `active` `suspended` `banned` | user account (admin PATCH) |
| `VenueStatus` | `pending` `active` `suspended` | published venue listing |
| `PartnerApplicationStatus` | `draft` `pending` `changes_requested` `approved` `rejected` `suspended` | partner onboarding |
| `CalendarBlockKind` | `maintenance` `private` | owner calendar blocks |
| `PayoutMethodKind` | `bank` `instapay` `wallet` | owner payout destinations |
| `PublishStatus` | `draft` `published` `archived` | **blog posts only** |
| Support inquiry `status` (string) | `new` `read` | contact inbox |
| `BookingStatus` | `held` `confirmed` `cancelled` `completed` `no_show` | bookings |
| `PaymentStatus` | `pending` `paid` `failed` `refunded` `partial` | payments |
| `PaymentMethod` | `card` `wallet` `apple_pay` `google_pay` `paypal` `cash` `vodafone` `orange` `etisalat` `fawry` `instapay` `mada` `stc_pay` `benefit` `knet` | checkout |
| `FriendshipStatus` | `pending` `accepted` `declined` `blocked` | friend graph (not the friends list query) |
| Friends list query `status` | `all` `online` `offline` `in_squad` | **presence filter**, not FriendshipStatus |
| `MatchPostStatus` | `open` `full` `played` `expired` `cancelled` | match feed |
| `JoinRequestStatus` | `pending` `approved` `declined` | match join requests |
| `ChallengeStatus` | `pending` `accepted` `declined` `played` | team challenges |
| `ReportStatus` | `open` `resolved` `dismissed` | moderation |
| `PulseOpportunityStatus` | `open` `held` `claimed` `full` `expired` `cancelled` | Pulse |
| `PulseClaimState` | `held` `confirmed` `released` `expired` | Pulse claims |
| `StaffInviteStatus` | `pending` `accepted` `declined` `revoked` `suspended` | owner staff |

---

## 1. Architecture overview

One NestJS app, 26 feature modules, each following the same internal shape:

```
modules/<name>/
  <name>.module.ts       — wiring
  <name>.controller.ts   — HTTP routes, thin, delegates to the service
  <name>.service.ts      — business logic, injects PrismaService directly
  dto/                   — class-validator request DTOs
  <name>.gateway.ts       — (only realtime module) Socket.IO handlers
```

This uniformity is deliberate: adding a new module is "copy the pattern," not "invent a new one." All persistence goes through a single injected `PrismaService` (no direct `new PrismaClient()` anywhere) — this was a real bug in the boilerplate this project started from, fixed early and enforced by convention since.

### Module map

| Module | Responsibility |
|---|---|
| `auth` | Phone-OTP (primary) + email/password (owner/staff/admin) login, refresh/rotate, logout, Google/Apple OAuth (wired, inert until client IDs configured), password reset |
| `rbac` | Fine-grained permission table for **venue-owner staff sub-roles** (e.g. "receptionist: check-in + calendar only") — separate from the four top-level roles |
| `users` | Profile, avatar/avatarConfig, public player profile, admin user list/suspend |
| `venues` | Venue/court CRUD, pricing rules, amenities, photos, geo search, weekly hours, availability-aware search |
| `bookings` | Slot grid, hold→confirm flow, split payments, QR check-in, cancellation, recurring series — **the core money path** |
| `payments` | Mock Egypt-localized checkout behind a `PaymentProvider` interface |
| `reviews` | Venue reviews + owner replies, player-to-player ratings, MVP votes |
| `social` | Friend graph, match posts ("need 2 players") + join flow, teams + challenges |
| `chat` | Direct/match/team threads, cursor-paginated messages, idempotent sends, read state |
| `squad` | PUBG-style party: invites, join requests, leader actions, mic-mute signaling (no WebRTC audio — see §8) |
| `rewards` | Coin ledger, daily streak, quests, badges, promo codes, leaderboards |
| `pulse` | "Mal3ab Pulse" live demand network + Rescue Match claim state machine |
| `notifications` | In-app inbox (push dispatch is a documented extension point, see §8) |
| `partners` | Partner register/login/username, versioned applications, submit gate, admin review/decisions, atomic publish |
| `owner` | Dashboard KPIs + application status, calendar + blocks, walk-ins, finance CSV, payouts, staff, QR verify, no-show |
| `admin` | Admin KPI wall, moderation queue, audit log, feature flags, analytics, partner-application queue |
| `content` | Blog (Tiptap-ready), banners, FAQ, support/contact inbox, sports/amenities catalogs |
| `geo` | Countries, governorates, districts (GeoJSON polygons) |
| `storage` | Pluggable file storage: local disk (dev) / S3 (prod) behind one interface |
| `email` | Transactional email, no-ops to console when SMTP isn't configured |
| `sms` | OTP delivery, console provider by default |
| `realtime` | The one Socket.IO gateway everything above emits through |
| `presence` | In-memory online/offline/in-squad tracker, updated by the gateway |
| `jobs` | Cron sweeps: expire booking holds, Pulse claims/availability, mark no-shows, expire inactive coins, reset broken streaks |
| `prisma` | Injectable `PrismaService` (connect/disconnect lifecycle) |

**Totals:** 26 modules, ~180 HTTP endpoints, 67 Prisma models.

---

## 2. Data model

Full schema: `prisma/schema.prisma`, organized into commented sections. Highlights by domain:

- **Identity & RBAC:** `User` (phone-first, optional unique `username`, `roles: UserRole[]` so one account can be player+owner), `RefreshToken` (hashed, per-device, revocable), `OtpCode` (hashed, attempt-capped), `Role`/`Permission`/`RolePermission`/`UserRoleAssignment` (owner-staff fine-grained permissions).
- **Venues & booking:** `Venue` → `Court` → `PricingRule`; `weeklyHours` JSON on the venue; `CalendarBlock` (maintenance/private); `Booking` (the central transactional entity, plus `guestName`/`guestPhone` for walk-ins) → `BookingSplitShare`, `Payment`; `RecurringBookingSeries`.
- **Partner onboarding:** `PartnerApplication` (versioned JSON payload + denormalized names/geo) → immutable `PartnerApplicationEvent` history. Approval atomically publishes `Venue` + `Court` + photos + pricing.
- **Reviews & ratings:** `VenueReview`, `PlayerRating` (sportsmanship/skill/punctuality/MVP).
- **Social:** `Friendship`, `MatchPost` → `MatchPostJoinRequest`, `Team` → `TeamMember`/`TeamChallenge`, `ChatThread` → `ChatThreadParticipant`/`ChatMessage`, `Squad` → `SquadMember`/`SquadInvite`/`SquadJoinRequest`, `Notification`.
- **Rewards:** `CoinLedgerEntry` (append-only), `Quest`/`UserQuestProgress`, `Badge`/`UserBadge` (`iconKey`), `PromoCode` (`active`) / `PromoRedemption`.
- **Pulse:** `PulseAvailability`, `PulseOpportunity`, `PulseClaim` — all versioned for realtime client upsert.
- **Owner/admin:** `CommissionSetting`, `Payout`, `PayoutMethod` (masked identifier), `StaffInvite` (email or phone + `operationalRole`), `AuditLogEntry`, `FeatureFlag`, `ModerationReport`, `PlatformSetting`.
- **Content/CMS:** `BlogPost`/`BlogCategory`, `Banner`, `FaqEntry`, `SupportInquiry`.
- **Geo/taxonomy:** `CountryConfig` (ISO code, IANA `timezone`, currency, payment rails) → `Governorate` → `District`, `SportCategory`, `Amenity`. Slot pricing and slot grids use `CountryConfig.timezone` (Egypt seed: `Africa/Cairo`).

**Conventions:**
- All bilingual text is two columns (`titleEn`/`titleAr`), not a JSON blob — matches the frontend's `LocalizedText { ar, en }` and lets Postgres index/search each language directly.
- All money is `(amountMinorUnits: Int, currency: String)` — never a bare float. `10000` = 100.00 EGP.
- Geo uses `lat`/`lng` (Float) + `geohash` (String, indexed) — no PostGIS dependency. Viewport queries filter by lat/lng range; radius queries pre-filter by geohash prefix then refine with Haversine. Portable to any managed Postgres.

---

## 3. The two correctness guarantees that matter most

### 3.1 A court can never be double-booked

`Booking` has a **partial unique index** (raw SQL migration, not expressible in `schema.prisma` — Prisma has no `WHERE` clause syntax for indexes):

```sql
CREATE UNIQUE INDEX "Booking_court_slot_live_unique"
  ON "Booking" ("courtId", "slotStart")
  WHERE "status" IN ('held', 'confirmed');
```

Two simultaneous `POST /bookings/hold` calls for the same court+slot race at the database, not in application code — the loser gets a Postgres unique-violation, which `AllExceptionsFilter` maps to a clean `409 { message: "SLOT_ALREADY_HELD" }`. This was verified live during development: two concurrent hold requests for the same slot, one succeeded, one got 409, before the fix was even trusted in code review. A `jobs`-module cron (`JobsService.expireBookingHolds`, every 10s) flips expired `held` rows to `cancelled`, which is what actually frees the slot — the index only prevents overlap, it doesn't expire anything by itself.

### 3.2 A Pulse opportunity can never be over-claimed

`PulseService.claim()` runs inside a **Serializable** Prisma transaction: count active claims, compare to capacity, insert if room remains, bump `version`. Under Postgres `SERIALIZABLE` isolation, a genuine race between two claimants causes one transaction to fail with a serialization error (Postgres code `40001` / Prisma `P2034`), which is caught and mapped to `409 PULSE_CAPACITY_CHANGED` — the client is expected to refetch. A cron sweep (`JobsService.expirePulseClaims`, every 10s) releases claims past their `holdExpiresAt` back to `open`.

Both of these are the kind of bug that's invisible in a demo and catastrophic in production (double-selling the same slot), so they're enforced by the database, not by "the code checks first."

---

## 4. Auth

**Player flow (primary):** phone-first OTP.
1. `POST /auth/otp/request { phone }` → creates a 4-digit code (bcrypt-hashed, 5 min TTL, rate-limited to 1/minute/phone), delivers it via the `OtpDelivery` interface. **The code is never present in this response** — only in whatever `OtpDelivery` provider is configured (console logger in dev).
2. `POST /auth/otp/verify { phone, code, name? }` → verifies (5 attempts max, then must re-request), creates the user if new (`roles: ['player']`), returns an access+refresh token pair.

**Owner/staff/admin flow:** `POST /auth/register` (email+password+phone+name, `roles: ['owner']`) and `POST /auth/login` (email+password). Partners use `POST /partners/register` (username + password 10–128 with letters and numbers) and `POST /partners/login` (username **or** email). An existing player with the same phone and no password is upgraded to `owner` rather than rejected.

**OAuth:** `POST /auth/oauth/google { idToken }` (verified against Google's `tokeninfo` endpoint) and `POST /auth/oauth/apple { identityToken }` (verified against Apple's JWKS via `jsonwebtoken`/`jwks-rsa`) are fully implemented but throw a clear `501` until `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` (+ team/key IDs) are set in `.env` — there's no fake/mock mode, they either really verify or refuse to run.

**Tokens:** access token 15 min (JWT, `JWT_ACCESS_SECRET`), refresh token 7 days (JWT, `JWT_REFRESH_SECRET`, hashed at rest in `RefreshToken`, rotated on every use — the old one is revoked the moment a new pair is issued). `POST /auth/logout` revokes one device; `POST /auth/logout-all` (authenticated) revokes every device.

**Password reset:** `POST /auth/password/forgot { phone }` → OTP, `POST /auth/password/reset { phone, code, newPassword }`. This closes what was originally the most serious bug in the boilerplate this project started from: the old endpoint returned the OTP in the HTTP response body, which is a full account-takeover-by-email primitive. It's now structurally impossible for the code to leak this way — `requestPasswordReset` returns `void`, the code only ever reaches `OtpDelivery.send()`.

**Guard model:** one `AuthGuard` (`common/guards/auth.guard.ts`), registered globally. `@Public()` bypasses it entirely. `@Roles('admin', 'owner', ...)` checks the JWT's `roles` array. `@RequirePermission('calendar.manage', ...)` additionally checks the `rbac` module's fine-grained table for `staff` users only (`admin`/`owner` bypass it — they don't need to be granted their own venue's permissions). A separate `AuthContextMiddleware` runs on every request and *attempts* to decode a token into `request.user`, but never throws — this is what lets public pages keep working for a visitor carrying a stale/expired token, which was a real bug in the original boilerplate (its middleware threw on any invalid token, even on public routes).

---

## 5. Endpoint catalog by module

Full request/response DTOs are in Swagger (`/api/docs`) and `src/modules/<name>/dto/`. This is the route map.

### auth (`/auth`)
`POST otp/request` · `POST otp/verify` · `POST register` · `POST login` · `POST oauth/google` · `POST oauth/apple` · `POST refresh` · `POST logout` · `POST logout-all` (auth) · `POST password/forgot` · `POST password/reset`

### rbac (`/rbac`, owner only)
`GET permissions` · `GET roles` · `POST roles` · `POST assignments` · `DELETE assignments/:id`

### users (`/users`)
`GET users/me` (auth) · `PATCH users/me` · `PATCH users/me/avatar` (multipart) · `PATCH users/me/avatar-config` · `GET users/:id/public` · `GET users` (admin list) · `PATCH users/:id/status` (admin) · `GET players` · `GET users/me/favorites` · `POST/DELETE users/:id/block` · `GET users/me/blocks` · `PATCH users/me/privacy`

### geo (`/geo`)
`GET geo/countries` · `GET geo/countries/:code` · `GET geo/governorates?country=EG` · `GET geo/districts?gov=cairo` (or `governorateId=`) — districts include a GeoJSON `polygon`.

### content (`/blog`, `/banners`, `/faq`, `/support`, `/admin/*`)
- Public: `GET sports` · `GET amenities` · `GET blog?page=&perPage=` (**published only — do not send `status`**) · `GET blog/:slugOrId` (bilingual `titleEn`/`titleAr` + `contentEn`/`contentAr`) · `GET banners?placement=` · `GET faq` · `POST support { fullName, email, phone, message }`
- Admin: `GET/POST admin/blog` (`GET` accepts `status=draft|published|archived`) · `PATCH/DELETE admin/blog/:id` · banners/faq CRUD · `GET admin/support?status=new|read` · `PATCH admin/support/:id/read`

### users extras
`GET players` (public directory) · `GET users/me/favorites` · `POST/DELETE venues/:id/favorite` · `POST/DELETE users/:id/block` · `GET users/me/blocks` · `PATCH users/me/privacy`

### catalog / geo / explore
`GET venues/search?district=nasr-city&date=2026-09-10&from=18:00&to=21:00&include=pins,cards,count` returns `{ count, pins, clusters, cards, boundary }` where `boundary` is GeoJSON Polygon when a district is selected. `date`/`from`/`to` keep venues that have at least one court free of live bookings **and** calendar blocks in that window (venue-country timezone). `GET venues/search/count`. `POST promo-codes/validate { code, amount? }`.

### venues (`/venues`, `/owner/venues`, `/owner/courts`, `/admin/venues`)
`GET venues` (public search — sport/district/bbox/center+radius/price/rating/instant-book filters) · `GET venues/:slug` (public) · `POST owner/venues` · `GET owner/venues` · `PATCH owner/venues/:id` · `POST owner/venues/:id/photos` (multipart) · `PATCH .../photos/reorder` · `DELETE owner/venues/:id/photos/:photoId` · `POST owner/venues/:id/courts` · `PATCH owner/courts/:id` · `DELETE owner/courts/:id` · `POST owner/courts/:id/pricing-rules` · `PATCH owner/pricing-rules/:id` · `DELETE owner/pricing-rules/:id` · `GET admin/venues/pending` · `POST admin/venues/:id/approve` · `POST admin/venues/:id/suspend`

### bookings (`/bookings`, `/courts/:id/slots`, `/owner/venues/:id/bookings`)
`GET courts/:courtId/slots?date=` (public slot grid — weekly hours + blocks) · `POST bookings/hold` (auth) · `POST bookings/:id/confirm` (auth) · `POST bookings/:id/cancel` (auth) · `GET bookings/mine?scope=upcoming|past|all` (auth) · `GET bookings/:id` (auth) · `POST bookings/split-shares/:token/pay` (public — share-link payer may not have an account) · `POST bookings/checkin` (owner/staff/admin — QR payload) · `GET owner/venues/:venueId/bookings?status=&q=` (owner/staff/admin) · `POST/GET bookings/recurring*` (auth)

### reviews (`/reviews`, `/ratings`, `/venues/:id/reviews`)
`POST reviews` (auth, gated to a completed booking) · `POST reviews/:id/reply` (owner/admin) · `GET venues/:id/reviews` (public) · `POST ratings` (auth, gated to shared-booking participants) · `GET users/:id/ratings` (public)

### social (`/friends`, `/friend-requests`, `/matches`, `/teams`)
`GET friends?status=all|online|offline|in_squad&query=` · `POST friends/requests` · `GET friend-requests?direction=incoming|outgoing` · `POST friend-requests/:id/accept|decline` · `DELETE friends/:userId` · `GET feed/matches?status=open|full|played|expired|cancelled` (public) · `GET matches/:id` (public) · `POST matches` · `POST matches/:id/join` · `POST matches/join-requests/:id/approve|decline` · `POST matches/:id/played|cancel` · `POST teams` · `GET teams/:id` (public) · `POST/DELETE teams/:id/members/:userId` · `POST teams/:id/challenges` · `POST teams/challenges/:id/accept|decline`

### chat (`/chat`) — implements the blueprint's §16.5 contract field-for-field
`POST chat/direct-threads` (find-or-create, 200/201) · `POST chat/match-threads` · `POST chat/team-threads` · `GET chat/threads` · `GET chat/threads/:id` · `GET chat/threads/:id/messages?before=&limit=` (cursor, newest-first) · `POST chat/threads/:id/messages` (Idempotency-Key + clientMessageId) · `POST chat/threads/:id/attachments` (image/voice upload) · `PATCH/DELETE chat/threads/:id/messages/:messageId` · `PUT chat/threads/:id/read-state` · `GET chat/unread-count`

### squad (`/squad`)
`GET mine` · `GET invites` · `GET ice-servers` (STUN/TURN for WebRTC) · `GET :squadId/join-requests` · `POST invites` · `POST invites/:id/accept|decline` · `POST join-requests/:id/approve|decline` · `POST :squadId/kick/:userId` · `POST :squadId/make-leader/:userId` · `PATCH :squadId/mute/:userId` · `PATCH :squadId/mic` · `POST :squadId/leave`

### social extras (`/matches`, `/friends`, `/teams`, `/players`)
`POST matches/:id/leave` · `GET/POST matches/:id/comments` · `DELETE comments/:id` · `GET/POST matches/:id/reactions` · `POST friend-requests/:id/cancel` · `GET teams` · `GET teams/:a/head-to-head/:b` · `GET players` (public directory, coins stripped) · `POST/DELETE users/:id/block` · `GET users/me/blocks` · `PATCH users/me/privacy`

### catalog / geo / explore
`GET sports` · `GET amenities` · `GET geo/countries` · `GET geo/governorates?country=EG` · `GET geo/districts?gov=` · `GET venues/search` (pins+cards+count+boundary) · `GET venues/search/count` · `POST/DELETE venues/:id/favorite` · `GET users/me/favorites` · `POST promo-codes/validate`

### partners (`/partners`, `/admin/partner-applications`) — blueprint §20.9
`POST partners/register` · `POST partners/login` · `GET partners/username-availability?username=` · `GET partners/applications` · `POST partners/applications` · `PATCH partners/applications/:id` (`If-Match` or `version`) · `POST partners/applications/:id/submit` · `POST partners/uploads?kind=image|document` · `GET admin/partner-applications?status=&cursor=` · `PATCH admin/partner-applications/:id` · `POST admin/partner-applications/:id/decisions`

### rewards (`/rewards`, `/promo-codes`, `/leaderboards`, `/admin/*`)
`GET rewards/wallet` · `POST rewards/checkin` (daily streak) · `GET rewards/quests` · `GET rewards/badges` (`iconKey`) · `GET leaderboards?sportId=&scope=weekly|monthly&districtId=` (public) · `POST/GET/PATCH/DELETE promo-codes` (admin/owner; `PATCH` pause/resume via `{ active }`) · `POST admin/quests` · `POST admin/badges` · `GET/PATCH admin/platform-settings`

### pulse (`/pulse`) — implements the blueprint's §19.3 contract field-for-field
`GET pulse?scope=&sportId=&cursor=&limit=` returns `{ items, nextCursor, metrics, serverTime }`; each item includes `claimedByMe`, `reason`, `friendsCount`, `version`. `GET/PUT/DELETE pulse/availability/me` · `GET pulse/opportunities/:id` · `POST pulse/opportunities/:id/claims` (Idempotency-Key) · `DELETE pulse/opportunities/:id/claims/me` · `POST pulse/lobbies/:id/join` · `DELETE pulse/lobbies/:id/members/me`

### notifications (`/notifications`)
`GET` (cursor) · `GET unread-count` · `PATCH :id/read` · `PATCH read-all`

### owner (`/owner`, owner/staff/admin)
`GET overview` (includes latest **application status** + `nextAction` + `analyticsLocked`) · `GET calendar?venueId=&date=` (bookings **and** blocks) · `POST calendar/walk-in` · `POST calendar/blocks` · `DELETE calendar/blocks/:id` · `GET finance?venueId=&from=&to=` · `GET finance/export` (UTF-8 CSV) · `GET customers?venueId=` · `POST/GET staff-invites` · `POST staff-invites/:id/accept|revoke` · `PATCH staff-invites/:id` `{ status: accepted|suspended|revoked }` · `GET/POST/DELETE payout-methods` · `POST bookings/verify-qr` · `POST bookings/:id/no-show` · `POST bookings/:id/cancel` · `POST bookings/:id/checkin`

### admin (`/admin`, `/reports`)
`POST reports` (any authenticated user — files a report against post/review/chat/player/venue) · `GET admin/overview` (KPI wall) · `GET admin/moderation/reports?status=open|resolved|dismissed` · `PATCH admin/moderation/reports/:id` · `GET admin/audit-log` · `GET/POST admin/feature-flags` · `GET admin/analytics/funnel|cohorts`

---

## 6. Realtime (Socket.IO)

One gateway (`realtime/realtime.gateway.ts`). Handshake: client connects with `auth: { token: <access JWT> }`; the gateway verifies it server-side and joins the socket to `user:<id>` automatically — `emitToUser()` elsewhere in the codebase never needs per-feature room bookkeeping. Feature rooms are joined only after a server-side authorization check (never trusting a client-supplied room id):

- `chat.thread.join { threadId }` → joins `thread:<id>` only if the caller is an actual `ChatThreadParticipant`.
- `squad.lobby.join { squadId }` → joins `squad:<id>` only if the caller is an actual `SquadMember`.
- Voice (WebRTC mesh, no SFU): `voice.offer` / `voice.answer` / `voice.ice` / `voice.speaking` / `voice.hangup` — relayed only between verified squad members. Clients fetch ICE servers from `GET /squad/ice-servers`.

**Events emitted** (client subscribes by `type`):

| Type | Emitted by | When |
|---|---|---|
| `presence.changed` | gateway | socket connect/disconnect (also pushed to friends) |
| `friend.request.created` / `friend.request.resolved` | `FriendsService` | send/accept/decline/cancel |
| `chat.thread.created` | `ChatService` | new direct thread |
| `chat.message.created` / `chat.message.updated` | `ChatService` | new / edited / deleted message |
| `chat.read-state.changed` | `ChatService` | read-state update |
| `chat.typing.changed` | gateway | `chat.typing` client event, relayed after membership check |
| `match.join_request.created` / `.resolved` | `MatchPostsService` | join request lifecycle |
| `match.comment.created` | `MatchPostsService` | new feed comment |
| `squad.invite.created` / `.resolved` | `SquadService` | invite lifecycle |
| `squad.join_request.created` | `SquadService` | non-leader-initiated invite → leader approval queue |
| `squad.member.kicked` / `.leader.changed` / `.member.muted` | `SquadService` | roster/moderation actions |
| `voice.offer` / `voice.answer` / `voice.ice` / `voice.speaking` / `voice.hangup` | gateway | WebRTC signaling |
| `pulse.availability.changed` / `pulse.opportunity.changed` | `PulseService` / `JobsService` | availability set, claim expiry |
| `notification.created` | `NotificationsService` | any new in-app notification |

This is a **single-instance** presence/realtime implementation (an in-memory `Map` in `PresenceService`). Horizontally scaling to multiple API instances needs a Redis-backed Socket.IO adapter (`@socket.io/redis-adapter`) and moving `PresenceService`'s state into Redis — both are additive changes, nothing here needs to be redesigned to add them later.

---

## 7. Environment variables

See `.env.example` for the authoritative list with inline comments. Summary:

| Variable | Purpose | Dev default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | local `mal3ab_dev` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Token signing (min 32 chars, boot fails without them) | generate with `openssl rand -hex 32` |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Token lifetimes | `15m` / `7d` |
| `SALT_ROUNDS` | bcrypt cost | `10` |
| `GOOGLE_CLIENT_ID` / `APPLE_CLIENT_ID` + friends | OAuth | empty → those two endpoints 501 |
| `OTP_PROVIDER` | `console` only for now | `console` |
| `STORAGE_PROVIDER` | `local` or `s3` | `local` |
| `AWS_*` / `S3_*` | only read when `STORAGE_PROVIDER=s3` | empty |
| `SMTP_*` | email; empty → logs instead of sending | empty |
| `QR_SIGNING_SECRET` | HMAC key for booking QR payloads (min 32 chars) | generate with `openssl rand -hex 32` |
| `CORS_ORIGINS` | comma-separated allowed origins | `http://localhost:4200` |
| `FCM_SERVER_KEY` | optional FCM legacy key for push | empty → in-app + socket only |
| `STUN_URLS` / `TURN_*` | WebRTC ICE for squad voice | Google STUN; TURN empty until you add a TURN server |

Startup fails fast with a clear message (Joi schema in `common/config/env.validation.ts`) if a required secret is missing — no silent fallback-to-a-literal-secret, which is what the original boilerplate did (`JWT_SECRET || 'sccccc'` in three places).

---

## 8. What's intentionally stubbed — do not mistake these for bugs

- **SMS delivery** — `OtpDelivery` logs to the console. Implement the interface (`modules/sms/otp-delivery.interface.ts`) against a real provider (Twilio etc.) and swap it in `sms.module.ts`; nothing else changes, because the OTP never touches an HTTP response.
- **OAuth secrets** — Google/Apple sign-in verify real tokens correctly but 501 until real client IDs are in `.env`. Not a mock — it's the real verification flow, just unconfigured.
- **Payments** — `MockPaymentProvider` always "succeeds" (except cash, which stays pending). Swap `PaymentProvider` for a real PSP integration in `payments.module.ts`; `BookingsService` never changes.
- **S3** — `StorageProvider` interface has a full working S3 implementation; it's just not the active one until `STORAGE_PROVIDER=s3` and real AWS credentials are set.
- **Squad voice media path** — WebRTC **signaling is fully implemented** (offer/answer/ICE/speaking/hangup + `GET /squad/ice-servers`). Audio itself is peer-to-peer in the browser. A TURN server (`TURN_URLS`) is needed for players behind strict NAT; a hosted SFU (LiveKit/mediasoup) is only required if you outgrow a 7-person mesh.
- **Push notifications (FCM)** — device-token registration, per-category preferences, in-app inbox, and socket `notification.created` all work. HTTP push fires when `FCM_SERVER_KEY` is set; otherwise tokens are stored and delivery stays in-app/socket.
- **Analytics depth** — `admin/analytics/funnel` and `/cohorts` are honest aggregate queries but intentionally simple.
- **Realtime horizontal scaling** — see the note at the end of §6.
- **Partner upload malware scanning** — MIME + size are enforced (images JPEG/PNG/WebP ≤5 MB; documents PDF/JPEG/PNG ≤1 MB). Virus scanning is not wired; production should add a scanner in front of object storage.
- **Payout identifier encryption** — full account numbers are **not** stored. Only a masked identifier and last-4 metadata are kept. Tokenization / payout-provider onboarding is a swap-in.
- **Swimming shared-session capacity** — court `spec` JSON captures pool fields from onboarding; live shared inventory / `Slot.capacity` is not implemented (blueprint §12.3 / §20.4).
- **Geocoder proxy** — partners confirm lat/lng from the client. Nominatim should be proxied in production; the API does not call OSM itself.

---

## 9. Blueprint alignment pass (2026-09-05)

This pass re-read `angular/PROJECT_BLUEPRINT.md` §§1–21 and closed the gaps that the earlier backend (through §19) did not cover. Everything below is live in `mal3ab-api`.

### 9.1 What was missing vs the blueprint

The frontend added two committed sections after the original API:

- **§20 Partners onboarding** — six-step application, username/password partner accounts, versioned drafts, admin review queue, `changes_requested` / `rejected`, atomic publish on approve.
- **§21 Owner operations dashboard** — application status on overview, calendar blocks, walk-in validation, QR verify outcomes, no-show, staff-by-email roles, masked payout methods, finance CSV, pause/resume promotions.

The previous backend only had `POST /owner/venues` + `POST /admin/venues/:id/approve|suspend` (`pending|active|suspended`). There was no application record, no username, no blocks, no payout settings, and QR check-in threw generic 400s instead of the scanner outcomes.

### 9.2 Partner applications (§20.9) — server-authoritative

Owner id, role, timestamps and approval state are **never** taken from the request body. Session + DB win.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/partners/register` | public, 5/min | Username 4–30 (`/^[A-Za-z][A-Za-z0-9_.]{3,29}$/`), password 10–128 with letters **and** numbers. Unique username/email/phone. Existing phone-only player is upgraded to `owner`. |
| POST | `/api/v1/partners/login` | public, 10/min | Username **or** email + password. Rejects pure player accounts (`NOT_A_PARTNER`). |
| GET | `/api/v1/partners/username-availability?username=` | public | Normalized lowercase check. Final create still has a unique index. |
| GET | `/api/v1/partners/applications` | owner/admin | Cursor page of **this** owner's applications + `allowedActions` + history. |
| POST | `/api/v1/partners/applications` | owner/admin | Create `draft`. Owner from JWT. |
| PATCH | `/api/v1/partners/applications/:id` | owner/admin | Save owned editable draft. `If-Match` / `version`. Pending/rejected/suspended cannot be overwritten (`APPLICATION_NOT_EDITABLE`). Editing an **approved** listing moves it to `draft` and sets the venue `pending` (removed from discovery). |
| POST | `/api/v1/partners/applications/:id/submit` | owner/admin | Domain gate (`APPLICATION_INCOMPLETE` lists every failing rule). Always lands on `pending`, never publishes. |
| POST | `/api/v1/partners/uploads?kind=image\|document` | owner/admin | Object-storage upload. Images JPEG/PNG/WebP ≤5 MB; documents PDF/JPEG/PNG ≤1 MB. |
| GET | `/api/v1/admin/partner-applications?status=&cursor=` | admin | Review queue. |
| PATCH | `/api/v1/admin/partner-applications/:id` | admin | Public name/description/address amendment + reason (10–1000 chars). Returns the application to `pending`. |
| POST | `/api/v1/admin/partner-applications/:id/decisions` | admin | `{ action: approve\|reject\|request_changes\|suspend, note?, version? }`. Reject / request-changes / suspend require a 10–1000 character note. |

State machine (matches §20.6):

```
draft ──submit──> pending
pending ──request_changes──> changes_requested ──resubmit──> pending
pending ──approve──> approved ──suspend──> suspended
pending ──reject──> rejected
suspended ──approve──> approved
suspended ──request_changes──> changes_requested
approved ──owner PATCH──> draft ──resubmit──> pending
approved/pending/changes_requested ──admin PATCH──> pending
```

**Submit validation (same rules as the frontend domain gate):** trimmed public names, E.164 contact, governorate/district belonging to the chosen country, confirmed lat/lng (never `0,0`), 1–20 courts, duration in `{30,45,60,90,120,180}`, positive base price, optional `peak >= base`, at least one open weekday, 15-minute opening hours, overnight close < open, 1–8 photos, consent. Optional: description, legal name, registration, house rules, verification document, peak price.

**Approve** runs in one transaction: create or update the venue, replace courts/photos/sports/amenities/pricing (base + weekend peak 17:00–22:00 when peak ≠ base), copy `weeklyHours` / contact / legal fields, set venue `active`, bump application version, append an immutable event, notify the owner. Courts that still have live bookings are not deleted. **Suspend** sets venue `suspended` so public search and new bookings stop.

### 9.3 Owner operations (§21)

| Surface | Backend behavior |
|---|---|
| Overview | Latest application `status` + `nextAction` **before** KPIs. `analyticsLocked` is true until an application is `approved` (or there are no venues). |
| Calendar | Day agenda = bookings + `CalendarBlock`. Walk-in validates court ownership, `slotEnd > slotStart`, live-booking overlap (`SLOT_ALREADY_HELD`) and block overlap (`SLOT_BLOCKED`). Guest name/phone stored on the booking. |
| Blocks | `POST /owner/calendar/blocks` (`maintenance` \| `private`, optional court). Rejects overlap with live bookings (`BLOCK_OVERLAPS_BOOKING`). |
| Bookings | Owner cancel / no-show / check-in by id. List supports `status` + `q` (code, guest, player name). |
| QR | `POST /owner/bookings/verify-qr` returns **200** `{ outcome, booking }` with `invalid` \| `not-found` \| `wrong-venue` \| `already-used` \| `not-confirmed` \| `ok`. Accepts signed `qrPayload`, JSON `{ bookingId, code }`, or visible `code`. Check-in remains atomic and records `checkedInByUserId`. |
| Finance | Gross from paid confirmed/completed bookings, commission from `CommissionSetting` (default 5% = 500 bps), net = gross − commission. `GET /owner/finance/export` is a UTF-8 CSV (BOM) of only that owner's venue rows. |
| Promotions | Create/list scoped to the owner's venues. `PATCH /promo-codes/:id { active }` pause/resume. Percentage ≤ 100. `validUntil > validFrom`. Search `hasOffers` only counts **active** codes in window. |
| Team | Invite by **email and/or phone**, `operationalRole`: `reception` \| `manager` \| `accountant`. Duplicate pending/accepted invites → `STAFF_ALREADY_INVITED`. Activate / suspend / revoke. |
| Settings | `PayoutMethod` bank / InstaPay / wallet. Identifier is masked; full number is not returned. |
| Slots | `GET /courts/:id/slots` respects venue `weeklyHours` (including overnight) and calendar blocks (`state: blocked`). |

### 9.4 Other blueprint alignments in this pass

- Search `date` / `from` / `to` (country timezone) so “available tonight” is inventory, not a synonym of `instantBook`.
- Badges expose `iconKey` (falls back to `icon`).
- Pulse feed already had `metrics`, `serverTime`, `claimedByMe`, `reason`; `friendsCount` is now on each item.
- Multi-slot hold already accepted `units` 1–3; `coinsToRedeem` is now an integer ≥ 0.
- `AllExceptionsFilter` adds `code` for machine tokens and maps username unique-violations to `USERNAME_TAKEN`.
- Username unique index + availability endpoint. Partner login rate-limited.

### 9.5 Stable error codes

| `code` | HTTP | When |
|---|---|---|
| `SLOT_ALREADY_HELD` | 409 | Live booking overlap (player hold or walk-in) |
| `SLOT_BLOCKED` | 409 | Walk-in hits a calendar block |
| `BLOCK_OVERLAPS_BOOKING` | 409 | Block hits a live booking |
| `PULSE_CAPACITY_CHANGED` | 409 | Pulse claim lost the race |
| `PULSE_EXPIRED` | 410 | Opportunity past `expiresAt` |
| `APPLICATION_VERSION_CONFLICT` | 409 | Stale `If-Match` / `version` |
| `APPLICATION_NOT_EDITABLE` | 409 | Owner tried to PATCH pending/rejected/suspended |
| `APPLICATION_NOT_SUBMITTABLE` | 409 | Submit from a non-draft / non-changes_requested row |
| `APPLICATION_INCOMPLETE` | 400 | Submit domain gate failed (message lists rules) |
| `INVALID_DECISION` | 409 | Illegal status → action |
| `DECISION_NOTE_REQUIRED` | 400 | Reject / request-changes / suspend without a useful note |
| `INVALID_AREA` / `INVALID_SPORT` | 400 | Geo hierarchy or sport id wrong on submit |
| `USERNAME_INVALID` / `USERNAME_TAKEN` | 400 / 409 | Username shape / unique index |
| `ACCOUNT_EXISTS` | 409 | Partner register collision |
| `NOT_A_PARTNER` | 403 | Player tried partner login |
| `IDENTIFIER_REQUIRED` | 400 | Partner login missing username and email |
| `STAFF_ALREADY_INVITED` | 409 | Duplicate staff invite |

QR **verify** does not throw those outcomes; it returns them in `result.outcome` so the scanner UI can branch. Actual check-in still throws if the booking is not confirmed or already used.

### 9.6 Files added or substantially changed

```
prisma/schema.prisma
prisma/migrations/20260905080000_partner_onboarding_owner_ops/migration.sql
prisma/seed.ts                                          — owner username `elmalek`
src/modules/partners/**                                 — new module
src/modules/owner/owner.service.ts + owner.controller.ts
src/modules/owner/dto/owner-operations.dto.ts
src/modules/bookings/bookings.service.ts                — QR verify, no-show, hours/blocks
src/modules/venues/venues.service.ts                    — date/from/to availability
src/modules/auth/auth.service.ts                        — registerPartner / loginPartner
src/modules/rewards/**                                  — promo pause, badge iconKey, venue scope
src/common/filters/all-exceptions.filter.ts
src/common/errors/api-exception.ts
src/common/utils/username.util.ts
src/common/utils/weekly-hours.util.ts
src/common/uploads/document-upload.ts
src/modules/app/app.module.ts                           — PartnersModule
```

Verification: `tsc --noEmit -p tsconfig.build.json` passed. Jest 31/31 (auth, bookings, geo, timezone, QR, username, weekly hours, partner submit gate). Migration `20260905080000_partner_onboarding_owner_ops` applied to `mal3ab_dev`. Seed owner username is `elmalek`.

---

## 10. Local setup (recap — see `README.md` for the short version)

```bash
npm install
cp .env.example .env        # then fill in secrets, see §7
createdb mal3ab_dev
npm run prisma:migrate
npm run seed
npm run start:dev
```

Health check: `GET /` → `{ status: "ok", service: "mal3ab-api", time: ... }`. Swagger: `GET /api/docs`.

## 11. Verifying the money path yourself

This exact sequence was run against a live local instance during development and confirmed working end-to-end, including the concurrency guard:

1. `POST /auth/otp/request` → `POST /auth/otp/verify` as a player.
2. `POST /auth/register` as an owner → `POST /owner/venues` → `POST /owner/venues/:id/courts` → `POST /owner/courts/:id/pricing-rules`.
3. Admin approves: `POST /admin/venues/:id/approve`.
4. `GET /venues?sportId=` and `GET /courts/:id/slots?date=` as the player.
5. `POST /bookings/hold` — try it twice concurrently for the same slot from two accounts: the second gets `409 SLOT_ALREADY_HELD`.
6. `POST /bookings/:id/confirm` — price breakdown (base + service fee) computed server-side from `PricingRule`, payment mocked as `paid`, QR payload issued.
7. `POST /bookings/checkin` as the owner with that QR payload — booking flips to `completed`, coins are awarded (spend-based + first-booking bonus), verified via `GET /users/me`.
8. `POST /reviews` — only possible now that the booking is `completed`; venue `ratingAvg`/`ratingCount` recompute on the next `GET /venues/:id/reviews`.
