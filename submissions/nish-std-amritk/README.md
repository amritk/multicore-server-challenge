# Nish / standard library

Front: direct

Nish 0.23.0 (a statically typed TypeScript subset compiled to native code
through LLVM), built with clang-18 and lld-18 from LLVM 18, against
PostgreSQL 18. The compiler runs on Node.js 22.18.0 at build time only; the
server is one native binary with no runtime dependency beyond libc. Every
import is Nish's own standard library: `nish/net/http1-server` for HTTP/1.1,
`nish/net/postgres` for the PostgreSQL wire protocol (with its array
parameters and its `PgBatcher`), `nish/json`, `nish/crypto/hmac` and
`nish/crypto/bcrypt`. No third-party package is used.

```sh
sudo bash install.sh
bash build.sh
DATABASE_URL=postgres://conduit:conduit@127.0.0.1:5432/conduit JWT_SECRET=... HOST=0.0.0.0 PORT=80 bash start.sh
```

The server needs Nish 0.23.0, the first published release with the
`nish/net/postgres` array parameters built in the Bind (`arrayStart`,
`arrayElement`, `arrayInt`, `paramIntArray`) and the `PgBatcher` it uses
(0.22.1 brought `PreforkConfig.restart`, `Http1Config.idleInput` and
`TCP_NODELAY` on `tcpConnect`); `install.sh` installs it from npm. To try an
unreleased build instead, set `NISH_PACKAGES` to the `npm pack` tarballs of
the compiler and its platform package.

## Design and optimizations

- **Processes.** A prefork parent starts two HTTP workers and one bcrypt
  service, and restarts none of them. Each HTTP worker binds `HOST:PORT` with
  `SO_REUSEPORT` and `TCP_NODELAY`, and runs one epoll loop over its
  listener, its keep-alive connections, its PostgreSQL connections and its
  connection to the bcrypt service. Nothing is shared between workers.
- **Direct HTTP/1.1** with a sans-IO parser. Request and head buffers are
  lent to a connection while it reads and taken back while it is idle, so an
  idle keep-alive connection costs about 1.1 KiB of server memory. A busy
  PostgreSQL socket is re-armed in epoll only when its interest changes.
- **PostgreSQL.** Per worker, three read connections and one write
  connection. Every statement is prepared once per connection, with
  `plan_cache_mode=force_generic_plan`, `jit=off` and
  `max_parallel_workers_per_gather=0` set as session options in the startup
  packet (no server configuration is changed). A group is pipelined
  Bind/Execute messages and one Sync, and up to 16 groups are pipelined on
  each connection.
