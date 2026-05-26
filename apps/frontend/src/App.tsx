import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  api,
  type DrillPayload,
  type GradeResult,
  type Mode,
  type RealtimeSettings,
  type RealtimeUsageEvent,
  type SessionPayload,
  type SessionSummary,
  type UsageSummary,
  type VoiceProvider,
} from "./api.ts";
import {
  useRealtime,
  type RealtimeDebugEvent,
  type RealtimeMessage,
} from "./useRealtime.ts";
import { useElevenLabs } from "./useElevenLabs.ts";

const MODES: { value: Mode; label: string }[] = [
  { value: "mixed", label: "Mixed" },
  { value: "rapid_fundamentals", label: "Rapid fundamentals" },
  { value: "db_indexes", label: "DB indexes" },
  { value: "system_design", label: "System design" },
  { value: "weak_topics", label: "Weak topics" },
  { value: "mock_interview", label: "Mock interview" },
];
const AUTO_ADVANCE_SECONDS = 3;
const REALTIME_SETTINGS_STORAGE_KEY = "drillCoachRealtimeSettings";
const INTERACTION_MODE_STORAGE_KEY = "drillCoachInteractionMode";
const VOICE_PROVIDER_STORAGE_KEY = "drillCoachVoiceProvider";
type InteractionMode = "text" | "voice";
const DEFAULT_REALTIME_SETTINGS: RealtimeSettings = {
  voice_speed: 1.25,
  vad: {
    mode: "semantic_vad",
    threshold: 0.5,
    prefix_padding_ms: 500,
    silence_duration_ms: 1200,
    eagerness: "low",
    interrupt_response: true,
  },
};
const kbdStyle: CSSProperties = {
  padding: "0.05rem 0.25rem",
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "#0a0c12",
  color: "inherit",
  font: "inherit",
};

interface ConceptReference {
  label: string;
  href: string;
}

interface ConceptEntry {
  id: string;
  title: string;
  subtitle: string;
  aliases: string[];
  tags: string[];
  summary: string;
  talkTrack: string[];
  example: string;
  references: ConceptReference[];
}

const CONCEPTS: ConceptEntry[] = [
  {
    id: "cache-stampede",
    title: "Cache stampede / thundering herd",
    subtitle: "failure mode",
    aliases: [
      "cache stampede",
      "thundering herd",
      "stampede",
      "hammer the database",
      "all miss",
    ],
    tags: ["caching", "traffic spike"],
    summary:
      "Many callers hit the same expired cache key, miss together, and all recompute or fetch from the database at once.",
    talkTrack: [
      "Name the failure: one hot key expires and turns normal traffic into a backend spike.",
      "State the goal: collapse concurrent misses so only one expensive rebuild runs.",
      "Then add a policy for the other callers: wait briefly, serve stale, or retry after the cache is refilled.",
    ],
    example:
      "Product page key P123 expires. Ten thousand requests arrive. Without protection they all query Postgres; with protection one request rebuilds P123 and the rest wait or get the previous value.",
    references: [
      {
        label: "Cloudflare: probabilistic cache stampede prevention",
        href: "https://blog.cloudflare.com/sometimes-i-cache/",
      },
      {
        label: "Optimal Probabilistic Cache Stampede Prevention paper",
        href: "https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf",
      },
    ],
  },
  {
    id: "single-flight",
    title: "Single-flight",
    subtitle: "duplicate suppression",
    aliases: [
      "single-flight",
      "single flight",
      "singleflight",
      "duplicate suppression",
      "coalesce concurrent misses",
      "coalesce",
      "coalescing",
    ],
    tags: ["caching", "concurrency"],
    summary:
      "Single-flight means concurrent callers for the same key share one in-flight operation instead of starting duplicates.",
    talkTrack: [
      "Use the cache key as the single-flight key.",
      "The first miss starts the rebuild; later misses attach to that in-flight work.",
      "When it completes, everyone receives the same result and the cache is filled once.",
    ],
    example:
      "All requests for product P123 call singleFlight.do('product:P123', rebuild). Only the first request runs rebuild; the others receive its result.",
    references: [
      {
        label: "Go singleflight package",
        href: "https://pkg.go.dev/golang.org/x/sync/singleflight",
      },
    ],
  },
  {
    id: "per-key-lock",
    title: "Per-key lock",
    subtitle: "mutual exclusion",
    aliases: ["per-key lock", "per key lock", "lock", "locking", "mutex"],
    tags: ["caching", "coordination"],
    summary:
      "A per-key lock serializes rebuilds for one cache key without blocking unrelated keys.",
    talkTrack: [
      "Do not use one global lock for the whole cache.",
      "Lock product:P123 while rebuilding only that product key.",
      "Set a timeout so a crashed rebuilder cannot block the key forever.",
    ],
    example:
      "The lock name is cache-rebuild:product:P123. Requests for P124 can still rebuild independently.",
    references: [
      {
        label: "Redis distributed locks",
        href: "https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/",
      },
    ],
  },
  {
    id: "rebuild-once",
    title: "Rebuild once",
    subtitle: "cache fill rule",
    aliases: [
      "rebuild once",
      "rebuilds the value",
      "fills the cache",
      "one request rebuilds",
    ],
    tags: ["caching", "write path"],
    summary:
      "The expensive backend read or recomputation should run once, then publish the fresh value back into cache for everyone else.",
    talkTrack: [
      "Acquire the per-key guard before doing the expensive work.",
      "Recheck the cache after acquiring the guard; another request may have already filled it.",
      "Write the rebuilt value with a TTL before releasing the guard.",
    ],
    example:
      "After winning the lock, request A rereads cache P123, still misses, queries Postgres once, writes cache P123, and releases.",
    references: [
      {
        label: "Go singleflight package",
        href: "https://pkg.go.dev/golang.org/x/sync/singleflight",
      },
    ],
  },
  {
    id: "serve-stale",
    title: "Wait or serve stale",
    subtitle: "caller policy",
    aliases: [
      "others wait or serve stale",
      "wait or serve stale",
      "serve stale",
      "serves stale",
      "previous stale value",
      "stale value",
    ],
    tags: ["availability", "latency"],
    summary:
      "When one request is rebuilding, other callers either wait for the fresh value or receive the last known good stale value.",
    talkTrack: [
      "Waiting gives fresher data but can add latency.",
      "Serving stale protects latency and the database, but users may see older data.",
      "The right choice depends on whether freshness or availability matters more for this endpoint.",
    ],
    example:
      "A product description can often be stale for 30 seconds. Inventory checkout probably should wait or fail closed instead.",
    references: [
      {
        label: "RFC 5861 stale controls",
        href: "https://www.rfc-editor.org/rfc/rfc5861",
      },
    ],
  },
  {
    id: "probabilistic-refresh",
    title: "Probabilistic refresh",
    subtitle: "early refresh",
    aliases: [
      "probabilistic refresh",
      "probabilistic early refresh",
      "probabilistic early expiration",
      "early refresh",
      "refresh before expiry",
    ],
    tags: ["caching", "prevention"],
    summary:
      "Refresh starts before the hard TTL with a probability that rises near expiry, so one caller refreshes before the crowd arrives.",
    talkTrack: [
      "It prevents synchronized expiry instead of only reacting after expiry.",
      "The refresh chance is low when the item is fresh and higher as it nears TTL.",
      "It is useful for very hot keys where even a short expired window creates a spike.",
    ],
    example:
      "At 90 percent of TTL, one request may refresh P123 in the background; by actual expiry the cache is already warm.",
    references: [
      {
        label: "Cloudflare: Sometimes I Cache",
        href: "https://blog.cloudflare.com/sometimes-i-cache/",
      },
      {
        label: "Optimal Probabilistic Cache Stampede Prevention paper",
        href: "https://cseweb.ucsd.edu/~avattani/papers/cache_stampede.pdf",
      },
    ],
  },
  {
    id: "stale-while-revalidate",
    title: "Stale-while-revalidate",
    subtitle: "serve stale plus background refresh",
    aliases: [
      "stale-while-revalidate",
      "stale while revalidate",
      "swr",
      "background revalidation",
      "revalidate",
    ],
    tags: ["http cache", "latency"],
    summary:
      "A stale value can be served immediately while a background task refreshes the cache for the next caller.",
    talkTrack: [
      "The user gets a fast response from the last known good value.",
      "A background refresh updates the cache asynchronously.",
      "Bound the stale window so broken refreshes do not serve old data forever.",
    ],
    example:
      "Cache-Control: max-age=60, stale-while-revalidate=300 means fresh for 60 seconds, then stale can be served while refresh happens for up to 5 minutes.",
    references: [
      {
        label: "RFC 5861 stale-while-revalidate",
        href: "https://www.rfc-editor.org/rfc/rfc5861",
      },
    ],
  },
  {
    id: "ttl-jitter",
    title: "TTL jitter",
    subtitle: "expiry spreading",
    aliases: ["ttl jitter", "jitter", "randomized ttl", "spread expirations"],
    tags: ["caching", "prevention"],
    summary:
      "TTL jitter adds a small random offset to expirations so many keys do not expire at the exact same time.",
    talkTrack: [
      "It spreads load across time when many related keys are written together.",
      "It is complementary to single-flight; jitter reduces spikes, single-flight handles the remaining misses.",
      "Keep the jitter small enough that business freshness guarantees still hold.",
    ],
    example:
      "Instead of every product key expiring at 300 seconds, use 270-330 seconds so rebuilds are spread out.",
    references: [
      {
        label: "Cloudflare cache stampede article",
        href: "https://blog.cloudflare.com/sometimes-i-cache/",
      },
    ],
  },
  {
    id: "k8s-liveness-readiness",
    title: "Liveness vs readiness probes",
    subtitle: "kubernetes health checks",
    aliases: [
      "liveness vs readiness",
      "liveness readiness",
      "liveness probe",
      "liveness probes",
      "readiness probe",
      "readiness probes",
      "health checks",
      "probes",
    ],
    tags: ["kubernetes", "availability"],
    summary:
      "Liveness decides whether Kubernetes should restart a container; readiness decides whether the pod should receive traffic.",
    talkTrack: [
      "A slow response under load is usually a readiness or capacity signal, not proof the process is dead.",
      "Use readiness to pull an overloaded pod out of service without restarting it.",
      "Reserve liveness for unrecoverable stuck states where a restart is actually helpful.",
    ],
    example:
      "/healthz can stay liveness-only and check the process loop. /ready can fail when dependencies, queues, or load make the pod unable to serve traffic.",
    references: [
      {
        label: "Kubernetes: Liveness, Readiness, and Startup Probes",
        href: "https://kubernetes.io/docs/concepts/workloads/pods/probes/",
      },
    ],
  },
  {
    id: "k8s-probe-thresholds",
    title: "Probe thresholds and timeouts",
    subtitle: "probe tuning",
    aliases: [
      "probe sizing",
      "probe timeout",
      "probe timeout is",
      "timeoutSeconds",
      "timeout seconds",
      "periodSeconds",
      "period 5 seconds",
      "failureThreshold",
      "failure threshold",
      "3 failures",
      "generous thresholds",
      "aggressive timeout",
      "1-second timeout",
      "one second timeout",
      "5 seconds under load",
    ],
    tags: ["kubernetes", "timeouts"],
    summary:
      "Probe timing controls how quickly Kubernetes declares failure. Too-aggressive liveness timing can create restart loops during normal load.",
    talkTrack: [
      "Compute the restart window as roughly timeoutSeconds plus failureThreshold times periodSeconds.",
      "If the app sometimes takes 5 seconds under load, a 1-second liveness timeout is too strict.",
      "Make liveness slower and stricter about true deadlock; use readiness for fast traffic shedding.",
    ],
    example:
      "With timeoutSeconds=1, periodSeconds=5, failureThreshold=3, three slow checks can restart a pod even when the app would have recovered.",
    references: [
      {
        label: "Kubernetes: Configure probes",
        href: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
      },
    ],
  },
  {
    id: "k8s-startup-probe",
    title: "Startup probe",
    subtitle: "cold-start guard",
    aliases: [
      "startupProbe",
      "startupprobe",
      "startup probe",
      "startup probes",
      "cold start",
      "cold starts",
      "initialization",
    ],
    tags: ["kubernetes", "startup"],
    summary:
      "A startup probe gives slow-starting containers a separate startup window before liveness and readiness probes take over.",
    talkTrack: [
      "Use it when cold starts are slower than steady-state health checks.",
      "Until startup succeeds, Kubernetes does not run liveness or readiness for that container.",
      "After startup succeeds, normal liveness can be tighter because it no longer has to cover cold start.",
    ],
    example:
      "A service that warms caches for 45 seconds can use a startupProbe budget long enough for warmup, then use liveness only for deadlocks.",
    references: [
      {
        label: "Kubernetes: Startup probe behavior",
        href: "https://kubernetes.io/docs/concepts/workloads/pods/probes/",
      },
    ],
  },
  {
    id: "transactional-outbox",
    title: "Transactional outbox",
    subtitle: "dual-write fix",
    aliases: [
      "transactional outbox",
      "outbox pattern",
      "outbox in same transaction",
      "outbox row",
      "outbox rows",
      "outbox",
      "dual-write",
      "dual write",
      "db write and an outbox row",
      "same db transaction",
      "same transaction",
    ],
    tags: ["messaging", "consistency"],
    summary:
      "The database state change and a durable outbox event row are written atomically in one DB transaction.",
    talkTrack: [
      "Do not try to atomically commit Postgres and Kafka directly from app code.",
      "Write the business row and the outbox row in the same database transaction.",
      "A separate relay later publishes the outbox row to Kafka, so a crash cannot lose the event after the DB commit.",
    ],
    example:
      "Create order O123 and insert outbox event order.created in the same Postgres transaction. If the service crashes after commit, the relay still finds the row and publishes it.",
    references: [
      {
        label: "Microservices.io: Transactional outbox",
        href: "https://microservices.io/patterns/data/transactional-outbox.html",
      },
    ],
  },
  {
    id: "outbox-relay",
    title: "Outbox relay process",
    subtitle: "publisher loop",
    aliases: [
      "relay process",
      "separate relay process",
      "separate publisher",
      "publisher reads the outbox",
      "reads unpublished outbox rows",
      "marking them sent",
      "marks them sent",
      "published outbox rows",
      "unpublished outbox rows",
      "replay service",
      "replaying",
    ],
    tags: ["messaging", "kafka"],
    summary:
      "The relay is a worker that reads unsent outbox rows, publishes them to Kafka, and records success.",
    talkTrack: [
      "The request path only commits to Postgres; it does not need Kafka to be up at that instant.",
      "The relay can retry failed publishes until Kafka accepts the event.",
      "Mark rows sent only after publish succeeds, and expect occasional duplicate publishes around crashes.",
    ],
    example:
      "A relay polls outbox where sent_at is null, publishes each event, then updates sent_at. If it crashes after publish but before sent_at, it may publish that event again.",
    references: [
      {
        label: "Debezium: Outbox event router",
        href: "https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html",
      },
    ],
  },
  {
    id: "idempotent-consumers",
    title: "Idempotent consumers",
    subtitle: "duplicate safety",
    aliases: [
      "idempotent consumers",
      "consumer idempotent",
      "consumers idempotent",
      "idempotent",
      "at-least-once",
      "at least once",
      "duplicates",
      "duplicate delivery",
      "without side effects",
    ],
    tags: ["messaging", "retries"],
    summary:
      "Consumers must handle duplicate events because outbox relays and Kafka-style delivery are usually at-least-once.",
    talkTrack: [
      "Outbox protects against losing events, not against seeing the same event twice.",
      "Give each event a stable id and have consumers dedupe or make writes naturally idempotent.",
      "This is the tradeoff: reliable delivery plus duplicate tolerance.",
    ],
    example:
      "The billing consumer stores processed_event_ids. If order.created event e7 arrives twice, the second copy is acknowledged without charging again.",
    references: [
      {
        label: "Microservices.io: Idempotent consumer",
        href: "https://microservices.io/patterns/communication-style/idempotent-consumer.html",
      },
    ],
  },
  {
    id: "cdc-outbox",
    title: "CDC as outbox relay",
    subtitle: "log-based publishing",
    aliases: [
      "cdc",
      "debezium",
      "alternative relay",
      "cdc tools",
      "log-based",
    ],
    tags: ["messaging", "cdc"],
    summary:
      "Change data capture can publish committed outbox rows by reading the database log instead of polling the table.",
    talkTrack: [
      "The app still writes an outbox row in the same transaction.",
      "CDC observes the committed row from the database log and emits it to Kafka.",
      "This can reduce custom relay code, but you still design consumers for at-least-once delivery.",
    ],
    example:
      "Debezium reads the Postgres WAL, sees an inserted outbox row, routes it to the right Kafka topic, and preserves commit order per aggregate when configured that way.",
    references: [
      {
        label: "Debezium outbox event router",
        href: "https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html",
      },
    ],
  },
  {
    id: "http-connection-reuse",
    title: "HTTP keep-alive and connection reuse",
    subtitle: "reuse TCP/TLS",
    aliases: [
      "keep-alive",
      "keep alive",
      "connection reuse",
      "reuse tcp tls connections",
      "reuse tcp+tls connections",
      "reusing connections",
      "reuse connections",
      "tcp+tls connections",
      "tcp tls connections",
    ],
    tags: ["http", "latency"],
    summary:
      "Keep-alive reuses an existing TCP/TLS connection so each request does not pay setup and handshake cost again.",
    talkTrack: [
      "For high RPS HTTPS calls, a fresh connection per request wastes RTTs and CPU.",
      "Reuse existing connections with keep-alive or a client connection pool.",
      "Measure p99 latency before and after; the win is often removing repeated TCP/TLS setup.",
    ],
    example:
      "Instead of 1000 requests opening 1000 TLS sessions, a client keeps a small set of warm connections to the same upstream and sends requests over them.",
    references: [
      {
        label: "MDN: HTTP connection management",
        href: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x",
      },
    ],
  },
  {
    id: "connection-pool-sizing",
    title: "Connection pool sizing",
    subtitle: "bounded concurrency",
    aliases: [
      "connection pool",
      "connection pooling",
      "connection pool size",
      "sized connection pool",
      "client connection pool",
      "per-host limits",
    ],
    tags: ["http client", "backpressure"],
    summary:
      "A connection pool should be large enough for useful parallelism and bounded so a slow downstream cannot consume unbounded resources.",
    talkTrack: [
      "Too small: callers queue behind too few connections and p99 rises.",
      "Too large: the client can overload the downstream or exhaust local sockets.",
      "Set per-host limits and timeouts, then tune from observed concurrency, latency, and error rates.",
    ],
    example:
      "If the downstream is healthy at 100 concurrent requests but degrades at 400, cap the pool near the safe range and shed or queue excess work deliberately.",
    references: [
      {
        label: "MDN: Persistent connections",
        href: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x",
      },
    ],
  },
  {
    id: "thread-pool-sizing",
    title: "Thread pool sizing",
    subtitle: "cpu vs io bound",
    aliases: [
      "thread pool",
      "thread pools",
      "worker pool",
      "worker pools",
      "pool size",
      "size a worker pool",
      "size the worker pool",
      "sizing rule of thumb",
      "bound the pool",
      "bounded pool",
      "50 and 200 threads",
    ],
    tags: ["concurrency", "performance"],
    summary:
      "Worker-pool size depends on whether work is CPU-bound or IO-bound; CPU-bound tracks cores, IO-bound can be larger because threads wait.",
    talkTrack: [
      "CPU-bound work should stay near core count because extra runnable threads mainly add context switching.",
      "IO-bound work can use more threads because many are blocked waiting on network or disk.",
      "Treat formulas as a starting point; measure under realistic load and keep the pool bounded.",
    ],
    example:
      "On a 16-core box, CPU-bound hashing might use about 16 workers. IO-bound calls with 80 percent wait time may need many more, but still behind a queue and back-pressure.",
    references: [
      {
        label: "Go blog: Concurrency is not parallelism",
        href: "https://go.dev/blog/waza-talk",
      },
    ],
  },
  {
    id: "cpu-vs-io-bound",
    title: "CPU-bound vs IO-bound work",
    subtitle: "capacity model",
    aliases: [
      "cpu-bound",
      "cpu bound",
      "io-bound",
      "io bound",
      "distinguish io vs cpu",
      "wait/compute",
      "wait compute",
      "cores ×",
      "cores x",
      "number of cores",
    ],
    tags: ["concurrency", "sizing"],
    summary:
      "CPU-bound work consumes cores while it runs; IO-bound work spends much of its lifetime waiting for external systems.",
    talkTrack: [
      "For CPU-bound work, the scarce resource is CPU execution slots.",
      "For IO-bound work, the scarce resource is often outstanding waits, so useful concurrency can exceed core count.",
      "The wait/compute ratio explains why IO pools are often larger than CPU pools.",
    ],
    example:
      "If each task computes for 10 ms and waits on IO for 90 ms, many threads can be waiting while a smaller number actively use CPU.",
    references: [
      {
        label: "Little's law overview",
        href: "https://en.wikipedia.org/wiki/Little%27s_law",
      },
    ],
  },
  {
    id: "context-switch-cost",
    title: "Context switch cost",
    subtitle: "too many runnable threads",
    aliases: [
      "context switch",
      "context switches",
      "context switch cost",
      "extra context switches",
    ],
    tags: ["cpu", "threads"],
    summary:
      "Too many runnable threads make the OS spend more time switching between them instead of doing useful work.",
    talkTrack: [
      "Extra threads do not create extra cores.",
      "For CPU-heavy tasks, oversizing the pool increases scheduling overhead and cache disruption.",
      "This is why CPU-bound worker pools usually start near core count.",
    ],
    example:
      "A 16-core machine running 200 CPU-bound workers will spend more time competing for cores than a pool sized near 16.",
    references: [
      {
        label: "Go blog: scheduler/concurrency intuition",
        href: "https://go.dev/blog/waza-talk",
      },
    ],
  },
  {
    id: "backpressure-queueing",
    title: "Back-pressure and queueing",
    subtitle: "bounded overload",
    aliases: [
      "back-pressure",
      "backpressure",
      "queueing",
      "queuing",
      "queue",
      "bound or queue saturates",
      "fail fast",
      "resource exhaustion",
      "oom",
    ],
    tags: ["reliability", "overload"],
    summary:
      "A bounded queue and back-pressure make overload explicit instead of allowing unbounded work to consume memory or threads.",
    talkTrack: [
      "A bounded pool needs a policy for excess work: queue briefly, reject, shed, or slow callers.",
      "Unbounded queues hide overload until latency or memory explodes.",
      "Back-pressure protects the service by making upstreams feel saturation.",
    ],
    example:
      "When all 100 IO workers are busy, accept at most 1000 queued jobs; after that return 429 or shed low-priority work.",
    references: [
      {
        label: "Reactive Streams: back pressure",
        href: "https://www.reactive-streams.org/",
      },
    ],
  },
  {
    id: "tls-handshake-cost",
    title: "TLS handshake cost",
    subtitle: "setup overhead",
    aliases: [
      "tls handshake",
      "tls handshake cost",
      "handshake cost",
      "fresh handshakes",
      "handshakes dominate",
    ],
    tags: ["https", "latency"],
    summary:
      "A TLS handshake negotiates keys and security parameters before application data flows; repeated handshakes can dominate tail latency.",
    talkTrack: [
      "HTTPS setup is not free: TCP connect plus TLS negotiation adds network round trips and CPU.",
      "Connection reuse amortizes that cost over many requests.",
      "If handshakes dominate p99, look for disabled keep-alive, low idle timeouts, or clients creating new transports per request.",
    ],
    example:
      "A 20 ms API call can become 100 ms at p99 if every request also performs DNS, TCP connect, and TLS setup.",
    references: [
      {
        label: "MDN: Transport Layer Security",
        href: "https://developer.mozilla.org/en-US/docs/Web/Security/Transport_Layer_Security",
      },
    ],
  },
  {
    id: "head-of-line-blocking",
    title: "Head-of-line blocking",
    subtitle: "queueing delay",
    aliases: [
      "head-of-line blocking",
      "head of line blocking",
      "hol blocking",
      "line blocking",
      "blocking when the downstream slows",
    ],
    tags: ["queues", "latency"],
    summary:
      "Head-of-line blocking happens when work at the front of a queue delays independent work behind it.",
    talkTrack: [
      "A pool creates a queue when all connections are busy.",
      "If the downstream slows, callers behind slow requests wait even if they could otherwise proceed.",
      "Bound the pool and add deadlines so queueing is explicit instead of silently growing p99.",
    ],
    example:
      "With 10 pooled connections, 10 slow requests occupy the whole pool. The 11th request waits even if it would be quick once sent.",
    references: [
      {
        label: "HTTP/3 explained: TCP head-of-line blocking",
        href: "https://http3-explained.haxx.se/en/why-quic/why-tcphol",
      },
    ],
  },
];

