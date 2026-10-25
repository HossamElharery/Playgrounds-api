# Matchena production hardening — execution prompt

Use this prompt for the next infrastructure and capacity phase. It covers work
that cannot be proved safely by application-code changes alone.

## Prompt

You are responsible for hardening Matchena for a high-traffic campaign without
interrupting production. Work from evidence, preserve existing data and user
changes, and make every rollout reversible. The application is an Angular SSR
frontend and NestJS/Socket.IO/Prisma/PostgreSQL backend currently hosted on one
4-vCPU/8-GB VPS through Coolify/Traefik. Camo and other realtime features keep
process-local state, so do not add API replicas until that state is externalized
or sessions are deliberately pinned. Never claim a concurrency number without
a representative load test.

First audit and record the current DNS, firewall, Coolify services, containers,
resource limits, PostgreSQL settings and pool usage, backups, TLS, environment
variables, health checks, deploy strategy, Sentry alerts, API latency/error
rates, Socket.IO connection/event rates, and host CPU/RAM/disk/network. Redact
secrets from every artifact. Take and verify recoverable backups before any
stateful change.

Deliver the following in staged, tested phases:

1. Put Cloudflare in front of `matchena.com`, `www.matchena.com`, and
   `api.matchena.com`; enable proxied DNS, managed DDoS protection, sensible WAF
   managed rules, bot controls, request/body limits, and route-specific rate
   rules. Preserve WebSocket support. Restrict the VPS firewall and origin so
   web traffic is accepted only from Cloudflare/required administration paths;
   prevent direct-origin bypass. Document emergency rollback and avoid locking
   out SSH/Coolify.
2. Add reproducible load tests (prefer k6 plus a Socket.IO-capable harness) for
   anonymous browsing, login/refresh, venue/search/booking reads and writes,
   uploads, lobby presence, chat/voice signaling, and Camo join/play/reconnect.
   Model ramp, spike, soak, reconnect storm, abusive payload, slow-client, and
   database-degradation scenarios. Use non-production data or an isolated
   staging environment. Define pass/fail SLOs for p50/p95/p99 latency, errors,
   event-loop lag, CPU, memory, DB pool wait, active connections, and dropped
   Socket.IO messages. Determine safe sustained and burst concurrency, then set
   campaign admission limits from measured headroom.
3. Introduce Redis with authentication, persistence policy, resource limits,
   backups, and monitoring. Replace process-local distributed concerns with
   Redis-backed implementations: Socket.IO adapter/pub-sub, shared HTTP and
   WebSocket rate limiting, presence, transient lobby/game coordination where
   correctness requires it, idempotency/cache entries, and job leadership.
   Specify TTLs and failure behavior. Do not silently weaken authorization or
   create split-brain game state.
4. Make realtime games safe for horizontal scaling. Inventory every in-memory
   map, timer, room, match, lobby, presence and cooldown. Choose and implement a
   tested design (authoritative game workers with routing, or externalized
   state), reconnect recovery, ownership leases/fencing tokens, graceful drain,
   and zero-loss rolling deploy behavior. Only then add at least two API
   instances behind Traefik and prove cross-instance WebSocket behavior.
5. Protect PostgreSQL: measure query latency and connection utilization; inspect
   slow queries and indexes; eliminate N+1/hot polling; configure Prisma pool
   limits/timeouts per replica; add PgBouncer in the correct transaction/session
   mode after compatibility testing; isolate/bound background jobs; apply query
   timeouts; monitor locks, long transactions, deadlocks, disk and replication
   lag. Verify booking/payment/idempotency correctness under concurrency.
6. Remove large upload buffering from API memory. Prefer direct signed object
   storage uploads with MIME/signature validation, size limits, malware/media
   processing isolation, quotas, expiry and cleanup. Until migrated, enforce
   strict per-user/IP rate and concurrency limits and confirm proxy body/time
   limits.
7. Add production observability: versioned releases and uploaded hidden source
   maps in Sentry, deploy markers, scrubbed PII, actionable alert thresholds,
   dashboards for HTTP/Socket.IO/Postgres/Redis/host metrics, synthetic checks,
   and on-call runbooks. Alerts must distinguish real users from local/synthetic
   smoke tests and must not expose tokens, cookies, request bodies, or personal
   data.
8. Make deployments resilient: immutable images, pinned/runtime-supported Node
   versions, CI tests/build/security scans, migration preflight, backward-
   compatible expand/contract migrations, readiness/liveness checks, graceful
   shutdown and connection drain, rolling/canary rollout, automatic rollback,
   and a tested maintenance/drain switch for games and bookings.
9. Establish disaster recovery: encrypted automated Postgres and object-storage
   backups stored off-host, retention policy, restore drills, documented RPO/RTO,
   secrets rotation, least privilege, audit logs, dependency/container scanning,
   and an incident response playbook for DDoS, credential compromise, database
   saturation, payment incidents, and host loss.

For every phase provide: evidence and baseline, design/tradeoffs, exact config or
code changes, tests and results, security/privacy impact, rollout steps,
monitoring, rollback, and remaining risk. Start with staging and low-risk edge
protection. Stop before any destructive change, DNS cutover, firewall lockout,
database migration, paid purchase, or production deploy unless the human owner
has explicitly approved that exact step. Finish with a capacity report giving a
measured safe user range by workload—not one unsupported “maximum users” number.

## Already completed locally (verify after merge/deploy)

- Layered HTTP throttling, including authenticated GET requests.
- Per-IP Socket.IO connection limiting, per-socket event limiting, 64-KiB packet
  cap, compression disabled, and bounded handshake/heartbeat timeouts.
- Presence heartbeat database writes coalesced to at most once per user/minute.
- Tight rate limits on the current 80-MiB in-memory post-upload endpoint.
- Frontend Sentry filter for loopback/local production-bundle smoke tests.

