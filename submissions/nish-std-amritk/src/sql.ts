// The statements the server prepares on every connection, by name. They are
// the reference SQL of the multicore server challenge's SPEC.md "SQL",
// https://github.com/arjaythedev/multicore-server-challenge/blob/c301225/SPEC.md,
// with two changes that keep its answers: an endpoint whose reference runs a
// lookup and then a write runs them as one statement (a data-modifying
// `WITH`) or as statements of one pipelined group, and every article select
// returns its columns in the one order `ARTICLE_COLUMNS` names, so one writer
// serves them all. Each group is one implicit transaction, committed at its
// Sync, and a response is sent only after its group's ReadyForQuery.
//
// Copyright (c) 2026 arjaythedev and the challenge contributors. MIT License;
// see LICENSE.md beside this file.
import { PG_BATCH_TEXT, PgBatchConfig, PgPool } from "nish/net/postgres"

/** The article columns, in order: what `ARTICLE_LIST` and `ARTICLE_FULL` select. */
export const COL_SLUG: i32 = 0
export const COL_TITLE: i32 = 1
export const COL_DESCRIPTION: i32 = 2
export const COL_TAGS: i32 = 3
export const COL_CREATED: i32 = 4
export const COL_UPDATED: i32 = 5
export const COL_FAVORITED: i32 = 6
export const COL_FAVORITES: i32 = 7
export const COL_USERNAME: i32 = 8
export const COL_BIO: i32 = 9
export const COL_IMAGE: i32 = 10
export const COL_FOLLOWING: i32 = 11
/** `ARTICLE_FULL` only. */
export const COL_BODY: i32 = 12

/**
 * SPEC.md's ARTICLE_LIST_SELECT, without `a.id` and in `COL_` order, in three
 * parts around the two places the viewer's id goes. A tag's name is a
 * primary-key lookup per tag (an article has one to four): joined to `tags`
 * instead, the generic plan hash-joins a scan of all 200 tags for every
 * article of the page.
 */
const LIST_FAVORITED: string =
  "SELECT a.slug, a.title, a.description, " +
  "ARRAY(SELECT (SELECT t.name FROM tags t WHERE t.id = at.tag_id) FROM article_tags at WHERE at.article_id = a.id ORDER BY 1) AS tag_list, " +
  "a.created_at, a.updated_at, " +
  "EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = "
const LIST_FOLLOWING: string =
  ") AS favorited, " +
  "(SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count, " +
  "u.username, u.bio, u.image, " +
  "EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = "
const LIST_END: string = " AND fo.followee_id = a.author_id) AS following"
/** ARTICLE_LIST_SELECT with `$1` the viewer. */
const ARTICLE_LIST: string = LIST_FAVORITED + "$1" + LIST_FOLLOWING + "$1" + LIST_END
/** SPEC.md's ARTICLE_FULL_SELECT: the list's columns and `a.body` last. */
const ARTICLE_FULL: string = ARTICLE_LIST + ", a.body"
const ARTICLE_FROM: string = " FROM articles a JOIN users u ON u.id = a.author_id"
/**
 * A coalesced read's key, `q.key` in a `PgBatcher`'s select: the viewer in
 * decimal, a space, and the slug, one text key for the pair, as the batcher
 * takes one key a request.
 */
const KEY_FROM: string =
  " FROM (SELECT split_part(q.key, ' ', 1)::int8 AS viewer, substr(q.key, strpos(q.key, ' ') + 1) AS slug) k"
const SLUGIFY_2: string = "trim(both '-' from lower(regexp_replace($2::text, '[^A-Za-z0-9]+', '-', 'g')))"
// A scalar subquery, so the volatile currval is read once and the primary key
// is probed with it, rather than tested against every row.
const LAST_ARTICLE: string = "(SELECT currval(pg_get_serial_sequence('articles', 'id')))"
const FOLLOWING_1: string = "EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = $1 AND fo.followee_id = "

