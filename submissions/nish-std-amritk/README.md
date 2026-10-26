# Nish / standard library

Front: direct

Nish 0.22.1 (a statically typed TypeScript subset compiled to native code
through LLVM), built with clang-18 and lld-18 from LLVM 18, against
PostgreSQL 18. The compiler runs on Node.js 22.18.0 at build time only; the
server is one native binary with no runtime dependency beyond libc. Every
import is Nish's own standard library: `nish/net/http1-server` for HTTP/1.1,
`nish/net/postgres` for the PostgreSQL wire protocol, `nish/json`,
`nish/crypto/hmac` and `nish/crypto/bcrypt`. No third-party package is used.

```sh
sudo bash install.sh
bash build.sh
DATABASE_URL=postgres://conduit:conduit@127.0.0.1:5432/conduit JWT_SECRET=... HOST=0.0.0.0 PORT=80 bash start.sh
```

The server needs Nish 0.22.1, the first published release with the
standard-library changes it uses (`PreforkConfig.restart`,
`Http1Config.idleInput`, `TCP_NODELAY` on `tcpConnect`); `install.sh`
installs it from npm. To try an unreleased build instead, set `NISH_PACKAGES`
to the `npm pack` tarballs of the compiler and its platform package.

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
  packet (no server configuration is changed). A read is one pipelined group
  of Bind/Execute messages and one Sync, and up to 16 groups are pipelined on
  each connection.
- **Durable group commit.** While a batch is in flight on the write
  connection, the writes that arrive wait. Then up to 128 of them go as one
  group: one transaction, one commit, and one WAL flush. Each response is
  sent after that group's ReadyForQuery. No timer holds a write: an idle
  server sends one at once. A failed batch rolled back every write in it, so
  each write is sent again alone. A write whose connection is lost may have
  committed, so it answers 500 and is never sent again.
- **SQL.** The reference SQL from SPEC.md, with four changes that keep its
  answers:
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
  string is made per row.
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
(16), `BCRYPT_BATCH_MS` (160), `BCRYPT_PORT` (47391, loopback) and
`IDLE_TIMEOUT_MS` (75000). That makes 8 PostgreSQL connections in all, inside
the limit of 95.

## Measured

These figures are local, not official scores. They come from a 4-core
container shared by the server, PostgreSQL 18 and the challenge's load
generator. The runs used the full seed, `-think-scale 0.1`, and 4,000
simulated users, which make about the requests of 40,000. Across six runs:

| | req/s | p95 | p99 | errors | Postgres CPU / req | app CPU / req |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4,000 users | 10,275–10,422 | 21–37 ms | 40–70 ms | 0 | 233–246 µs | 34 µs HTTP + 26–31 µs bcrypt |

Server memory is 1.13 KiB of RSS per idle keep-alive connection, measured at
15,000 connections. All 197 conformance checks pass on the dev seed.

The source is staged from
[`bench/multicore/conduit`](https://github.com/amritk/nish/tree/main/bench/multicore/conduit)
in the Nish repository. Its README records the method and every change
measured, kept or dropped. The SPEC.md SQL keeps the challenge's MIT notice
(`src/LICENSE.md`).