const CONCEPT_BY_ID = new Map(CONCEPTS.map((concept) => [concept.id, concept]));
const CONCEPT_ALIAS_PAIRS = CONCEPTS.flatMap((concept) =>
  [concept.title, ...concept.aliases].map((alias) => ({
    alias,
    normalized: normalizeConceptText(alias),
    concept,
  })),
).sort((a, b) => b.normalized.length - a.normalized.length);
const CONCEPT_BY_ALIAS = new Map(
  CONCEPT_ALIAS_PAIRS.map((item) => [item.normalized, item.concept]),
);
const TERM_ALIAS_PATTERN = CONCEPT_ALIAS_PAIRS.filter(
  (item) => item.normalized.length >= 5,
)
  .map((item) => escapeRegex(item.alias))
  .join("|");
const TERM_ALIAS_REGEX = new RegExp(
  `(?<![A-Za-z0-9])(${TERM_ALIAS_PATTERN})(?![A-Za-z0-9])`,
  "gi",
);

function normalizeConceptText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findConceptForText(
  text: string,
  allowedConceptIds?: string[],
): ConceptEntry | null {
  const normalized = normalizeConceptText(text);
  if (!normalized) return null;
  const allowed = allowedConceptIds ? new Set(allowedConceptIds) : null;
  const exact = CONCEPT_ALIAS_PAIRS.find(
    (item) =>
      item.normalized === normalized &&
      (!allowed || allowed.has(item.concept.id)),
  )?.concept;
  if (exact) return exact;
  const padded = ` ${normalized} `;
  const fuzzy = CONCEPT_ALIAS_PAIRS.find(
    (item) =>
      item.normalized.length > 3 &&
      (!allowed || allowed.has(item.concept.id)) &&
      (padded.includes(` ${item.normalized} `) ||
        ` ${item.normalized} `.includes(padded)),
  );
  return fuzzy?.concept ?? null;
}