/**
 * The FROM of a list page: the articles `where` keeps, newest first, cut to
 * `$2` from `$3` before any column is computed. Computing the metadata after
 * the page is cut is an idea from the challenge's rust-tokio-Scooter1337
 * submission; the SQL is written here.
 */
const pageFrom = (where: string): string =>
  " FROM (SELECT a2.id, a2.slug, a2.title, a2.description, a2.created_at, a2.updated_at, a2.author_id FROM articles a2 WHERE " +
  where +
  " ORDER BY a2.id DESC LIMIT $2 OFFSET $3) a JOIN users u ON u.id = a.author_id ORDER BY a.id DESC"

/** Registers every statement on `pool`; false when the pool refused one. */
export const registerStatements = (pool: PgPool): boolean => {
  const none: i32[] = []
  let ok: boolean = true
  // Article lists: the page, then the capped count, of each filter.
  // The page is cut in a subquery before the select list runs: with LIMIT and
  // OFFSET over the whole select, every per-row subquery also ran for each
  // row the OFFSET skips.
  ok = pool.register("list_all", ARTICLE_LIST + pageFrom("TRUE"), none) && ok
  ok = pool.register("count_all", "SELECT count(*) FROM (SELECT 1 FROM articles a LIMIT 1000) s", none) && ok
  ok =
    pool.register(
      "list_tag",
      ARTICLE_LIST +
        ARTICLE_FROM +
        " WHERE a.id IN (SELECT at.article_id FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = $4) ORDER BY at.article_id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC",
      none
    ) && ok
  ok =
    pool.register(
      "count_tag",
      "SELECT count(*) FROM (SELECT 1 FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = $1) LIMIT 1000) s",
      none
    ) && ok
  ok =
    pool.register(
      "list_author",
      ARTICLE_LIST + pageFrom("a2.author_id = (SELECT au.id FROM users au WHERE au.username = $4)"),
      none
    ) && ok
  ok =
    pool.register(
      "count_author",
      "SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id = (SELECT u.id FROM users u WHERE u.username = $1) LIMIT 1000) s",
      none
    ) && ok
  ok =
    pool.register(
      "list_favorited",
      ARTICLE_LIST +
        ARTICLE_FROM +
        " WHERE a.id IN (SELECT f.article_id FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = $4) ORDER BY f.article_id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC",
      none
    ) && ok
  ok =
    pool.register(
      "count_favorited",
      "SELECT count(*) FROM (SELECT 1 FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = $1) LIMIT 1000) s",
      none
    ) && ok
  ok =
    pool.register(
      "list_feed",
      ARTICLE_LIST +
        ARTICLE_FROM +
        " WHERE a.id IN (SELECT x.id FROM follows fo CROSS JOIN LATERAL (SELECT a2.id FROM articles a2 WHERE a2.author_id = fo.followee_id ORDER BY a2.id DESC LIMIT ($2::int + $3::int)) x WHERE fo.follower_id = $1 ORDER BY x.id DESC LIMIT $2 OFFSET $3) ORDER BY a.id DESC",
      none
    ) && ok
  ok =
    pool.register(
      "count_feed",
      "SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id IN (SELECT fo.followee_id FROM follows fo WHERE fo.follower_id = $1) LIMIT 1000) s",
      none
    ) && ok
  // One article, by slug or by id.
  ok = pool.register("article_slug", ARTICLE_FULL + ARTICLE_FROM + " WHERE a.slug = $2", none) && ok
  ok = pool.register("article_id", ARTICLE_FULL + ARTICLE_FROM + " WHERE a.id = $2", none) && ok
  ok =
    pool.register("article_last", ARTICLE_FULL + ARTICLE_FROM + " WHERE a.id = " + LAST_ARTICLE, none) && ok
  // Every tag in one row, as one array: one DataRow to frame and send, not 200.
  ok = pool.register("tags", "SELECT ARRAY(SELECT name FROM tags ORDER BY name)", none) && ok
  // Users.
  ok = pool.register("user_id", "SELECT id, username, email, bio, image FROM users WHERE id = $1", none) && ok
  ok =
    pool.register(
      "login",
      "SELECT id, username, email, bio, image, password_hash FROM users WHERE email = $1",
      none
    ) && ok
  ok =
    pool.register(
      "signup",
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, bio, image",
      none
    ) && ok
  ok =
    pool.register(
      "user_update",
      "UPDATE users SET email = COALESCE($2, email), username = COALESCE($3, username), " +
        "password_hash = COALESCE($4, password_hash), bio = COALESCE($5, bio), image = COALESCE($6, image) " +
        "WHERE id = $1 RETURNING id, username, email, bio, image",
      none
    ) && ok
  // Profiles and follows: the lookup and the write in one statement.
  ok =
    pool.register(
      "profile",
      "SELECT u.username, u.bio, u.image, " +
        FOLLOWING_1 +
        "u.id) AS following FROM users u WHERE u.username = $2",
      none
    ) && ok
  ok =
    pool.register(
      "follow",
      "WITH u AS (SELECT id, username, bio, image FROM users WHERE username = $2), " +
        "i AS (INSERT INTO follows (follower_id, followee_id) SELECT $1::bigint, u.id FROM u ON CONFLICT DO NOTHING) " +
        "SELECT username, bio, image FROM u",
      none
    ) && ok
  ok =
    pool.register(
      "unfollow",
      "WITH u AS (SELECT id, username, bio, image FROM users WHERE username = $2), " +
        "d AS (DELETE FROM follows fo USING u WHERE fo.follower_id = $1 AND fo.followee_id = u.id) " +
        "SELECT username, bio, image FROM u",
      none
    ) && ok
  // Writing articles. A create is one group: the article, its tags, then the article as written.
  ok =
    pool.register(
      "article_create",
      "INSERT INTO articles (id, slug, author_id, title, description, body) SELECT n.id, " +
        SLUGIFY_2 +
        " || '-' || n.id, $1::bigint, $2::text, $3::text, $4::text FROM (SELECT nextval(pg_get_serial_sequence('articles', 'id')) AS id) n RETURNING id",
      none
    ) && ok
  ok =
    pool.register(
      "tags_create",
      "INSERT INTO tags (name) SELECT DISTINCT unnest($1::text[]) ON CONFLICT (name) DO NOTHING",
      none
    ) && ok
  ok =
    pool.register(
      "article_tags_create",
      "INSERT INTO article_tags (article_id, tag_id) SELECT " +
        LAST_ARTICLE +
        ", t.id FROM tags t WHERE t.name = ANY($1::text[])",
      none
    ) && ok
  ok = pool.register("article_owner", "SELECT id, author_id FROM articles WHERE slug = $1", none) && ok
  ok =
    pool.register(
      "article_update",
      "UPDATE articles SET title = COALESCE($2, title), description = COALESCE($3, description), body = COALESCE($4, body), " +
        "slug = CASE WHEN $2::text IS NULL THEN slug ELSE " +
        SLUGIFY_2 +
        " || '-' || id END, updated_at = now() WHERE id = $1",
      none
    ) && ok
  ok =
    pool.register(
      "article_delete",
      "WITH a0 AS (SELECT id, author_id FROM articles WHERE slug = $1), " +
        "d AS (DELETE FROM articles a USING a0 WHERE a.id = a0.id AND a0.author_id = $2) SELECT author_id FROM a0",
      none
    ) && ok
  // Favorites: the write, then the article as it is after it, in one group.
  ok =
    pool.register(
      "favorite",
      "INSERT INTO favorites (user_id, article_id) SELECT $1::bigint, a.id FROM articles a WHERE a.slug = $2 ON CONFLICT DO NOTHING",
      none
    ) && ok
  ok =
    pool.register(
      "unfavorite",
      "DELETE FROM favorites f USING articles a WHERE f.user_id = $1 AND f.article_id = a.id AND a.slug = $2",
      none
    ) && ok
  // Comments: the article and its newest comments in one statement, one row
  // with the comment columns NULL when it has none, and no row when the
  // article does not exist.
  ok =
    pool.register(
      "comments",
      "SELECT a.id, c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image, " +
        FOLLOWING_1 +
        "c.author_id) FROM articles a LEFT JOIN LATERAL (SELECT c.id, c.body, c.created_at, c.updated_at, c.author_id " +
        "FROM comments c WHERE c.article_id = a.id ORDER BY c.created_at DESC, c.id DESC LIMIT 100) c ON true " +
        "LEFT JOIN users u ON u.id = c.author_id WHERE a.slug = $2 ORDER BY c.created_at DESC, c.id DESC",
      none
    ) && ok
  ok =
    pool.register(
      "comment_create",
      "WITH a0 AS (SELECT id FROM articles WHERE slug = $1), " +
        "c AS (INSERT INTO comments (article_id, author_id, body) SELECT a0.id, $2::bigint, $3::text FROM a0 RETURNING id, body, created_at, updated_at, author_id) " +
        "SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image FROM c JOIN users u ON u.id = c.author_id",
      none
    ) && ok
  ok =
    pool.register(
      "comment_delete",
      "WITH c0 AS (SELECT c.id, c.author_id FROM comments c JOIN articles a ON a.id = c.article_id WHERE c.id = $1 AND a.slug = $2), " +
        "d AS (DELETE FROM comments c USING c0 WHERE c.id = c0.id AND c0.author_id = $3) SELECT author_id FROM c0",
      none
    ) && ok
  return ok
}