- **Read plans.** Postgres is what the challenge's box runs out of, so the
  reads are planned to cost it as little as possible. Every list page (the
  global list, a tag, an author, a user's favorites), every feed, every
  article and its comments by slug, and the tag list wait together for the
  worker's next read plan, which answers all of them from a few statements
  over arrays of their distinct keys, in two pipelined groups
  (`src/plan.ts`):
  1. **Group A** finds what each request is about. Each kind of list present
     is one statement, which answers every distinct page (filter, key,
     limit, offset) once, as an array of article ids and one of their
     authors, and every distinct capped count once. Identical requests are
     one page: the global list has five pages a user clicks, and most of a
     plan's global requests read page one. The articles and the comments by
     slug go through nish's `PgBatcher`, each distinct slug one key of one
     execution over `unnest($1) WITH ORDINALITY`, its rows routed back by
     ordinal. Every tag is read once, by name.
  2. **Group B** reads the rest once for the whole plan: the columns of the
     union of every article group A returned (lists, feeds and article
     pages alike: an article on the first global page, a tag page and an
     article page is read once), and the viewers' `favorited` and
     `following` flags, each viewer's in one index range scan over its ids
     (`= ANY(...)`) rather than one probe per article. An article's tags
     come as ids and are named and ordered from group A's one read of every
     tag.

  Each request is then written from those rows: an article is encoded to
  JSON once a plan, cut where its body and its two flags go, and copied into
  every answer that holds it. A plan that fails sends its requests again
  alone, with the SQL below, where each answers its own error; an article
  group A found and group B did not (deleted in between), or whose slug
  changed in between, is read alone too.

  Nothing outlives its plan: every value in an answer was read from
  Postgres while that request waited, and a plan takes only the requests
  already waiting when it starts.
- **Batch clock.** A plan starts when 256 reads wait (a full plan) or when
  the oldest has waited 10 ms, and up to three are in flight per worker (one
  a read connection). Started at once instead, a plan is whatever arrived
  during the last one's two round trips, about 17 requests at the load
  measured below, and Postgres pays its fixed costs and reads the same
  articles again plan after plan. The window makes plans of about 60
  requests there: it cost about 12 ms of p95 and saved about a fifth of
  Postgres's CPU per request (measured below). The busier the server, the
  sooner a plan fills and the less the window holds a read.
- **Durable group commit.** While a batch is in flight on the write
  connection, the writes that arrive wait. Then up to 128 of them go as one
  group: one transaction, one commit, and one WAL flush. Each response is
  sent after that group's ReadyForQuery. No timer holds a write: an idle
  server sends one at once. A failed batch rolled back every write in it, so
  each write is sent again alone. A write whose connection is lost may have
  committed, so it answers 500 and is never sent again.
- **SQL.** A read plan's statements answer what SPEC.md's reference SQL
  answers, request by request (`src/sql.ts`): a page is the same ids in the
  same order, a count the same capped count (the global one walks the
  primary key from its oldest end, an index-only scan, for the same
  `min(articles, 1000)`), and an article the same columns. A read sent
  alone runs the reference SQL, with four changes that keep its answers:
  - A list page is cut in a subquery before its article metadata is computed.
  - A tag name is a primary-key lookup per tag, not a join that scans every
    tag for every article.
  - The tag list is one `ARRAY(...)` row.
  - An article's comments come in one `LEFT JOIN LATERAL` statement.

  A lookup followed by a write runs as one data-modifying `WITH`, or as two
  statements of one group.
- **Rows straight into JSON.** Result columns are read in place from the
  receive buffer. Articles are written from pre-encoded keys with block
  copies, text arrays are copied whole when they need no escaping, and no
  string is made per row. A read plan encodes each article and each comment
  once, and each answer is block copies of them with its viewer's flags.
- **Tokens.** HS256 over an HMAC keyed once with `JWT_SECRET`: each
  signature copies the two keyed states. The signature, algorithm and
  expiry are checked on every request. Nothing is cached between requests.
- **bcrypt.** Cost 10, with salts from the CSPRNG. One process batches up
  to four hashes or four checks into one four-lane bcrypt call, after a
  collection window of up to 160 ms. Passwords are wiped once sent and once
  hashed.

Every request reads PostgreSQL, and there are no result, token or password
caches. There are no schema or configuration changes, no CPU affinity and no
host tuning.

Optional process settings, with their defaults: `HTTP_WORKERS` (2),
`DB_READ_CONNS` (3) and `DB_WRITE_CONNS` (1) per worker, `DB_MAX_IN_FLIGHT`
(16), `DB_READ_PLANS` (`DB_READ_CONNS`) read plans in flight per worker,
`READ_PLAN_WAIT_US` (10000) and `READ_PLAN_MIN` (256) for the batch clock,
`READ_PLAN_CLOCK` (1; 0 starts a plan at once while none is in flight),
`BCRYPT_BATCH_MS` (160), `BCRYPT_PORT` (47391, loopback) and
`IDLE_TIMEOUT_MS` (75000). That makes 8 PostgreSQL connections in all, inside
the limit of 95.

## Measured

These figures are local, not official scores. They come from a 4-core
container (Intel Xeon at 2.10 GHz, 16 GB) shared by the server, PostgreSQL
18 (configured by `box/pg-conf.sh` for those 4 cores) and the challenge's load
generator, which competes with both for the CPU. Each run starts a build on
a fresh copy of the full seed, warms it up for 20 s with a quarter of the
users, ramps for 15 s and measures 40 s, at `-think-scale 0.1` (4,000 users
make about the requests of 40,000). CPU is the user and system time, from
`/proc`, of every PostgreSQL process and every server process over the
measured window, divided by the requests completed in it; statements are
from `pg_stat_statements`. Before is this submission as first opened,
rebuilt with Nish 0.23.0; it and the new build alternate, run after run.

| 4,000 users, 3 pairs | req/s | p95 | p99 | errors | Postgres CPU / req | app CPU / req | statements / req |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 10,338–10,356 | 22–23 ms | 36–42 ms | 0 | 221–225 µs | 61–62 µs | 1.04 |
| after | 10,128–10,211 | 28–29 ms | 36–40 ms | 0 | 130–134 µs | 65–68 µs | 0.29 |

At 6,000 users the box runs out of CPU, and the build before with it: its
p95 grows tenfold, while the read plans serve 17% more requests with a
quarter of its p95.

| 6,000 users, 2 pairs | req/s | p95 | p99 | errors | Postgres CPU / req | app CPU / req | statements / req |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 12,609–12,641 | 204–216 ms | 338–339 ms | 0 | 185–186 µs | 59–60 µs | 0.78 |
| after | 14,674–14,756 | 54–60 ms | 71–83 ms | 0 | 113–116 µs | 56–58 µs | 0.24 |

The most users each holds, stepping up 1,000 at a time (30 s ramp, 60 s
measured, the challenge's pass rule: p95 < 500 ms, p99 < 1 s, errors < 1%):

| Users | Before | After |
| ---: | --- | --- |
| 6,000 | pass, 12,265 req/s, p95 246 ms | pass, 14,640 req/s, p95 62 ms |
| 7,000 | **fail**, 12,116 req/s, p95 562 ms | pass, 16,348 req/s, p95 102 ms |
| 8,000 | | pass, 17,791 req/s, p95 136 ms |
| 9,000 | | pass, 18,704 req/s, p95 188 ms |
| 10,000 | | pass, 19,468 req/s, p95 236 ms |

The build before holds 6,000 and fails at 7,000; the read plans hold
10,000, the most tried, at about 100 µs of Postgres CPU a request. At 1,000
users, far from any limit, the batch clock shows: p95 is 14.5 ms against
1.7 ms before, and Postgres CPU per request 192 µs against 326 µs.

Each step, on the same load, by Postgres CPU per request (the spread of
two or three pairs against its own control):

| Step | Postgres CPU / req |
| --- | ---: |
| Before | 219–222 µs |
| Articles and comments by slug through `PgBatcher` (no change meant) | 220–222 µs |
| Lists and feeds in read plans | 186 µs |
| Articles, comments and the tag list in them too | 165–166 µs |
| The batch clock, 10 ms | 128–130 µs |

A 20 ms window measured 120 µs, at 37 ms p95. The app's CPU includes the
bcrypt service, 26–31 µs a request. The app's share grew by about 5 µs: a
plan hashes its keys and copies each answer together from the articles it
encoded once. Each read plan allocates about 1 MiB of buffers once (three
per worker); server memory per idle keep-alive connection is unchanged,
1.13 KiB as measured before at 15,000 connections. All 197 conformance
checks pass on the dev seed. A concurrency check makes 339 distinct reads
(articles and comments with and without a viewer, slugs that match nothing
or that Postgres refuses, the tag list, every kind of list and feed, with
known and unknown keys), one at a time and then 13,560 at once in a
shuffled order: every answer matches its serial one byte for byte, and
every serial answer matches the build before byte for byte, in about 4,600
statements where the build before took about 17,200.

## Credits

Ideas taken from other submissions to the challenge, each written here
from the idea, not the code:

- From [rust-epoll-WorriedArrow](https://github.com/arjaythedev/multicore-server-challenge/tree/main/submissions/rust-epoll-WorriedArrow)
  ([#47](https://github.com/arjaythedev/multicore-server-challenge/pull/47)):
  the batch planner in front of Postgres, in two phases. Pages and capped
  counts answered from one statement per kind of list over distinct keys;
  the union of a batch's articles enriched once; the viewers' flags as one
  `= ANY` range scan per viewer; a batch gathered for a window, the batch
  clock; and the global count walking the primary key from its oldest end.
- From [rust-tokio-Scooter1337](https://github.com/arjaythedev/multicore-server-challenge/tree/main/submissions/rust-tokio-Scooter1337)
  ([#7](https://github.com/arjaythedev/multicore-server-challenge/pull/7)):
  coalescing waiting reads into one statement over arrays, routed back by
  ordinal, and cutting a list page before computing its articles' metadata.

The source lives here; until Nish 0.23.0 it was staged from
[`bench/multicore/conduit`](https://github.com/amritk/nish/tree/c434ac7b/bench/multicore/conduit)
in the Nish repository, whose README there records the method and the
changes measured, kept or dropped, before the read plans. The SPEC.md SQL
keeps the challenge's MIT notice (`src/LICENSE.md`).
