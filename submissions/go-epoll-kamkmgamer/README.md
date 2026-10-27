# Go / net/http + pgxpool — kamkmgamer

**Front: direct**

This is an independent Go implementation built around the standard library's net/http server,
not the custom epoll reactor used by PR #28. Requests run through a bounded pgxpool with normal
HTTP keep-alive handling, context cancellation, and explicit transaction boundaries.

- Go 1.27.1 with net/http
- pgx/v5 pool with separate connection limits and server-side PostgreSQL queries
- hand-written HS256 token verification and JSON response maps
- bcrypt cost 10 for every password hash and login verification
- no response, query, token, or password cache

The implementation is original to this folder. The Conduit contract and schema come from the
challenge; [PR #28](https://github.com/arjaythedev/multicore-server-challenge/pull/28) by
[@o7LiveType](https://github.com/o7LiveType) is credited as a related prior Go entry, but no
source files are copied from it.

## Build and run

~~~
sudo bash install.sh && bash build.sh
DATABASE_URL=postgres://conduit:conduit@127.0.0.1:5432/conduit
JWT_SECRET=multicore-server-challenge HOST=0.0.0.0 PORT=80 bash start.sh
~~~

The server reads every request from PostgreSQL, commits writes before responding, and keeps the
challenge's 95-connection budget through the pool configuration.
