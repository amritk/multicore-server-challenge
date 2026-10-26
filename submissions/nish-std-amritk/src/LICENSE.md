# Licence of the challenge queries

The files here that come from the
[multicore server challenge](https://github.com/arjaythedev/multicore-server-challenge)
are not covered by this repository's own licence, and each carries the
challenge's copyright notice:

- `sql.ts` runs the challenge's `SPEC.md` reference SQL at `c301225`: its
  statements, its shared fragments (`ARTICLE_LIST_SELECT`,
  `ARTICLE_FULL_SELECT`, `SLUGIFY`, `ORDER_PAGE`) and its capped counts,
  some joined into one statement or one group as `sql.ts` says.

The rest of this directory (the HTTP worker, the token code, the bcrypt
service) is this repository's own. No code is copied from the challenge's
submissions. One idea is taken from one, rust-tokio-Scooter1337's (under the
challenge's licence, below): a list page is cut before its article metadata
is computed. `sql.ts` cites it where `pageFrom` writes it.

The challenge's licence, verbatim:

```text
MIT License

Copyright (c) 2026 arjaythedev and the challenge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