/**
 * The batcher of article reads by slug: one execution answers many requests'
 * `GET /api/articles/:slug`, each distinct key (viewer and slug) once, in
 * `COL_` order with `a.body` last. A slug that matches nothing has no row, so
 * its request alone answers 404. Coalescing waiting reads into one statement
 * over arrays, routed back by ordinal, is an idea from the challenge's
 * rust-tokio-Scooter1337 submission; the SQL is written here.
 */
export const articleBatch = (maxRequests: i32, runs: i32): PgBatchConfig =>
  batchConfig(
    "article_slugs",
    LIST_FAVORITED +
      "k.viewer" +
      LIST_FOLLOWING +
      "k.viewer" +
      LIST_END +
      ", a.body" +
      KEY_FROM +
      " JOIN articles a ON a.slug = k.slug JOIN users u ON u.id = a.author_id",
    "",
    maxRequests,
    runs
  )

/**
 * The batcher of comment reads by slug, as `articleBatch` is of articles: the
 * article and its newest comments, one row with the comment columns NULL when
 * it has none, and no row when the article does not exist.
 */
export const commentBatch = (maxRequests: i32, runs: i32): PgBatchConfig =>
  batchConfig(
    "comment_slugs",
    "SELECT a.id AS article_id, c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image, " +
      "EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = k.viewer AND fo.followee_id = c.author_id) AS following" +
      KEY_FROM +
      " JOIN articles a ON a.slug = k.slug LEFT JOIN LATERAL (SELECT c.id, c.body, c.created_at, c.updated_at, c.author_id " +
      "FROM comments c WHERE c.article_id = a.id ORDER BY c.created_at DESC, c.id DESC LIMIT 100) c ON true " +
      "LEFT JOIN users u ON u.id = c.author_id",
    "t.created_at DESC, t.id DESC",
    maxRequests,
    runs
  )

const batchConfig = (name: string, select: string, orderBy: string, maxRequests: i32, runs: i32): PgBatchConfig => {
  const c = new PgBatchConfig()
  c.name = name
  c.select = select
  c.orderBy = orderBy
  c.keyType = PG_BATCH_TEXT
  c.maxRequests = maxRequests
  c.maxBytes = 32768
  c.queueSize = 65536
  c.queueBytes = 4194304
  c.runs = runs
  return c
}