function collectConceptIds(chunks: string[]): string[] {
  const scores = new Map<string, number>();
  chunks.forEach((chunk, chunkIndex) => {
    const normalized = normalizeConceptText(chunk);
    if (!normalized) return;
    const padded = ` ${normalized} `;
    for (const item of CONCEPT_ALIAS_PAIRS) {
      if (item.normalized.length <= 3) continue;
      const matchIndex = padded.indexOf(` ${item.normalized} `);
      if (matchIndex === -1) continue;
      const score = chunkIndex * 100_000 + matchIndex;
      const previous = scores.get(item.concept.id);
      if (previous === undefined || score < previous) {
        scores.set(item.concept.id, score);
      }
    }
  });
  return [...scores.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

export function App() {
  const [mode, setMode] = useState<Mode>("mixed");
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [drill, setDrill] = useState<DrillPayload | null>(null);
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    drills: number;
    openai_configured: boolean;
    elevenlabs_configured: boolean;
    elevenlabs_api_key_present: boolean;
    voice_provider: VoiceProvider;
  } | null>(null);
  const [progress, setProgress] = useState<
    {
      topic: string;
      subtopic: string;
      weakness_score: number;
      exposure_count: number;
    }[]
  >([]);
  const [troubleDrills, setTroubleDrills] = useState<
    {
      drill_id: string;
      topic: string;
      subtopic: string;
      question_text: string;
      attempts: number;
      avg_score: number;
      last_score: number | null;
    }[]
  >([]);
  const [dueCards, setDueCards] = useState<
    {
      id: string;
      front: string;
      back: string;
      topic: string | null;
      subtopic: string | null;
    }[]
  >([]);
  const [cardStats, setCardStats] = useState<{ total: number; due: number }>({
    total: 0,
    due: 0,
  });
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [drillBrowse, setDrillBrowse] = useState<
    | {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        trap_type: string | null;
        question_text: string;
        canonical_short_answer: string;
        rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
      }[]
    | null
  >(null);
  const [drillBrowseOpen, setDrillBrowseOpen] = useState(false);
  const [drillBrowseFilter, setDrillBrowseFilter] = useState<string>("");
  const [expandedDrill, setExpandedDrill] = useState<string | null>(null);
  const [drillStats, setDrillStats] = useState<{
    total: number;
    active: number;
    drafts: number;
    by_topic: { topic: string; active: number; drafts: number }[];
    by_difficulty: { difficulty: number; active: number; drafts: number }[];
    by_trap_type: { trap_type: string; count: number }[];
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [recentSessions, setRecentSessions] = useState<
    | {
        id: string;
        mode: Mode;
        started_at: string;
        ended_at: string | null;
        drills_attempted: number;
        drills_graded: number;
        average_score: number;
      }[]
    | null
  >(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [ending, setEnding] = useState(false);
  const [expandedAttemptId, setExpandedAttemptId] = useState<string | null>(
    null,
  );
  const [attemptDetail, setAttemptDetail] = useState<{
    attempt: {
      id: string;
      transcript: string | null;
      duration_seconds: number | null;
      score: number | null;
      verdict: "pass" | "borderline" | "fail" | null;
      missed_points: string[] | null;
      ideal_answer: string | null;
    };
    drill: { question_text: string } | null;
  } | null>(null);
  const [drillCount, setDrillCount] = useState(0);
  const [pressureMode, setPressureMode] = useState(false);
  const [realtimeSettings, setRealtimeSettings] = useState<RealtimeSettings>(
    readRealtimeSettings,
  );
  const [interactionMode, setInteractionMode] = useState<InteractionMode>(
    readInteractionMode,
  );
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>(
    readVoiceProvider,
  );
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [resuming, setResuming] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [sessionEvents, setSessionEvents] = useState<
    {
      id: number;
      event_type: string;
      payload: Record<string, unknown> | null;
      created_at: string;
    }[]
  >([]);
  const MOCK_TARGET = 7;
  const SESSION_STORAGE_KEY = "drillCoachSession";
  const [drafts, setDrafts] = useState<
    | {
        id: string;
        topic: string;
        subtopic: string;
        difficulty: number;
        trap_type: string | null;
        question_text: string;
        canonical_short_answer: string;
        rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
      }[]
    | null
  >(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [testTranscript, setTestTranscript] = useState<Record<string, string>>(
    {},
  );
  const [testResult, setTestResult] = useState<
    Record<string, { score: number; verdict: string; missed: number } | null>
  >({});
  const [editingDrill, setEditingDrill] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    must_have: string;
    nice_to_have: string;
    red_flags: string;
    canonical_short_answer: string;
    difficulty: number;
  }>({
    must_have: "",
    nice_to_have: "",
    red_flags: "",
    canonical_short_answer: "",
    difficulty: 3,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [autoAdvanceRemaining, setAutoAdvanceRemaining] = useState<number | null>(
    null,
  );

  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const pushedVoiceDrillRef = useRef<string | null>(null);
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const appliedRealtimeSettingsRef = useRef(JSON.stringify(realtimeSettings));
  const lastRealtimeTranscriptRef = useRef("");
  const openaiRealtime = useRealtime();
  const elevenLabsRealtime = useElevenLabs();
  const realtime =
    voiceProvider === "elevenlabs" ? elevenLabsRealtime : openaiRealtime;
  const voiceConnected = realtime.status === "connected";
  const voiceConnecting = realtime.status === "connecting";
  const voiceSessionActive = voiceConnected || voiceConnecting;
  const voicePolishEnabled = interactionMode === "voice";
  const voiceAutoAdvance = voicePolishEnabled;
  const voiceProviderReady =
    voiceProvider === "elevenlabs"
      ? Boolean(health?.elevenlabs_configured)
      : Boolean(health?.openai_configured);
  const voiceCanStart = voiceProviderReady && !voiceSessionActive;
  const voiceCanRetry = Boolean(
    drill && voicePolishEnabled && voiceProviderReady && !voiceSessionActive,
  );
  const usageLabel = usageSummary
    ? session
      ? `tokens ${formatTokens(usageSummary.session?.total_tokens ?? 0)} session / ${formatTokens(usageSummary.total.total_tokens)} total`
      : `tokens ${formatTokens(usageSummary.total.total_tokens)} total`
    : "tokens ...";
  const isRapidFundamentalsMode =
    (session?.mode ?? mode) === "rapid_fundamentals";

  useEffect(() => {
    window.localStorage.setItem(
      REALTIME_SETTINGS_STORAGE_KEY,
      JSON.stringify(realtimeSettings),
    );
  }, [realtimeSettings]);

  useEffect(() => {
    window.localStorage.setItem(INTERACTION_MODE_STORAGE_KEY, interactionMode);
  }, [interactionMode]);

  useEffect(() => {
    window.localStorage.setItem(VOICE_PROVIDER_STORAGE_KEY, voiceProvider);
  }, [voiceProvider]);

  useEffect(() => {
    if (voiceProvider === "openai" && elevenLabsRealtime.status !== "idle") {
      void elevenLabsRealtime.stop();
    }
    if (voiceProvider === "elevenlabs" && openaiRealtime.status !== "idle") {
      void openaiRealtime.stop();
    }
  }, [
    elevenLabsRealtime.status,
    elevenLabsRealtime.stop,
    openaiRealtime.status,
    openaiRealtime.stop,
    voiceProvider,
  ]);

  useEffect(() => {
    const key = JSON.stringify(realtimeSettings);
    if (!voiceConnected) {
      appliedRealtimeSettingsRef.current = key;
      return;
    }
    if (appliedRealtimeSettingsRef.current === key) return;
    appliedRealtimeSettingsRef.current = key;
    realtime.updateSessionSettings(realtimeSettings);
  }, [realtime.updateSessionSettings, realtimeSettings, voiceConnected]);

  // Stream realtime transcript into the textarea once captured.
  useEffect(() => {
    if (!realtime.transcript) return;
    setTranscript((current) => {
      const previous = lastRealtimeTranscriptRef.current;
      lastRealtimeTranscriptRef.current = realtime.transcript;
      if (!current.trim() || current === previous) return realtime.transcript;
      return current;
    });
  }, [realtime.transcript]);

  const startVoiceForDrill = useCallback(
    async (nextDrill: DrillPayload) => {
      if (realtime.status === "connected") {
        if (pushedVoiceDrillRef.current !== nextDrill.attempt_id) {
          realtime.pushDrill(nextDrill.question_text, {
            pressure: pressureMode,
            attemptId: nextDrill.attempt_id,
            autoAdvance: voiceAutoAdvance,
          });
          pushedVoiceDrillRef.current = nextDrill.attempt_id;
        }
        return;
      }
      pushedVoiceDrillRef.current = nextDrill.attempt_id;
      await realtime.start(nextDrill.question_text, {
        pressure: pressureMode,
        attemptId: nextDrill.attempt_id,
        settings: realtimeSettings,
        autoAdvance: voiceAutoAdvance,
      });
    },
    [
      pressureMode,
      realtime.pushDrill,
      realtime.start,
      realtime.status,
      realtimeSettings,
      voiceAutoAdvance,
    ],
  );

  // When a new drill is selected while voice is live, push it to the agent.
  useEffect(() => {
    if (
      drill &&
      realtime.status === "connected" &&
      pushedVoiceDrillRef.current !== drill.attempt_id
    ) {
      realtime.pushDrill(drill.question_text, {
        pressure: pressureMode,
        attemptId: drill.attempt_id,
        autoAdvance: voiceAutoAdvance,
      });
      pushedVoiceDrillRef.current = drill.attempt_id;
    }
  }, [drill, pressureMode, realtime.pushDrill, realtime.status, voiceAutoAdvance]);

  // Keep the resume bookmark fresh when mode or pressure toggle mid-session.
  useEffect(() => {
    if (!session) return;
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        session_id: session.id,
        mode,
        pressure_mode: pressureMode,
        interaction_mode: interactionMode,
      }),
    );
  }, [interactionMode, mode, pressureMode, session]);

  useEffect(() => {
    api
      .health()
      .then((h) =>
        setHealth({
          drills: h.drills,
          openai_configured: h.openai_configured,
          elevenlabs_configured: Boolean(h.elevenlabs_configured),
          elevenlabs_api_key_present: Boolean(h.elevenlabs_api_key_present),
          voice_provider: h.voice_provider ?? "openai",
        }),
      )
      .catch((e) => setError((e as Error).message));
  }, []);

  // Persist session bookmark in localStorage so a refresh resumes where
  // the user left off. The backend already has all the durable state
  // (attempts, weakness, cards); we just need the session id + mode.
  useEffect(() => {
    let cancelled = false;
    const raw =
      typeof window !== "undefined"
        ? window.localStorage.getItem(SESSION_STORAGE_KEY)
        : null;
    if (!raw) return;
    let parsed: {
      session_id?: string;
      mode?: Mode;
      pressure_mode?: boolean;
      interaction_mode?: InteractionMode;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    if (!parsed.session_id) return;
    setResuming(true);
    void (async () => {
      try {
        const sum = await api.sessionSummary(parsed.session_id!);
        if (cancelled) return;
        if (sum.ended_at) {
          window.localStorage.removeItem(SESSION_STORAGE_KEY);
          return;
        }
        setSession({
          id: sum.session_id,
          user_id: "demo-user",
          mode: sum.mode,
        });
        setMode(sum.mode);
        if (parsed.pressure_mode) setPressureMode(true);
        if (parsed.interaction_mode) setInteractionMode(parsed.interaction_mode);
        const openAttempt = sum.attempts
          .slice()
          .reverse()
          .find((a) => a.score === null);
        if (openAttempt) {
          const bank = await api.drills();
          if (cancelled) return;
          const item = bank.drills.find((d) => d.id === openAttempt.drill_id);
          if (item) {
            setDrill({
              drill_id: item.id,
              attempt_id: openAttempt.attempt_id,
              question_text: item.question_text,
              topic: item.topic,
              subtopic: item.subtopic,
              difficulty: item.difficulty,
              expected_answer_shape: item.rubric.must_have,
              rubric: item.rubric,
            });
            setDrillCount(sum.drills_attempted);
            return;
          }
        }
        // No open attempt to resume, so create the next pending attempt.
        const d = await api.nextDrill(sum.session_id, sum.mode);
        if (cancelled) return;
        setDrill(d);
        setDrillCount(sum.drills_attempted + 1);
        startedAtRef.current = Date.now();
        setElapsed(0);
      } catch {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsed(0);
    setRunning(true);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 250);
  }, []);

  const stopTimer = useCallback((): number => {
    setRunning(false);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = null;
    const start = startedAtRef.current ?? Date.now();
    return Math.max(1, Math.round((Date.now() - start) / 1000));
  }, []);

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearInterval(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    setAutoAdvanceRemaining(null);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const r = await api.usageSummary(session?.id);
      setUsageSummary(r);
    } catch (e) {
      console.warn("usage refresh failed:", (e as Error).message);
    }
  }, [session?.id]);

  // Register the Realtime tool handler. When the agent calls a backend
  // tool, we proxy to /api/realtime/tool-call and mirror agent-driven
  // results into local state (so the UI follows the agent's lead).
  useEffect(() => {
    if (!session) {
      realtime.setToolHandler(null);
      return;
    }
    realtime.setToolHandler(async (call) => {
      const result = await api.toolCall(
        session.id,
        call.name,
        call.arguments,
        session.user_id,
      );
      if (call.name === "get_next_drill" && !result.error) {
        clearAutoAdvance();
        const driven: DrillPayload = {
          drill_id: String(result.drill_id ?? ""),
          attempt_id: String(result.attempt_id ?? ""),
          question_text: String(result.question_text ?? ""),
          topic: String(result.topic ?? ""),
          subtopic: String(result.subtopic ?? ""),
          difficulty: Number(result.difficulty ?? 0),
          expected_answer_shape: Array.isArray(result.expected_answer_shape)
            ? (result.expected_answer_shape as string[])
            : [],
          rubric: {
            must_have: Array.isArray(result.expected_answer_shape)
              ? (result.expected_answer_shape as string[])
              : [],
            nice_to_have: [],
            red_flags: [],
          },
        };
        pushedVoiceDrillRef.current = driven.attempt_id;
        setDrill(driven);
        setGrade(null);
        setTranscript("");
        startTimer();
      }
      if (call.name === "grade_attempt" && !result.error) {
        const cardsOut = Array.isArray(result.cards)
          ? (result.cards as { front: string; back: string }[])
          : [];
        setGrade({
          attempt_id: String(result.attempt_id ?? ""),
          score: Number(result.score ?? 0),
          verdict:
            (result.verdict as "pass" | "borderline" | "fail" | undefined) ??
            "fail",
          missed_points: Array.isArray(result.missed_points)
            ? (result.missed_points as string[])
            : [],
          ideal_short_answer: String(result.ideal_short_answer ?? ""),
          cards: cardsOut,
          breakdown: {
            must_have_coverage: 0,
            answer_clarity: 0,
            tradeoff_coverage: 0,
            speed_score: 0,
            red_flag_penalty: 0,
          },
        });
        void refreshUsage();
      }
      return result;
    });
    return () => realtime.setToolHandler(null);
  }, [clearAutoAdvance, realtime.setToolHandler, refreshUsage, session, startTimer]);

  const onStart = useCallback(async () => {
    clearAutoAdvance();
    setError(null);
    setGrade(null);
    setTranscript("");
    setDrillCount(0);
    try {
      const s = await api.startSession(mode);
      setSession(s);
      window.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          session_id: s.id,
          mode,
          pressure_mode: pressureMode,
          interaction_mode: interactionMode,
        }),
      );
      const d = await api.nextDrill(s.id, mode);
      setDrill(d);
      setDrillCount(1);
      startTimer();
      setUsageSummary(await api.usageSummary(s.id));
      if (voicePolishEnabled && voiceProviderReady) {
        await startVoiceForDrill(d);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [
    clearAutoAdvance,
    interactionMode,
    mode,
    pressureMode,
    startTimer,
    startVoiceForDrill,
    voiceProviderReady,
    voicePolishEnabled,
  ]);

  const onNext = useCallback(async () => {
    if (!session) return;
    clearAutoAdvance();
    setError(null);
    setGrade(null);
    setTranscript("");
    try {
      const d = await api.nextDrill(session.id, mode);
      setDrill(d);
      setDrillCount((c) => c + 1);
      startTimer();
      if (voicePolishEnabled && voiceProviderReady) {
        await startVoiceForDrill(d);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [
    clearAutoAdvance,
    mode,
    session,
    startTimer,
    startVoiceForDrill,
    voiceProviderReady,
    voicePolishEnabled,
  ]);

  // Retry the current drill (creates a fresh attempt on the same drill,
  // bypassing rotation). Useful right after a fail when the rubric is
  // still fresh in mind.
  const onRetry = useCallback(async () => {
    if (!session || !drill) return;
    clearAutoAdvance();
    setError(null);
    setGrade(null);
    setTranscript("");
    try {
      const d = await api.retryDrill(session.id, drill.drill_id);
      setDrill(d);
      setDrillCount((c) => c + 1);
      startTimer();
      if (voicePolishEnabled && voiceProviderReady) {
        await startVoiceForDrill(d);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [
    clearAutoAdvance,
    drill,
    session,
    startTimer,
    startVoiceForDrill,
    voiceProviderReady,
    voicePolishEnabled,
  ]);

  useEffect(() => {
    clearAutoAdvance();
    if (
      !voiceConnected ||
      !voiceAutoAdvance ||
      realtime.isAgentSpeaking ||
      !grade ||
      !drill ||
      grade.attempt_id !== drill.attempt_id
    ) {
      return;
    }

    let remaining = AUTO_ADVANCE_SECONDS;
    setAutoAdvanceRemaining(remaining);
    autoAdvanceTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      setAutoAdvanceRemaining(remaining);
      if (remaining <= 0) {
        clearAutoAdvance();
        void onNext();
      }
    }, 1000) as unknown as number;

    return clearAutoAdvance;
  }, [
    clearAutoAdvance,
    drill,
    grade,
    onNext,
    realtime.isAgentSpeaking,
    voiceAutoAdvance,
    voiceConnected,
  ]);

  const onSubmit = useCallback(async () => {
    if (!drill) return;
    if (!transcript.trim()) {
      setError("Type or speak an answer first.");
      return;
    }
    setError(null);
    const duration = running ? stopTimer() : Math.max(1, elapsed);
    setGrading(true);
    try {
      const result = await api.grade(drill.attempt_id, transcript, duration);
      setGrade(result);
      void refreshUsage();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGrading(false);
    }
  }, [drill, elapsed, refreshUsage, running, stopTimer, transcript]);

  const verdictClass = useMemo(() => {
    if (!grade) return "";
    return `verdict-${grade.verdict}`;
  }, [grade]);

  const currentConceptIds = useMemo(() => {
    const chunks: string[] = [];
    if (drill) {
      chunks.push(
        drill.question_text,
        drill.topic,
        drill.subtopic,
        ...drill.expected_answer_shape,
        ...drill.rubric.must_have,
        ...drill.rubric.nice_to_have,
        ...drill.rubric.red_flags,
      );
    }
    if (grade) {
      chunks.push(
        ...grade.missed_points,
        grade.ideal_short_answer,
        ...grade.cards.flatMap((card) => [card.front, card.back]),
      );
    }
    return collectConceptIds(chunks);
  }, [drill, grade]);

  const activeConcept = useMemo(() => {
    const selected = selectedConceptId && currentConceptIds.includes(selectedConceptId)
      ? CONCEPT_BY_ID.get(selectedConceptId)
      : null;
    if (selected) return selected;
    const firstCurrent = currentConceptIds[0];
    return firstCurrent ? CONCEPT_BY_ID.get(firstCurrent) ?? null : null;
  }, [currentConceptIds, selectedConceptId]);

  useEffect(() => {
    if (!grade) return;
    if (currentConceptIds.length === 0) {
      setSelectedConceptId(null);
      return;
    }
    setSelectedConceptId((current) =>
      current && currentConceptIds.includes(current)
        ? current
        : currentConceptIds[0] ?? null,
    );
  }, [currentConceptIds, grade]);

  const selectConcept = useCallback((id: string) => {
    setSelectedConceptId(id);
  }, []);

  const onSelectionZoom = useCallback(() => {
    const selected = window.getSelection()?.toString().trim();
    if (!selected || selected.length > 80) return;
    const concept = findConceptForText(selected, currentConceptIds);
    if (concept) selectConcept(concept.id);
  }, [currentConceptIds, selectConcept]);

  const refreshSidecar = useCallback(async () => {
    try {
      const [prog, due, perf] = await Promise.all([
        api.progress(),
        api.cardsDue(30),
        api.progressDrills(8),
      ]);
      setProgress(prog.skills);
      setDueCards(due.cards);
      setCardStats(due.stats);
      // "Trouble drills" = lowest avg_score among drills with >=2 attempts.
      setTroubleDrills(
        perf.drills
          .filter((d) => d.attempts >= 2)
          .slice(0, 3)
          .map((d) => ({
            drill_id: d.drill_id,
            topic: d.topic,
            subtopic: d.subtopic,
            question_text: d.question_text,
            attempts: d.attempts,
            avg_score: d.avg_score,
            last_score: d.last_score,
          })),
      );
    } catch (e) {
      // sidecar is non-fatal — surface but keep going
      console.warn("sidecar refresh failed:", (e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  useEffect(() => {
    if (!session) {
      realtime.setUsageHandler(null);
      return;
    }
    realtime.setUsageHandler(async (event: RealtimeUsageEvent) => {
      try {
        await api.recordRealtimeUsage({
          session_id: session.id,
          attempt_id: drill?.attempt_id,
          drill_id: drill?.drill_id,
          source: event.source,
          model: event.model,
          response_id: event.response_id,
          usage: event.usage,
        });
        void refreshUsage();
      } catch (e) {
        console.warn("usage record failed:", (e as Error).message);
      }
    });
    return () => realtime.setUsageHandler(null);
  }, [
    drill?.attempt_id,
    drill?.drill_id,
    realtime.setUsageHandler,
    refreshUsage,
    session,
  ]);

  // Pull the session_events audit log whenever the timeline is open or
  // the session/grade state changes — so the user sees a fresh trace
  // after every drill turn.
  const refreshSessionEvents = useCallback(async () => {
    if (!session) {
      setSessionEvents([]);
      return;
    }
    try {
      const r = await api.sessionEvents(session.id);
      setSessionEvents(r.events);
    } catch (e) {
      console.warn("session events refresh failed:", (e as Error).message);
    }
  }, [session]);

  useEffect(() => {
    if (!session || !eventsOpen) return;
    void refreshSessionEvents();
  }, [session, eventsOpen, grade, drill, refreshSessionEvents]);

  // Refresh sidecar (progress, due cards) on mount and after every grade.
  useEffect(() => {
    void refreshSidecar();
  }, [refreshSidecar, grade]);

  const onEndSession = useCallback(async () => {
    if (!session) return;
    setEnding(true);
    setError(null);
    try {
      const s = await api.endSession(session.id);
      await realtime.stop();
      stopTimer();
      setSummary(s);
      void refreshUsage();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEnding(false);
    }
  }, [realtime.stop, refreshUsage, session, stopTimer]);

  const onResetSession = useCallback(() => {
    clearAutoAdvance();
    stopTimer();
    setSummary(null);
    setSession(null);
    setDrill(null);
    setGrade(null);
    setTranscript("");
    setDrillCount(0);
    void realtime.stop();
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }, [clearAutoAdvance, realtime.stop, stopTimer]);

  // Keyboard shortcuts for the drill loop. Designed for the canonical
  // "type then submit then next" rhythm, so Cmd/Ctrl+Enter works from
  // inside the textarea while the single-key shortcuts (n, e, p) are
  // disabled when any input/textarea/select has focus.
  useEffect(() => {
    function isTextFocus(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }
    const handler = (ev: KeyboardEvent) => {
      const meta = ev.metaKey || ev.ctrlKey;
      // Cmd/Ctrl + Enter always submits, even from the textarea.
      if (meta && ev.key === "Enter") {
        if (drill && !grading) {
          ev.preventDefault();
          void onSubmit();
        }
        return;
      }
      if (isTextFocus(ev.target)) return;
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      switch (ev.key.toLowerCase()) {
        case "n":
          if (session && drill && !grading) {
            ev.preventDefault();
            void onNext();
          }
          break;
        case "r":
          // Shift+R = retry current drill. Plain `r` reserved so we don't
          // intercept anything an autocomplete might use.
          if (ev.shiftKey && session && drill && grade && !grading) {
            ev.preventDefault();
            void onRetry();
          }
          break;
        case "e":
          if (session && !ending && !grading) {
            ev.preventDefault();
            void onEndSession();
          }
          break;
        case "p":
          ev.preventDefault();
          setPressureMode((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    drill,
    ending,
    grade,
    grading,
    onEndSession,
    onRetry,
    onNext,
    onSubmit,
    session,
  ]);

  const refreshDrafts = useCallback(async () => {
    try {
      const r = await api.drafts();
      setDrafts(r.drills);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onToggleDrafts = useCallback(async () => {
    setDraftsOpen((v) => !v);
    if (!drafts) {
      void refreshDrafts();
    }
  }, [drafts, refreshDrafts]);

  const onToggleHistory = useCallback(async () => {
    setHistoryOpen((v) => !v);
    try {
      const r = await api.recentSessions(25);
      setRecentSessions(r.sessions);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onExpandAttempt = useCallback(async (attemptId: string) => {
    setExpandedAttemptId(attemptId);
    setAttemptDetail(null);
    try {
      const r = await api.attemptDetail(attemptId);
      setAttemptDetail({
        attempt: {
          id: r.attempt.id,
          transcript: r.attempt.transcript,
          duration_seconds: r.attempt.duration_seconds,
          score: r.attempt.score,
          verdict: r.attempt.verdict,
          missed_points: r.attempt.missed_points,
          ideal_answer: r.attempt.ideal_answer,
        },
        drill: r.drill ? { question_text: r.drill.question_text } : null,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onLoadHistorySession = useCallback(async (sessionId: string) => {
    try {
      const sum = await api.sessionSummary(sessionId);
      setSummary(sum);
      setHistoryOpen(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Resume an unfinished past session: restore it as the current session,
  // re-anchor the localStorage bookmark, find or create an in-progress
  // drill, and close the history panel.
  const onResumeHistorySession = useCallback(
    async (sessionId: string, sessionMode: Mode) => {
      try {
        const sum = await api.sessionSummary(sessionId);
        if (sum.ended_at) {
          // Defensive: history list might be stale; if it ended in the
          // meantime, fall back to summary view.
          setSummary(sum);
          setHistoryOpen(false);
          return;
        }
        setSession({ id: sum.session_id, user_id: "demo-user", mode: sum.mode });
        setMode(sum.mode);
        window.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({
            session_id: sum.session_id,
            mode: sum.mode,
            pressure_mode: pressureMode,
          }),
        );

        const openAttempt = sum.attempts
          .slice()
          .reverse()
          .find((a) => a.score === null);
        if (openAttempt) {
          const bank = await api.drills();
          const item = bank.drills.find(
            (d) => d.id === openAttempt.drill_id,
          );
          if (item) {
            setDrill({
              drill_id: item.id,
              attempt_id: openAttempt.attempt_id,
              question_text: item.question_text,
              topic: item.topic,
              subtopic: item.subtopic,
              difficulty: item.difficulty,
              expected_answer_shape: item.rubric.must_have,
              rubric: item.rubric,
            });
            setDrillCount(sum.drills_attempted);
            setGrade(null);
            setTranscript("");
            setSummary(null);
            setHistoryOpen(false);
            startTimer();
            return;
          }
        }
        // No open attempt — pull a fresh drill.
        const d = await api.nextDrill(sum.session_id, sum.mode);
        setDrill(d);
        setDrillCount(sum.drills_attempted + 1);
        setGrade(null);
        setTranscript("");
        setSummary(null);
        setHistoryOpen(false);
        startTimer();
        // Avoid unused-arg warning when sessionMode wasn't needed.
        void sessionMode;
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [pressureMode, startTimer],
  );

  const onActivateDraft = useCallback(
    async (id: string) => {
      try {
        await api.activateDrill(id);
        // Refresh both drafts and the active browse list.
        await refreshDrafts();
        if (drillBrowse) {
          const r = await api.drills();
          setDrillBrowse(r.drills);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [drillBrowse, refreshDrafts],
  );

  const onDiscardDraft = useCallback(
    async (id: string) => {
      try {
        await api.deleteDrill(id);
        await refreshDrafts();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshDrafts],
  );

  const onStartEdit = useCallback(
    (d: {
      id: string;
      canonical_short_answer: string;
      difficulty: number;
      rubric: { must_have: string[]; nice_to_have: string[]; red_flags: string[] };
    }) => {
      setEditingDrill(d.id);
      setEditForm({
        must_have: d.rubric.must_have.join("\n"),
        nice_to_have: d.rubric.nice_to_have.join("\n"),
        red_flags: d.rubric.red_flags.join("\n"),
        canonical_short_answer: d.canonical_short_answer,
        difficulty: d.difficulty,
      });
    },
    [],
  );

  const onCancelEdit = useCallback(() => {
    setEditingDrill(null);
  }, []);

  const onSaveEdit = useCallback(
    async (id: string) => {
      setSavingEdit(true);
      setError(null);
      const splitLines = (s: string) =>
        s
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
      try {
        await api.patchDrill(id, {
          canonical_short_answer: editForm.canonical_short_answer,
          difficulty: editForm.difficulty,
          rubric: {
            must_have: splitLines(editForm.must_have),
            nice_to_have: splitLines(editForm.nice_to_have),
            red_flags: splitLines(editForm.red_flags),
          },
        });
        // Refresh browse list to reflect saved values.
        const r = await api.drills();
        setDrillBrowse(r.drills);
        setEditingDrill(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSavingEdit(false);
      }
    },
    [editForm],
  );

  const onTestGrade = useCallback(
    async (id: string) => {
      const text = (testTranscript[id] ?? "").trim();
      if (!text) return;
      try {
        const r = await api.testGrade(id, text);
        setTestResult((prev) => ({
          ...prev,
          [id]: {
            score: r.score,
            verdict: r.verdict,
            missed: r.missed_points.length,
          },
        }));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [testTranscript],
  );

  const onOpenDrillBrowse = useCallback(async () => {
    setDrillBrowseOpen((v) => !v);
    if (!drillBrowse) {
      try {
        const [drillsRes, statsRes] = await Promise.all([
          api.drills(),
          api.stats(),
        ]);
        setDrillBrowse(drillsRes.drills);
        setDrillStats(statsRes);
      } catch (e) {
        setError((e as Error).message);
      }
    } else if (!drillStats) {
      // Stats lazy-load even if the bank was cached.
      api
        .stats()
        .then(setDrillStats)
        .catch((e) => console.warn("stats fetch failed:", (e as Error).message));
    }
  }, [drillBrowse, drillStats]);

  const onImportDrillFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const r = await api.importDrills(text);
        if (r.imported > 0) {
          // Refresh drill bank list so the imported rows appear.
          const fresh = await api.drills();
          setDrillBrowse(fresh.drills);
        }
        const msg =
          r.skipped.length > 0
            ? `Imported ${r.imported}, skipped ${r.skipped.length}: ${r.skipped[0]?.error ?? "see server logs"}`
            : `Imported ${r.imported} drill${r.imported === 1 ? "" : "s"}`;
        setError(r.ok ? null : msg);
        if (r.ok) {
          // Use a transient success toast via the error slot? Better to log.
          // eslint-disable-next-line no-console
          console.info(msg);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [],
  );

  const onReviewCard = useCallback(
    async (cardId: string, quality: 0 | 1) => {
      try {
        await api.reviewCard(cardId, quality);
        setDueCards((prev) => prev.filter((c) => c.id !== cardId));
        setRevealed((prev) => {
          const { [cardId]: _omit, ...rest } = prev;
          return rest;
        });
        void refreshSidecar();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshSidecar],
  );

  return (
    <div className="app" onMouseUp={onSelectionZoom} onKeyUp={onSelectionZoom}>
      <header className="app-header">
        <h1>GPT Realtime Interview Drill Coach</h1>
        <div className="row" style={{ gap: "0.5rem" }}>
          <div className="status">
            {health
              ? `${health.drills} drills · OpenAI ${
                  health.openai_configured ? "ready" : "missing key"
                } · ElevenLabs ${
                  health.elevenlabs_configured ? "ready" : "missing setup"
                } · ${usageLabel} · cards ${cardStats.due}/${cardStats.total} due`
              : "..."}
          </div>
          <a
            data-testid="export-cards"
            href="/api/cards/export.csv"
            download="drill-coach-cards.csv"
            style={{
              textDecoration: "none",
              color: "inherit",
              border: "1px solid var(--border)",
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            Export Anki CSV
          </a>
          <a
            data-testid="export-drills"
            href="/api/drills/export.yaml"
            download="drill-bank.yaml"
            title="Download the full active drill bank as YAML (seed format)"
            style={{
              textDecoration: "none",
              color: "inherit",
              border: "1px solid var(--border)",
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              fontSize: "0.85rem",
            }}
          >
            Export drills YAML
          </a>
          <button
            data-testid="pressure-mode-toggle"
            onClick={() => setPressureMode((v) => !v)}
            title="When on, the voice agent interrupts rambling and forces pressure follow-ups."
            style={{
              padding: "0.35rem 0.6rem",
              fontSize: "0.85rem",
              background: pressureMode ? "var(--bad)" : "var(--panel)",
              color: pressureMode ? "#0c1220" : "inherit",
              borderColor: pressureMode ? "var(--bad)" : "var(--border)",
            }}
          >
            Pressure {pressureMode ? "ON" : "off"}
          </button>
          <button
            data-testid="toggle-drill-browse"
            onClick={onOpenDrillBrowse}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
          >
            {drillBrowseOpen ? "Hide" : "Browse"} drills
          </button>
          <button
            data-testid="toggle-drafts"
            onClick={onToggleDrafts}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
            title="Layer-3 generator drafts (is_active=false)"
          >
            {draftsOpen ? "Hide" : "Show"} drafts
            {drafts && drafts.length > 0 ? ` (${drafts.length})` : ""}
          </button>
          {session && (
            <button
              data-testid="toggle-events"
              onClick={() => setEventsOpen((v) => !v)}
              style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
              title="Session audit log (session_events)"
            >
              {eventsOpen ? "Hide" : "Show"} events
            </button>
          )}
          <button
            data-testid="toggle-history"
            onClick={onToggleHistory}
            style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
            title="Past sessions"
          >
            {historyOpen ? "Hide" : "Show"} history
            {recentSessions && recentSessions.length > 0
              ? ` (${recentSessions.length})`
              : ""}
          </button>
        </div>
      </header>

      {progress.length > 0 && (
        <div
          className="panel progress-panel"
          data-testid="progress-strip"
          style={{ gridColumn: "1 / -1", padding: "0.6rem 1rem" }}
        >
          <div className="row" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
            <strong style={{ fontSize: "0.85rem", letterSpacing: "0.02em" }}>
              Skill weakness by subtopic
            </strong>
            <span className="muted" style={{ fontSize: "0.75rem" }}>
              ({progress.length} touched)
            </span>
            <span className="muted" style={{ marginLeft: "auto", fontSize: "0.72rem" }}>
              0% = mastered · 100% = always fails
            </span>
          </div>
          <div data-testid="skill-graph" style={{ display: "grid", gap: "0.25rem" }}>
            {progress
              .slice()
              .sort((a, b) => b.weakness_score - a.weakness_score)
              .map((s) => {
                const pct = Math.round(s.weakness_score * 100);
                const color =
                  s.weakness_score >= 0.7
                    ? "var(--bad)"
                    : s.weakness_score >= 0.4
                      ? "var(--warn)"
                      : "var(--good)";
                return (
                  <div
                    key={`${s.topic}:${s.subtopic}`}
                    className="row"
                    style={{ alignItems: "center", gap: "0.5rem" }}
                  >
                    <span
                      style={{
                        flex: "0 0 180px",
                        fontSize: "0.78rem",
                        color: "var(--muted)",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                      }}
                      title={`${s.topic} · ${s.subtopic} · exposure ${s.exposure_count}`}
                    >
                      {s.topic} · {s.subtopic}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        background: "#0a0c12",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        height: 14,
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: "100%",
                          background: color,
                          transition: "width 200ms ease",
                        }}
                      />
                    </div>
                    <span
                      style={{
                        flex: "0 0 48px",
                        textAlign: "right",
                        fontSize: "0.75rem",
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--muted)",
                      }}
                    >
                      {pct}%
                    </span>
                  </div>
                );
              })}
          </div>
          {troubleDrills.length > 0 && (
            <div
              data-testid="trouble-drills"
              style={{
                marginTop: "0.6rem",
                paddingTop: "0.5rem",
                borderTop: "1px solid var(--border)",
              }}
            >
              <div
                className="row"
                style={{ alignItems: "center", marginBottom: "0.3rem" }}
              >
                <strong
                  style={{
                    fontSize: "0.78rem",
                    letterSpacing: "0.02em",
                  }}
                >
                  Trouble drills
                </strong>
                <span
                  className="muted"
                  style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}
                >
                  bottom-3 avg, ≥ 2 attempts
                </span>
              </div>
              <div style={{ display: "grid", gap: "0.25rem" }}>
                {troubleDrills.map((d) => {
                  const avgPct = Math.round((d.avg_score ?? 0) * 100);
                  const lastPct =
                    d.last_score === null
                      ? null
                      : Math.round(d.last_score * 100);
                  return (
                    <div
                      key={d.drill_id}
                      className="row"
                      style={{
                        alignItems: "baseline",
                        gap: "0.4rem",
                        fontSize: "0.76rem",
                      }}
                      title={d.question_text.trim()}
                    >
                      <span
                        className="tag"
                        style={{ background: "var(--bad)", color: "#0c1220" }}
                      >
                        avg {avgPct}
                      </span>
                      {lastPct !== null && (
                        <span
                          className="tag"
                          style={{
                            background:
                              lastPct > avgPct ? "var(--good)" : "transparent",
                            color: lastPct > avgPct ? "#0c1220" : "inherit",
                          }}
                        >
                          last {lastPct}
                        </span>
                      )}
                      <span className="muted">
                        {d.topic} · {d.subtopic}
                      </span>
                      <span
                        className="muted"
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginLeft: "0.2rem",
                        }}
                      >
                        {d.question_text.trim().slice(0, 80)}
                      </span>
                      <span
                        className="muted"
                        style={{ fontSize: "0.7rem" }}
                      >
                        {d.attempts} attempts
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <section className="panel">
        <h2>Drill</h2>

        {resuming && !drill && (
          <p className="muted" data-testid="resume-status">
            Resuming previous session...
          </p>
        )}

        {!drill && !resuming && (
          <>
            <p className="muted">
              Pick a drill pool and start. Rapid fundamentals expects 20-40
              second definition, consequence, caveat, example answers.
            </p>
            <div className="row">
              <select
                data-testid="mode-select"
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div
                className="segmented-control"
                role="group"
                aria-label="Interaction mode"
              >
                <button
                  data-testid="interaction-text"
                  onClick={() => setInteractionMode("text")}
                  className={interactionMode === "text" ? "selected" : undefined}
                  title="Cheap text-first drill mode."
                >
                  Text drill
                </button>
                <button
                  data-testid="interaction-voice"
                  onClick={() => setInteractionMode("voice")}
                  className={interactionMode === "voice" ? "selected" : undefined}
                  disabled={!voiceProviderReady}
                  title="Live voice polishing starts one drill at a time."
                >
                  Live voice polish
                </button>
              </div>
              <div
                className="segmented-control"
                role="group"
                aria-label="Voice provider"
              >
                <button
                  data-testid="voice-provider-openai"
                  onClick={() => setVoiceProvider("openai")}
                  className={voiceProvider === "openai" ? "selected" : undefined}
                  disabled={voiceSessionActive}
                  title="Use OpenAI Realtime for voice sessions."
                >
                  OpenAI Realtime
                </button>
                <button
                  data-testid="voice-provider-elevenlabs"
                  onClick={() => setVoiceProvider("elevenlabs")}
                  className={
                    voiceProvider === "elevenlabs" ? "selected" : undefined
                  }
                  disabled={voiceSessionActive}
                  title="Use ElevenLabs Agents for voice sessions."
                >
                  ElevenLabs Agents
                </button>
              </div>
              <button className="primary" onClick={onStart}>
                Start session
              </button>
            </div>
            <div style={{ marginTop: "0.7rem" }}>
              <RealtimeSettingsPanel
                settings={realtimeSettings}
                setSettings={setRealtimeSettings}
                debugEvents={realtime.debugEvents}
                micLevel={realtime.micLevel}
                active={false}
                provider={voiceProvider}
              />
            </div>
          </>
        )}

        {drill && (
          <>
            <div className="row" style={{ marginBottom: "0.6rem" }}>
              <span className="tag">{drill.topic}</span>
              <span className="tag">{drill.subtopic}</span>
              <span className="tag">difficulty {drill.difficulty}</span>
              {session?.mode === "mock_interview" && (
                <span
                  className="tag"
                  data-testid="mock-progress"
                  style={{
                    background:
                      drillCount > MOCK_TARGET
                        ? "var(--warn)"
                        : "transparent",
                    color:
                      drillCount > MOCK_TARGET ? "#0c1220" : "inherit",
                  }}
                >
                  Drill {drillCount} of {MOCK_TARGET}
                  {drillCount >= MOCK_TARGET ? " — end soon" : ""}
                </span>
              )}
              <span className="timer">⏱ {formatTime(elapsed)}</span>
              {realtime.status === "connected" && (
                <>
                  <span
                    data-testid="voice-state"
                    className="tag"
                    style={{
                      background: realtime.isAgentSpeaking
                        ? "var(--accent)"
                        : "transparent",
                      color: realtime.isAgentSpeaking
                        ? "#0c1220"
                        : "inherit",
                      fontSize: "0.72rem",
                    }}
                    title={
                      realtime.isAgentSpeaking
                        ? "Agent is speaking — listen"
                        : "Waiting for your spoken answer"
                    }
                  >
                    {realtime.isAgentSpeaking
                      ? "🔊 Coach speaking"
                      : "🎤 Listening"}
                  </span>
                  <MicMeter level={realtime.micLevel} />
                </>
              )}
            </div>
            <div data-testid="question" className="question">
              {drill.question_text.trim()}
            </div>
            {drill.prior_attempts && drill.prior_attempts.length > 0 && (
              <div
                className="row muted"
                data-testid="prior-attempts"
                style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}
              >
                <span>Prior attempts:</span>
                {drill.prior_attempts
                  .slice()
                  .reverse()
                  .map((p, i) => (
                    <span key={i} className="tag" title={p.verdict ?? ""}>
                      {Math.round(p.score * 100)}
                    </span>
                  ))}
              </div>
            )}

            <div
              className="row"
              style={{ marginTop: "0.9rem", marginBottom: "0.5rem" }}
            >
              <button
                data-testid="retry-voice"
                onClick={() => {
                  if (realtime.status === "connected") {
                    setInteractionMode("text");
                    void realtime.stop();
                    return;
                  }
                  setInteractionMode("voice");
                  void startVoiceForDrill(drill);
                }}
                disabled={!voiceProviderReady || voiceConnecting}
                title={`Start or stop live voice for this drill with ${
                  voiceProvider === "elevenlabs"
                    ? "ElevenLabs Agents"
                    : "OpenAI Realtime"
                }.`}
              >
                {voiceConnected
                  ? "Stop voice"
                  : voiceConnecting
                    ? "Connecting voice..."
                    : voiceCanStart
                      ? "Start voice polish"
                      : "Voice unavailable"}
              </button>
              <button
                data-testid="submit-answer"
                onClick={onSubmit}
                disabled={grading}
                className="primary"
              >
                {grading ? "Grading..." : "Grade typed answer"}
              </button>
              <button
                data-testid="next-drill"
                onClick={onNext}
                disabled={grading}
              >
                Next drill
              </button>
              {grade && grade.verdict !== "pass" && drill && (
                <button
                  data-testid="retry-drill"
                  onClick={onRetry}
                  disabled={grading}
                  title="Try this same drill again now (Shift+R)"
                >
                  Try again
                </button>
              )}
              {voiceAutoAdvance && voiceConnected && grade && (
                <button
                  data-testid="next-drill-now"
                  onClick={() => {
                    clearAutoAdvance();
                    void onNext();
                  }}
                  disabled={grading || realtime.isAgentSpeaking}
                >
                  {autoAdvanceRemaining === null
                    ? "Next now"
                    : `Next in ${autoAdvanceRemaining}s`}
                </button>
              )}
              <button
                data-testid="end-session"
                onClick={onEndSession}
                disabled={ending || grading}
                style={{ marginLeft: "auto" }}
              >
                {ending ? "Ending..." : "Stop session"}
              </button>
            </div>

            <div
              className="muted"
              data-testid="shortcuts-hint"
              style={{
                fontSize: "0.7rem",
                marginTop: "0.3rem",
                marginBottom: "0.2rem",
                letterSpacing: "0.02em",
              }}
              aria-label="keyboard shortcuts"
            >
              <kbd style={kbdStyle}>⌘/Ctrl</kbd>+<kbd style={kbdStyle}>↵</kbd>{" "}
              submit &nbsp;·&nbsp; <kbd style={kbdStyle}>n</kbd> next
              &nbsp;·&nbsp; <kbd style={kbdStyle}>⇧R</kbd> retry
              &nbsp;·&nbsp; <kbd style={kbdStyle}>e</kbd> end
              &nbsp;·&nbsp; <kbd style={kbdStyle}>p</kbd> pressure
            </div>

            {voiceSessionActive && (
              <VoiceConversation messages={realtime.messages} />
            )}

            <RealtimeSettingsPanel
              settings={realtimeSettings}
              setSettings={setRealtimeSettings}
              debugEvents={realtime.debugEvents}
              micLevel={realtime.micLevel}
              active={voiceSessionActive}
              provider={voiceProvider}
            />

            <textarea
              data-testid="transcript"
              className="transcript"
              placeholder="Type your answer here, then grade it."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={8}
              style={{
                width: "100%",
                resize: "vertical",
                color: "inherit",
                background: "#0a0c12",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "0.6rem 0.7rem",
                fontFamily: "inherit",
                fontSize: "0.95rem",
              }}
            />
            <audio ref={realtime.audioEl} autoPlay playsInline />
            {realtime.error && (
              <div
                data-testid="voice-error-banner"
                role="alert"
                style={{
                  marginTop: "0.6rem",
                  padding: "0.6rem 0.8rem",
                  borderRadius: 8,
                  border: "1px solid var(--bad)",
                  background: "rgba(248, 113, 113, 0.08)",
                  color: "var(--bad)",
                  fontSize: "0.85rem",
                  lineHeight: 1.45,
                }}
              >
                <strong style={{ fontWeight: 600 }}>Voice failed</strong>{" "}
                — {realtime.error}
                <div
                  className="muted"
                  style={{ marginTop: "0.25rem", fontSize: "0.78rem" }}
                >
                  Check microphone permission, that{" "}
                  <code>
                    {voiceProvider === "elevenlabs"
                      ? "ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID"
                      : "OPENAI_API_KEY"}
                  </code>{" "}
                  is set on the backend, and that the page is over HTTPS or{" "}
                  <code>localhost</code>. Click{" "}
                  <em>Retry voice</em> to try again.
                </div>
                {realtime.debugEvents.length > 0 && (
                  <details
                    data-testid="voice-error-debug-trail"
                    style={{ marginTop: "0.45rem", color: "var(--muted)" }}
                  >
                    <summary style={{ cursor: "pointer" }}>Debug trail</summary>
                    <ol style={{ margin: "0.35rem 0 0", paddingLeft: "1.2rem" }}>
                      {realtime.debugEvents.map((event) => (
                        <li key={`${event.at}-${event.type}`}>
                          {formatDebugEvent(event)}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      <aside className="panel">
        <h2>Grading</h2>
        {!grade && (
          <p className="muted">
            Submit your answer and the backend will grade it rubric-first:
            score, missed points, ideal short answer, and follow-up cards.
          </p>
        )}
        {grade && (
          <>
            <div className="scoreline" data-testid="grade-panel">
              <span className="score" data-testid="grade-score">
                {isRapidFundamentalsMode
                  ? formatRapidScore(grade.score)
                  : Math.round(grade.score * 100)}
              </span>
              <span className={verdictClass} data-testid="grade-verdict">
                {grade.verdict}
              </span>
            </div>
            <p className="muted" style={{ marginTop: "0.2rem" }}>
              {isRapidFundamentalsMode ? "definition" : "must-have"}{" "}
              {(grade.breakdown.must_have_coverage * 100).toFixed(0)}% · clarity{" "}
              {(grade.breakdown.answer_clarity * 100).toFixed(0)}% ·{" "}
              {isRapidFundamentalsMode ? "caveat" : "tradeoffs"}{" "}
              {(grade.breakdown.tradeoff_coverage * 100).toFixed(0)}% · speed{" "}
              {(grade.breakdown.speed_score * 100).toFixed(0)}%
              {grade.breakdown.red_flag_penalty > 0 &&
                ` · −${(grade.breakdown.red_flag_penalty * 100).toFixed(0)} flags`}
            </p>
            {voiceAutoAdvance && voiceConnected && (
              <p
                className="muted"
                data-testid="autoplay-next"
                style={{ marginTop: "0.25rem", fontSize: "0.82rem" }}
              >
                {autoAdvanceRemaining === null
                  ? "Next drill will autoplay after the coach finishes."
                  : `Next drill autoplaying in ${autoAdvanceRemaining}s.`}
              </p>
            )}

            <p className="muted" data-testid="grade-help" style={{ marginTop: "0.35rem" }}>
              Scored against explicit rubric coverage; implied points get partial
              credit, and missed bullets are what to say more directly.
            </p>

            {grade.covered_points && grade.covered_points.length > 0 && (
              <>
                <h3 style={{ margin: "0.8rem 0 0.2rem", fontSize: "0.95rem" }}>
                  Covered
                </h3>
                <ul className="missed">
                  {grade.covered_points.map((m, i) => (
                    <li key={i}>
                      <TermText
                        text={m}
                        allowedConceptIds={currentConceptIds}
                        onSelectConcept={selectConcept}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}

            {grade.missed_points.length > 0 && (
              <>
                <h3 style={{ margin: "0.8rem 0 0.2rem", fontSize: "0.95rem" }}>
                  Missed
                </h3>
                <ul className="missed">
                  {grade.missed_points.map((m, i) => (
                    <li key={i}>
                      <TermText
                        text={m}
                        allowedConceptIds={currentConceptIds}
                        onSelectConcept={selectConcept}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3 style={{ margin: "0.8rem 0 0.2rem", fontSize: "0.95rem" }}>
              Ideal short answer
            </h3>
            <p style={{ margin: 0 }}>
              <TermText
                text={grade.ideal_short_answer}
                allowedConceptIds={currentConceptIds}
                onSelectConcept={selectConcept}
              />
            </p>

            {grade.cards.length > 0 && (
              <>
                <h3 style={{ margin: "0.8rem 0 0.4rem", fontSize: "0.95rem" }}>
                  Generated cards
                </h3>
                {grade.cards.map((c, i) => (
                  <div className="card" key={i}>
                    <div className="front">
                      <TermText
                        text={c.front}
                        allowedConceptIds={currentConceptIds}
                        onSelectConcept={selectConcept}
                      />
                    </div>
                    <div className="back">
                      <TermText
                        text={c.back}
                        allowedConceptIds={currentConceptIds}
                        onSelectConcept={selectConcept}
                      />
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </aside>

      <ConceptPanel
        conceptIds={currentConceptIds}
        activeConcept={activeConcept}
        emptyMessage={
          grade
            ? "No matched talk-through terms for this drill yet."
            : "Grade an answer to focus the current concepts."
        }
        onSelectConcept={selectConcept}
      />

      {summary && (
        <section
          className="panel"
          data-testid="session-summary"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>Session summary</h2>
            <span className="tag">mode {summary.mode}</span>
            <span className="tag">
              {summary.drills_graded}/{summary.drills_attempted} graded
            </span>
            <span className="tag">avg {Math.round(summary.average_score * 100)}</span>
            <span className="tag">
              {summary.passes} pass · {summary.borderlines} border · {summary.fails} fail
            </span>
            {summary.usage && (
              <span className="tag">
                tokens {formatTokens(summary.usage.total_tokens)}
              </span>
            )}
            <button
              data-testid="reset-session"
              onClick={onResetSession}
              style={{ marginLeft: "auto" }}
            >
              Start a new session
            </button>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Topics covered: {summary.topics_covered.join(", ") || "—"}
          </p>
          {summary.attempts.length > 0 && (
            <div
              style={{
                display: "grid",
                gap: "0.3rem",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              }}
            >
              {summary.attempts.map((a) => {
                const isExpanded = expandedAttemptId === a.attempt_id;
                return (
                  <div
                    className="card"
                    key={a.attempt_id}
                    data-testid="summary-attempt"
                    style={{ cursor: "pointer" }}
                    onClick={() =>
                      isExpanded
                        ? setExpandedAttemptId(null)
                        : void onExpandAttempt(a.attempt_id)
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (isExpanded) setExpandedAttemptId(null);
                        else void onExpandAttempt(a.attempt_id);
                      }
                    }}
                  >
                    <div className="row" style={{ alignItems: "center" }}>
                      {a.topic && <span className="tag">{a.topic}</span>}
                      {a.subtopic && <span className="tag">{a.subtopic}</span>}
                      {a.score !== null && (
                        <span
                          className={`tag verdict-${a.verdict ?? ""}`}
                          style={{ marginLeft: "auto" }}
                        >
                          {Math.round(a.score * 100)} · {a.verdict}
                        </span>
                      )}
                    </div>
                    <div
                      className="muted"
                      style={{ fontSize: "0.78rem", marginTop: "0.2rem" }}
                    >
                      {a.duration_seconds ?? 0}s · {a.drill_id}{" "}
                      <span aria-hidden="true">
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </div>
                    {isExpanded && attemptDetail && (
                      <div
                        data-testid="attempt-detail"
                        style={{
                          marginTop: "0.5rem",
                          paddingTop: "0.4rem",
                          borderTop: "1px solid var(--border)",
                          fontSize: "0.78rem",
                          display: "grid",
                          gap: "0.35rem",
                        }}
                      >
                        {attemptDetail.drill && (
                          <div className="muted">
                            <em>
                              {attemptDetail.drill.question_text.trim()}
                            </em>
                          </div>
                        )}
                        {attemptDetail.attempt.transcript && (
                          <div>
                            <span className="muted">your answer: </span>
                            {attemptDetail.attempt.transcript}
                          </div>
                        )}
                        {(attemptDetail.attempt.missed_points ?? []).length >
                          0 && (
                          <div>
                            <span className="muted">missed: </span>
                            {(attemptDetail.attempt.missed_points ?? []).join(
                              " · ",
                            )}
                          </div>
                        )}
                        {attemptDetail.attempt.ideal_answer && (
                          <div>
                            <span className="muted">ideal: </span>
                            {attemptDetail.attempt.ideal_answer}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {draftsOpen && drafts && (
        <section
          className="panel"
          data-testid="drafts"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>
              Layer-3 drafts{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({drafts.length})
              </span>
            </h2>
            <span className="muted" style={{ marginLeft: "auto", fontSize: "0.8rem" }}>
              LLM-generated drills, inactive until you activate.
            </span>
          </div>
          {drafts.length === 0 ? (
            <p className="muted">
              No drafts. Run{" "}
              <code>pnpm --filter @drill/backend gen:drills -- --topic X --count N</code>{" "}
              to produce some.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "0.5rem",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              }}
            >
              {drafts.map((d) => (
                <div className="card" key={d.id} data-testid="draft-card">
                  <div
                    className="row"
                    style={{ alignItems: "center", marginBottom: "0.25rem" }}
                  >
                    <span className="tag">{d.topic}</span>
                    <span className="tag">{d.subtopic}</span>
                    <span className="tag">d{d.difficulty}</span>
                  </div>
                  <div style={{ fontSize: "0.85rem", marginBottom: "0.4rem" }}>
                    {d.question_text.trim()}
                  </div>
                  <div
                    className="muted"
                    style={{ fontSize: "0.75rem", marginBottom: "0.4rem" }}
                  >
                    <strong>must:</strong>{" "}
                    {d.rubric.must_have.join(" · ")}
                    {d.rubric.red_flags.length > 0 && (
                      <>
                        <br />
                        <strong>red flags:</strong>{" "}
                        {d.rubric.red_flags.join(" · ")}
                      </>
                    )}
                  </div>
                  <div className="row" style={{ gap: "0.4rem" }}>
                    <button
                      data-testid="activate-draft"
                      className="primary"
                      onClick={() => onActivateDraft(d.id)}
                    >
                      Activate
                    </button>
                    <button
                      data-testid="discard-draft"
                      onClick={() => onDiscardDraft(d.id)}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {drillBrowseOpen && drillBrowse && (
        <section
          className="panel"
          data-testid="drill-browse"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.5rem" }}>
            <h2 style={{ margin: 0 }}>
              Drill bank{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({drillBrowse.length} loaded)
              </span>
            </h2>
            <label
              data-testid="import-drills"
              title="Upload a YAML file in the seed format to upsert drills"
              style={{
                marginLeft: "auto",
                cursor: "pointer",
                border: "1px solid var(--border)",
                padding: "0.3rem 0.55rem",
                borderRadius: 6,
                fontSize: "0.8rem",
              }}
            >
              Import YAML…
              <input
                type="file"
                accept=".yaml,.yml,application/x-yaml,text/yaml"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onImportDrillFile(file);
                  e.target.value = "";
                }}
              />
            </label>
            <select
              value={drillBrowseFilter}
              onChange={(e) => setDrillBrowseFilter(e.target.value)}
            >
              <option value="">All topics</option>
              {[...new Set(drillBrowse.map((d) => d.topic))]
                .sort()
                .map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
            </select>
          </div>

          {drillStats && (
            <div
              data-testid="drill-stats-strip"
              className="row"
              style={{
                gap: "0.6rem",
                marginBottom: "0.6rem",
                padding: "0.45rem 0.6rem",
                background: "#0a0c12",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: "0.78rem",
                alignItems: "center",
              }}
            >
              <span>
                <strong>{drillStats.active}</strong>{" "}
                <span className="muted">active</span>
                {drillStats.drafts > 0 && (
                  <>
                    {" · "}
                    <strong>{drillStats.drafts}</strong>{" "}
                    <span className="muted">drafts</span>
                  </>
                )}
              </span>
              <span className="muted" aria-hidden="true">
                ·
              </span>
              <span className="muted">top topics:</span>
              {drillStats.by_topic
                .slice()
                .sort((a, b) => b.active - a.active)
                .slice(0, 4)
                .map((t) => (
                  <span key={t.topic} className="tag">
                    {t.topic} {t.active}
                  </span>
                ))}
              <span
                className="muted"
                style={{ marginLeft: "auto" }}
                aria-label="difficulty distribution"
                title={drillStats.by_difficulty
                  .map((d) => `d${d.difficulty}: ${d.active}`)
                  .join(" · ")}
              >
                {drillStats.by_difficulty.map((d) => {
                  const max = Math.max(
                    1,
                    ...drillStats.by_difficulty.map((x) => x.active),
                  );
                  const h = Math.max(2, Math.round((d.active / max) * 18));
                  return (
                    <span
                      key={d.difficulty}
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: h,
                        marginRight: 2,
                        marginLeft: 2,
                        verticalAlign: "bottom",
                        background:
                          d.difficulty >= 4
                            ? "var(--bad)"
                            : d.difficulty >= 3
                              ? "var(--warn)"
                              : "var(--good)",
                        borderRadius: 1,
                      }}
                      title={`d${d.difficulty}: ${d.active}`}
                    />
                  );
                })}
                <span style={{ fontSize: "0.7rem", marginLeft: 4 }}>
                  d1–d5
                </span>
              </span>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gap: "0.4rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
            }}
          >
            {drillBrowse
              .filter(
                (d) =>
                  !drillBrowseFilter || d.topic === drillBrowseFilter,
              )
              .map((d) => (
                <div className="card" key={d.id}>
                  <div
                    className="row"
                    style={{ alignItems: "center", marginBottom: "0.25rem" }}
                  >
                    <span className="tag">{d.topic}</span>
                    <span className="tag">{d.subtopic}</span>
                    <span className="tag">d{d.difficulty}</span>
                    {d.trap_type && (
                      <span className="tag">{d.trap_type}</span>
                    )}
                    <button
                      style={{
                        marginLeft: "auto",
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                      }}
                      onClick={() =>
                        setExpandedDrill((prev) =>
                          prev === d.id ? null : d.id,
                        )
                      }
                    >
                      {expandedDrill === d.id ? "Hide" : "Show"} rubric
                    </button>
                  </div>
                  <div style={{ fontSize: "0.85rem" }}>{d.question_text.trim()}</div>
                  {expandedDrill === d.id && (
                    <div
                      style={{
                        marginTop: "0.5rem",
                        fontSize: "0.78rem",
                        color: "var(--muted)",
                      }}
                    >
                      {editingDrill === d.id ? (
                        <div
                          data-testid="rubric-editor"
                          style={{
                            display: "grid",
                            gap: "0.4rem",
                            color: "var(--text)",
                          }}
                        >
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Must-have (one per line)
                            </span>
                            <textarea
                              rows={4}
                              value={editForm.must_have}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  must_have: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Nice-to-have
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.nice_to_have}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  nice_to_have: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Red flags
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.red_flags}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  red_flags: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "grid", gap: "0.2rem" }}>
                            <span style={{ fontSize: "0.75rem" }}>
                              Ideal short answer
                            </span>
                            <textarea
                              rows={3}
                              value={editForm.canonical_short_answer}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  canonical_short_answer: e.target.value,
                                }))
                              }
                              style={editorTextareaStyle}
                            />
                          </label>
                          <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                            <span style={{ fontSize: "0.75rem" }}>Difficulty</span>
                            <select
                              value={editForm.difficulty}
                              onChange={(e) =>
                                setEditForm((p) => ({
                                  ...p,
                                  difficulty: Number(e.target.value),
                                }))
                              }
                            >
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <button
                              data-testid="save-rubric"
                              className="primary"
                              disabled={savingEdit}
                              onClick={() => onSaveEdit(d.id)}
                              style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                            >
                              {savingEdit ? "Saving…" : "Save rubric"}
                            </button>
                            <button
                              onClick={onCancelEdit}
                              style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <strong>must:</strong>{" "}
                          {d.rubric.must_have.join(" · ")}
                          <br />
                          <strong>nice:</strong>{" "}
                          {d.rubric.nice_to_have.join(" · ") || "—"}
                          <br />
                          <strong>red flags:</strong>{" "}
                          {d.rubric.red_flags.join(" · ") || "—"}
                          <br />
                          <strong>ideal:</strong> {d.canonical_short_answer}
                          <div style={{ marginTop: "0.3rem" }}>
                            <button
                              data-testid="edit-rubric"
                              onClick={() => onStartEdit(d)}
                              style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                            >
                              Edit rubric
                            </button>
                          </div>
                        </>
                      )}
                      <div
                        style={{
                          marginTop: "0.5rem",
                          borderTop: "1px solid var(--border)",
                          paddingTop: "0.4rem",
                          color: "var(--text)",
                        }}
                      >
                        <strong style={{ fontSize: "0.8rem" }}>
                          Test grade (no persist)
                        </strong>
                        <textarea
                          data-testid="test-grade-input"
                          placeholder="Paste a sample answer to dry-run the grader against this rubric."
                          value={testTranscript[d.id] ?? ""}
                          onChange={(e) =>
                            setTestTranscript((prev) => ({
                              ...prev,
                              [d.id]: e.target.value,
                            }))
                          }
                          rows={3}
                          style={{
                            width: "100%",
                            marginTop: "0.3rem",
                            fontFamily: "inherit",
                            fontSize: "0.8rem",
                            color: "inherit",
                            background: "#0a0c12",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "0.4rem 0.5rem",
                          }}
                        />
                        <div
                          className="row"
                          style={{ marginTop: "0.3rem", gap: "0.4rem" }}
                        >
                          <button
                            data-testid="test-grade-run"
                            onClick={() => onTestGrade(d.id)}
                            style={{ fontSize: "0.78rem", padding: "0.25rem 0.5rem" }}
                          >
                            Run grader
                          </button>
                          {testResult[d.id] && (
                            <span
                              className={`tag verdict-${testResult[d.id]!.verdict}`}
                            >
                              {Math.round(testResult[d.id]!.score * 100)} ·{" "}
                              {testResult[d.id]!.verdict} · {testResult[d.id]!.missed}{" "}
                              missed
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </section>
      )}

      {historyOpen && (
        <section
          className="panel"
          data-testid="history-panel"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>
              Past sessions{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({recentSessions?.length ?? "…"})
              </span>
            </h2>
            <span
              className="muted"
              style={{ marginLeft: "auto", fontSize: "0.78rem" }}
            >
              Click a row to view its summary.
            </span>
          </div>
          {!recentSessions ? (
            <p className="muted" style={{ margin: 0 }}>
              Loading…
            </p>
          ) : recentSessions.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              No past sessions yet. Start one above.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "0.3rem",
                fontSize: "0.82rem",
              }}
            >
              {recentSessions.map((s, i) => {
                const started = new Date(s.started_at);
                const finished = s.ended_at
                  ? new Date(s.ended_at)
                  : null;
                const durationMin =
                  finished
                    ? Math.max(
                        0,
                        Math.round(
                          (finished.getTime() - started.getTime()) / 60000,
                        ),
                      )
                    : null;
                const avgPct = Math.round(s.average_score * 100);
                const isOpen = !finished;
                return (
                  <div
                    key={s.id}
                    data-testid="history-row"
                    style={{
                      padding: "0.4rem 0.55rem",
                      background: i % 2 === 0 ? "#0a0c12" : "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      display: "grid",
                      gridTemplateColumns:
                        "auto auto 1fr auto auto auto auto",
                      alignItems: "center",
                      gap: "0.6rem",
                      color: "inherit",
                    }}
                  >
                    <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                      {started.toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="tag">{s.mode}</span>
                    <span className="muted">
                      {s.drills_graded}/{s.drills_attempted} graded
                      {durationMin !== null && ` · ${durationMin}m`}
                    </span>
                    <span
                      className="tag"
                      style={{
                        background:
                          avgPct >= 80
                            ? "var(--good)"
                            : avgPct >= 60
                              ? "var(--warn)"
                              : "transparent",
                        color: avgPct >= 60 ? "#0c1220" : "inherit",
                      }}
                    >
                      avg {avgPct}
                    </span>
                    <span
                      className="muted"
                      style={{ fontSize: "0.72rem" }}
                    >
                      {isOpen ? "open" : "ended"}
                    </span>
                    {isOpen ? (
                      <button
                        data-testid="resume-history-row"
                        onClick={() => onResumeHistorySession(s.id, s.mode)}
                        className="primary"
                        style={{
                          padding: "0.18rem 0.45rem",
                          fontSize: "0.72rem",
                        }}
                      >
                        Resume
                      </button>
                    ) : (
                      <span style={{ width: 1 }} aria-hidden="true" />
                    )}
                    <button
                      data-testid="view-history-row"
                      onClick={() => onLoadHistorySession(s.id)}
                      style={{
                        padding: "0.18rem 0.45rem",
                        fontSize: "0.72rem",
                      }}
                    >
                      Summary
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {eventsOpen && session && (
        <section
          className="panel"
          data-testid="events-timeline"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="row" style={{ marginBottom: "0.4rem" }}>
            <h2 style={{ margin: 0 }}>
              Session audit log{" "}
              <span
                className="muted"
                style={{ fontWeight: 400, fontSize: "0.85rem" }}
              >
                ({sessionEvents.length})
              </span>
            </h2>
            <span
              className="muted"
              style={{ marginLeft: "auto", fontSize: "0.78rem" }}
              title="From the session_events table (LOCAL.md §7)"
            >
              session_events
            </span>
          </div>
          {sessionEvents.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No events yet — they accumulate as you start the session, pick
              drills, submit transcripts, and grade.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "0.3rem",
                fontSize: "0.78rem",
              }}
            >
              {sessionEvents.map((ev, i) => {
                const baseAt = sessionEvents[0]?.created_at
                  ? Date.parse(sessionEvents[0].created_at)
                  : Date.parse(ev.created_at);
                const t = Date.parse(ev.created_at) - baseAt;
                const seconds = Math.max(0, Math.floor(t / 1000));
                const m = Math.floor(seconds / 60)
                  .toString()
                  .padStart(2, "0");
                const s = (seconds % 60).toString().padStart(2, "0");
                return (
                  <div
                    key={ev.id}
                    className="row"
                    style={{
                      alignItems: "baseline",
                      gap: "0.5rem",
                      padding: "0.25rem 0.4rem",
                      borderRadius: 6,
                      background: i % 2 === 0 ? "#0a0c12" : "transparent",
                    }}
                    data-testid="event-row"
                  >
                    <span
                      className="muted"
                      style={{
                        flex: "0 0 56px",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      +{m}:{s}
                    </span>
                    <span
                      className="tag"
                      style={{ fontSize: "0.7rem", flex: "0 0 auto" }}
                    >
                      {ev.event_type}
                    </span>
                    {ev.payload && (
                      <span
                        className="muted"
                        style={{
                          flex: 1,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, monospace",
                          fontSize: "0.72rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={JSON.stringify(ev.payload, null, 2)}
                      >
                        {JSON.stringify(ev.payload)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section
        className="panel"
        data-testid="card-review"
        style={{ gridColumn: "1 / -1" }}
      >
        <h2>
          Card review{" "}
          <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
            ({cardStats.due} due / {cardStats.total} total)
          </span>
        </h2>
        {dueCards.length === 0 ? (
          <p className="muted">
            No cards due. Grade a drill and the missed points become flashcards
            scheduled with SM-2-lite (knew it stretches the interval, forgot
            resets it).
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gap: "0.6rem",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            }}
          >
            {dueCards.map((c) => (
              <div className="card" key={c.id} data-testid="card">
                <div className="front">{c.front}</div>
                {revealed[c.id] ? (
                  <div className="back" style={{ marginTop: "0.4rem" }}>
                    {c.back}
                  </div>
                ) : null}
                <div className="row" style={{ marginTop: "0.5rem", gap: "0.4rem" }}>
                  {!revealed[c.id] ? (
                    <button
                      data-testid="reveal-card"
                      onClick={() =>
                        setRevealed((prev) => ({ ...prev, [c.id]: true }))
                      }
                    >
                      Reveal
                    </button>
                  ) : (
                    <>
                      <button
                        data-testid="forgot-card"
                        onClick={() => onReviewCard(c.id, 0)}
                      >
                        Forgot
                      </button>
                      <button
                        data-testid="knew-card"
                        className="primary"
                        onClick={() => onReviewCard(c.id, 1)}
                      >
                        Knew it
                      </button>
                    </>
                  )}
                  {(c.topic || c.subtopic) && (
                    <span className="tag" style={{ marginLeft: "auto" }}>
                      {c.topic ?? ""}
                      {c.subtopic ? ` · ${c.subtopic}` : ""}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ConceptPanel({
  conceptIds,
  activeConcept,
  emptyMessage,
  onSelectConcept,
}: {
  conceptIds: string[];
  activeConcept: ConceptEntry | null;
  emptyMessage: string;
  onSelectConcept: (id: string) => void;
}) {
  const visibleConceptIds = conceptIds;
  const firstVisibleConceptId = visibleConceptIds[0];
  const concept =
    activeConcept ??
    (firstVisibleConceptId
      ? CONCEPT_BY_ID.get(firstVisibleConceptId) ?? null
      : null);

  return (
    <aside className="panel concept-panel" data-testid="concept-panel">
      <div className="row concept-panel-header">
        <h2>Talk-through</h2>
        <span className="tag">zoom</span>
      </div>
      <div className="concept-chip-row" data-testid="concept-chips">
        {visibleConceptIds.map((id) => {
          const item = CONCEPT_BY_ID.get(id);
          if (!item) return null;
          return (
            <button
              key={id}
              type="button"
              className={`tag concept-chip ${concept?.id === id ? "selected" : ""}`}
              onClick={() => onSelectConcept(id)}
              aria-pressed={concept?.id === id}
            >
              {item.title}
            </button>
          );
        })}
      </div>
      {concept ? (
        <div className="concept-detail" data-testid="concept-detail">
          <div className="concept-kicker">{concept.subtitle}</div>
          <h3>{concept.title}</h3>
          <div className="row concept-tags">
            {concept.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
          <p>{concept.summary}</p>

          <div className="concept-block">
            <strong>Talk track</strong>
            <ul>
              {concept.talkTrack.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div className="concept-block">
            <strong>Example</strong>
            <p>{concept.example}</p>
          </div>

          <div className="concept-block">
            <strong>References</strong>
            <div className="concept-references">
              {concept.references.map((reference) => (
                <a
                  key={reference.href}
                  href={reference.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {reference.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">{emptyMessage}</p>
      )}
    </aside>
  );
}

function TermText({
  text,
  allowedConceptIds,
  onSelectConcept,
}: {
  text: string;
  allowedConceptIds: string[];
  onSelectConcept: (id: string) => void;
}) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  TERM_ALIAS_REGEX.lastIndex = 0;

  for (;;) {
    const match = TERM_ALIAS_REGEX.exec(text);
    if (!match) break;
    const start = match.index;
    const matched = match[0];
    const concept = findConceptForText(matched, allowedConceptIds);
    if (!concept) continue;
    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <button
        key={`${start}-${matched}`}
        type="button"
        className="zoom-term"
        title={`Zoom: ${concept.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onSelectConcept(concept.id);
        }}
      >
        {matched}
      </button>,
    );
    lastIndex = start + matched.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return <>{nodes.length > 0 ? nodes : text}</>;
}

const editorTextareaStyle: CSSProperties = {
  width: "100%",
  fontFamily: "inherit",
  fontSize: "0.78rem",
  color: "inherit",
  background: "#0a0c12",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0.35rem 0.5rem",
  resize: "vertical",
};

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatRapidScore(score: number): string {
  const outOfFive = Math.max(0, Math.min(5, score * 5));
  return `${outOfFive.toFixed(1).replace(/\.0$/, "")}/5`;
}

function formatDebugEvent(event: RealtimeDebugEvent): string {
  const parts = [new Date(event.at).toLocaleTimeString(), event.type];
  if (event.state) parts.push(event.state);
  if (event.statusCode) parts.push(`status ${event.statusCode}`);
  if (event.requestId) parts.push(`request ${event.requestId}`);
  if (event.openaiRequestId) parts.push(`openai ${event.openaiRequestId}`);
  if (event.retryable) parts.push("retryable");
  if (event.message) parts.push(event.message);
  return parts.join(" · ");
}

function VoiceConversation({ messages }: { messages: RealtimeMessage[] }) {
  return (
    <div
      data-testid="voice-conversation"
      style={{
        display: "grid",
        gap: "0.45rem",
        maxHeight: 360,
        overflow: "auto",
        marginBottom: "0.6rem",
        padding: "0.55rem",
        background: "#0a0c12",
        border: "1px solid var(--border)",
        borderRadius: 8,
      }}
    >
      {messages.length === 0 ? (
        <div className="muted" style={{ fontSize: "0.85rem" }}>
          Waiting for voice events...
        </div>
      ) : (
        messages.map((message) => (
          <div
            key={message.id}
            data-testid={`voice-message-${message.role}`}
            style={{
              justifySelf: message.role === "user" ? "end" : "start",
              maxWidth: "86%",
              padding: "0.45rem 0.6rem",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background:
                message.role === "user"
                  ? "rgba(96, 165, 250, 0.12)"
                  : "rgba(148, 163, 184, 0.08)",
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
            }}
          >
            <div
              className="muted"
              style={{
                fontSize: "0.68rem",
                textTransform: "uppercase",
                marginBottom: "0.2rem",
              }}
            >
              {message.role === "user" ? "You" : "Coach"}
            </div>
            {message.text}
          </div>
        ))
      )}
    </div>
  );
}

function RealtimeSettingsPanel({
  settings,
  setSettings,
  debugEvents,
  micLevel,
  active,
  provider,
}: {
  settings: RealtimeSettings;
  setSettings: Dispatch<SetStateAction<RealtimeSettings>>;
  debugEvents: RealtimeDebugEvent[];
  micLevel: number;
  active: boolean;
  provider: VoiceProvider;
}) {
  const updateVad = (patch: Partial<RealtimeSettings["vad"]>) =>
    setSettings((prev) => ({ ...prev, vad: { ...prev.vad, ...patch } }));
  const isElevenLabs = provider === "elevenlabs";

  return (
    <details
      data-testid="voice-settings"
      open={active}
      style={{
        marginBottom: "0.6rem",
        padding: "0.55rem 0.65rem",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "#0d1118",
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        {isElevenLabs ? "ElevenLabs voice controls" : "OpenAI realtime controls"}
      </summary>
      <div
        style={{
          display: "grid",
          gap: "0.55rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          marginTop: "0.6rem",
          alignItems: "end",
        }}
      >
        <label style={settingsLabelStyle}>
          {isElevenLabs ? "Agent speed" : "Speech speed"}{" "}
          {settings.voice_speed.toFixed(2)}x
          <input
            data-testid="voice-speed"
            type="range"
            min="0.75"
            max={isElevenLabs ? "1.2" : "1.5"}
            step="0.05"
            value={settings.voice_speed}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                voice_speed: Number(e.target.value),
              }))
            }
          />
        </label>
        {!isElevenLabs && (
          <label style={settingsLabelStyle}>
            VAD mode
            <select
              data-testid="vad-mode"
              value={settings.vad.mode}
              onChange={(e) =>
                updateVad({
                  mode: e.target.value as RealtimeSettings["vad"]["mode"],
                })
              }
            >
              <option value="semantic_vad">Semantic</option>
              <option value="server_vad">Server threshold</option>
            </select>
          </label>
        )}
        {!isElevenLabs && settings.vad.mode === "semantic_vad" ? (
          <label style={settingsLabelStyle}>
            Eagerness
            <select
              data-testid="vad-eagerness"
              value={settings.vad.eagerness}
              onChange={(e) =>
                updateVad({
                  eagerness: e.target.value as RealtimeSettings["vad"]["eagerness"],
                })
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="auto">Auto</option>
            </select>
          </label>
        ) : !isElevenLabs ? (
          <>
            <label style={settingsLabelStyle}>
              Threshold {settings.vad.threshold.toFixed(2)}
              <input
                data-testid="vad-threshold"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.vad.threshold}
                onChange={(e) => updateVad({ threshold: Number(e.target.value) })}
              />
            </label>
            <label style={settingsLabelStyle}>
              End silence {settings.vad.silence_duration_ms}ms
              <input
                data-testid="vad-silence"
                type="range"
                min="300"
                max="2500"
                step="100"
                value={settings.vad.silence_duration_ms}
                onChange={(e) =>
                  updateVad({ silence_duration_ms: Number(e.target.value) })
                }
              />
            </label>
            <label style={settingsLabelStyle}>
              Prefix {settings.vad.prefix_padding_ms}ms
              <input
                data-testid="vad-prefix"
                type="range"
                min="0"
                max="1000"
                step="50"
                value={settings.vad.prefix_padding_ms}
                onChange={(e) =>
                  updateVad({ prefix_padding_ms: Number(e.target.value) })
                }
              />
            </label>
          </>
        ) : null}
        {!isElevenLabs && (
          <label
            style={{
              ...settingsLabelStyle,
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "0.45rem",
            }}
          >
            <input
              data-testid="vad-interrupt"
              type="checkbox"
              checked={settings.vad.interrupt_response}
              onChange={(e) => updateVad({ interrupt_response: e.target.checked })}
            />
            Allow barge-in
          </label>
        )}
        <div style={{ ...settingsLabelStyle, gap: "0.2rem" }}>
          Mic level {(micLevel * 100).toFixed(0)}%
          <MicMeter level={micLevel} />
        </div>
      </div>
      {debugEvents.length > 0 && (
        <details data-testid="voice-debug-trail" style={{ marginTop: "0.6rem" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Debug events
          </summary>
          <ol
            style={{
              margin: "0.35rem 0 0",
              paddingLeft: "1.2rem",
              color: "var(--muted)",
              fontSize: "0.76rem",
              lineHeight: 1.45,
            }}
          >
            {debugEvents.map((event) => (
              <li key={`${event.at}-${event.type}`}>{formatDebugEvent(event)}</li>
            ))}
          </ol>
        </details>
      )}
    </details>
  );
}

const settingsLabelStyle: CSSProperties = {
  display: "grid",
  gap: "0.3rem",
  color: "var(--muted)",
  fontSize: "0.78rem",
};

function readInteractionMode(): InteractionMode {
  try {
    const raw = window.localStorage.getItem(INTERACTION_MODE_STORAGE_KEY);
    return raw === "text" ? "text" : "voice";
  } catch {
    return "voice";
  }
}

function readVoiceProvider(): VoiceProvider {
  try {
    const raw = window.localStorage.getItem(VOICE_PROVIDER_STORAGE_KEY);
    return raw === "elevenlabs" ? "elevenlabs" : "openai";
  } catch {
    return "openai";
  }
}

function readRealtimeSettings(): RealtimeSettings {
  try {
    const raw = window.localStorage.getItem(REALTIME_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_REALTIME_SETTINGS;
    const parsed = JSON.parse(raw) as RealtimeSettings;
    return normalizeRealtimeSettings(parsed);
  } catch {
    return DEFAULT_REALTIME_SETTINGS;
  }
}

function normalizeRealtimeSettings(settings: RealtimeSettings): RealtimeSettings {
  return {
    voice_speed: clampNumber(settings.voice_speed, 0.75, 1.5, 1.25),
    vad: {
      mode:
        settings.vad?.mode === "server_vad" ? "server_vad" : "semantic_vad",
      threshold: clampNumber(settings.vad?.threshold, 0, 1, 0.5),
      prefix_padding_ms: clampNumber(settings.vad?.prefix_padding_ms, 0, 1000, 500),
      silence_duration_ms: clampNumber(
        settings.vad?.silence_duration_ms,
        300,
        2500,
        1200,
      ),
      eagerness: ["low", "medium", "high", "auto"].includes(
        settings.vad?.eagerness,
      )
        ? settings.vad.eagerness
        : "low",
      interrupt_response: settings.vad?.interrupt_response ?? true,
    },
  };
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function formatTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function MicMeter({ level }: { level: number }) {
  const bars = 5;
  const lit = Math.min(bars, Math.ceil(level * bars * 1.4));
  return (
    <span
      data-testid="mic-meter"
      title={`Mic input ${(level * 100).toFixed(0)}%`}
      style={{
        display: "inline-flex",
        gap: 2,
        alignItems: "flex-end",
        height: 14,
        marginLeft: "0.2rem",
      }}
      aria-label="microphone level"
    >
      {Array.from({ length: bars }).map((_, i) => {
        const isLit = i < lit;
        const h = 4 + i * 2;
        return (
          <span
            key={i}
            style={{
              width: 3,
              height: h,
              background: isLit ? "var(--good)" : "var(--border)",
              borderRadius: 1,
              transition: "background 80ms linear",
            }}
          />
        );
      })}
    </span>
  );
}
