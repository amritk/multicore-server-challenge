package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type app struct {
	db     *pgxpool.Pool
	secret []byte
}

type userData struct {
	Email, Token, Username string
	Bio, Image             *string
}
type profileData struct {
	Username   string
	Bio, Image *string
	Following  bool
}
type articleData struct {
	Slug, Title, Description, Body string
	Tags                           []string
	Created, Updated               time.Time
	Favorites                      int
	Favorited                      bool
	Author                         profileData
}
type commentData struct {
	ID               int64
	Body             string
	Created, Updated time.Time
	Author           profileData
}

type userInput struct {
	User struct {
		Username, Email, Password *string
		Bio, Image                *string
	}
}
type articleInput struct {
	Article struct {
		Title, Description, Body *string
		TagList                  []*string
	}
}
type commentInput struct{ Comment struct{ Body *string } }

func main() {
	url, secret := os.Getenv("DATABASE_URL"), os.Getenv("JWT_SECRET")
	if url == "" || secret == "" {
		log.Fatal("DATABASE_URL and JWT_SECRET are required")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		log.Fatal(err)
	}
	cfg.MaxConns, cfg.MinConns = 48, 8
	cfg.ConnConfig.RuntimeParams["application_name"] = "conduit-go-nethttp"
	cfg.ConnConfig.RuntimeParams["TimeZone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["jit"] = "off"
	db, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	a := &app{db: db, secret: []byte(secret)}
	server := &http.Server{
		Addr:              net.JoinHostPort(env("HOST", "0.0.0.0"), env("PORT", "80")),
		Handler:           http.HandlerFunc(a.serve),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 64 << 10,
	}
	log.Printf("conduit transport=net/http pgxpool=%d", cfg.MaxConns)
	log.Fatal(server.ListenAndServe())
}
func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func (a *app) serve(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimSuffix(r.URL.Path, "/")
	if p == "" {
		p = "/"
	}
	switch {
	case p == "/api/tags":
		a.tags(r.Context(), w, r)
	case p == "/api/users" && r.Method == http.MethodPost:
		a.register(r.Context(), w, r)
	case p == "/api/users/login" && r.Method == http.MethodPost:
		a.login(r.Context(), w, r)
	case p == "/api/user":
		a.user(r.Context(), w, r)
	case strings.HasPrefix(p, "/api/profiles/"):
		a.profile(r.Context(), w, r, strings.TrimPrefix(p, "/api/profiles/"))
	case p == "/api/articles":
		a.articleList(r.Context(), w, r)
	case p == "/api/articles/feed":
		a.feed(r.Context(), w, r)
	case strings.HasPrefix(p, "/api/articles/"):
		a.articleRoute(r.Context(), w, r, strings.TrimPrefix(p, "/api/articles/"))
	default:
		fail(w, 404, "not found")
	}
}
func decode(r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("body")
	}
	defer r.Body.Close()
	d := json.NewDecoder(io.LimitReader(r.Body, 2<<20))
	return d.Decode(dst)
}
func decodeUser(r *http.Request, dst *userInput) (bool, error) {
	if r.Body == nil {
		return false, errors.New("body")
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return false, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false, err
	}
	_, wrapped := envelope["user"]
	return wrapped, nil
}
func decodeArticle(r *http.Request, dst *articleInput) (bool, error) {
	if r.Body == nil {
		return false, errors.New("body")
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return false, err
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false, err
	}
	_, wrapped := envelope["article"]
	return wrapped, nil
}
func output(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	output(w, status, map[string]any{"errors": map[string][]string{"body": {message}}})
}
func userJSON(u userData) map[string]any {
	return map[string]any{"email": u.Email, "token": u.Token, "username": u.Username, "bio": u.Bio, "image": u.Image}
}
func profileJSON(p profileData) map[string]any {
	return map[string]any{"username": p.Username, "bio": p.Bio, "image": p.Image, "following": p.Following}
}
func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func articleJSON(a articleData) map[string]any {
	return map[string]any{"slug": a.Slug, "title": a.Title, "description": a.Description, "tagList": a.Tags, "createdAt": stamp(a.Created), "updatedAt": stamp(a.Updated), "favoritesCount": a.Favorites, "favorited": a.Favorited, "author": profileJSON(a.Author)}
}
func fullArticleJSON(a articleData) map[string]any { x := articleJSON(a); x["body"] = a.Body; return x }
func commentJSON(c commentData) map[string]any {
	return map[string]any{"id": c.ID, "body": c.Body, "createdAt": stamp(c.Created), "updatedAt": stamp(c.Updated), "author": profileJSON(c.Author)}
}

func verify(token string, secret []byte) (int64, bool) {
	p := strings.Split(token, ".")
	if len(p) != 3 {
		return 0, false
	}
	m := hmac.New(sha256.New, secret)
	_, _ = m.Write([]byte(p[0] + "." + p[1]))
	sig, e := base64.RawURLEncoding.DecodeString(p[2])
	if e != nil || !hmac.Equal(m.Sum(nil), sig) {
		return 0, false
	}
	raw, e := base64.RawURLEncoding.DecodeString(p[1])
	if e != nil {
		return 0, false
	}
	var c struct {
		Sub string
		Exp int64
	}
	if json.Unmarshal(raw, &c) != nil || c.Exp <= time.Now().Unix() {
		return 0, false
	}
	id, e := strconv.ParseInt(c.Sub, 10, 64)
	return id, e == nil && id > 0
}
func token(id int64, secret []byte) string {
	enc := base64.RawURLEncoding
	h, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	n := time.Now().Unix()
	p, _ := json.Marshal(map[string]any{"sub": strconv.FormatInt(id, 10), "iat": n, "exp": n + 30*24*3600})
	hs := enc.EncodeToString(h)
	ps := enc.EncodeToString(p)
	m := hmac.New(sha256.New, secret)
	_, _ = m.Write([]byte(hs + "." + ps))
	return hs + "." + ps + "." + enc.EncodeToString(m.Sum(nil))
}
func (a *app) auth(r *http.Request) (int64, string, bool, bool) {
	h := r.Header.Get("Authorization")
	if h == "" {
		return 0, "", false, false
	}
	p := strings.Fields(h)
	if len(p) != 2 || !strings.EqualFold(p[0], "Token") {
		return 0, "", false, true
	}
	id, ok := verify(p[1], a.secret)
	return id, p[1], ok, true
}
func isUnique(err error) bool { var e *pgconn.PgError; return errors.As(err, &e) && e.Code == "23505" }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func nullablePtr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

var slugChars = regexp.MustCompile(`[^A-Za-z0-9]+`)

func slugify(s string) string {
	return strings.Trim(strings.ToLower(slugChars.ReplaceAllString(s, "-")), "-")
}
func text(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (a *app) register(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	var in userInput
	if decode(r, &in) != nil || in.User.Username == nil || in.User.Email == nil || in.User.Password == nil || text(in.User.Username) == "" || text(in.User.Email) == "" || text(in.User.Password) == "" {
		fail(w, 422, "validation error")
		return
	}
	hash, e := bcrypt.GenerateFromPassword([]byte(text(in.User.Password)), 10)
	if e != nil {
		fail(w, 422, "validation error")
		return
	}
	var id int64
	var email, username string
	var bio, image *string
	e = a.db.QueryRow(ctx, "INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING id,email,username,bio,image", text(in.User.Username), text(in.User.Email), string(hash)).Scan(&id, &email, &username, &bio, &image)
	if e != nil {
		if isUnique(e) {
			fail(w, 422, "email or username already taken")
		} else {
			fail(w, 500, "server error")
		}
		return
	}
	output(w, 201, map[string]any{"user": userJSON(userData{Email: email, Token: token(id, a.secret), Username: username, Bio: bio, Image: image})})
}
func (a *app) login(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	var in userInput
	if decode(r, &in) != nil || in.User.Email == nil || in.User.Password == nil || text(in.User.Email) == "" || text(in.User.Password) == "" {
		fail(w, 422, "validation error")
		return
	}
	var id int64
	var email, username, hash string
	var bio, image *string
	e := a.db.QueryRow(ctx, "SELECT id,email,username,password_hash,bio,image FROM users WHERE email=$1", text(in.User.Email)).Scan(&id, &email, &username, &hash, &bio, &image)
	if e != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(text(in.User.Password))) != nil {
		fail(w, 401, "unauthorized")
		return
	}
	output(w, 200, map[string]any{"user": userJSON(userData{Email: email, Token: token(id, a.secret), Username: username, Bio: bio, Image: image})})
}
func (a *app) user(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	id, t, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	if r.Method == http.MethodGet {
		var email, username string
		var bio, image *string
		e := a.db.QueryRow(ctx, "SELECT email,username,bio,image FROM users WHERE id=$1", id).Scan(&email, &username, &bio, &image)
		if e != nil {
			fail(w, 401, "unauthorized")
			return
		}
		output(w, 200, map[string]any{"user": userJSON(userData{Email: email, Token: t, Username: username, Bio: bio, Image: image})})
		return
	}
	if r.Method != http.MethodPut {
		fail(w, 405, "method not allowed")
		return
	}
	var in userInput
	wrapped, err := decodeUser(r, &in)
	if err != nil || !wrapped {
		fail(w, 422, "validation error")
		return
	}
	var hash any
	if in.User.Password != nil {
		if text(in.User.Password) == "" {
			fail(w, 422, "validation error")
			return
		}
		h, e := bcrypt.GenerateFromPassword([]byte(text(in.User.Password)), 10)
		if e != nil {
			fail(w, 422, "validation error")
			return
		}
		hash = string(h)
	}
	var email, username string
	var bio, image *string
	if (in.User.Email != nil && text(in.User.Email) == "") || (in.User.Username != nil && text(in.User.Username) == "") {
		fail(w, 422, "validation error")
		return
	}
	e := a.db.QueryRow(ctx, "UPDATE users SET email=COALESCE($1,email),username=COALESCE($2,username),password_hash=COALESCE($3,password_hash),bio=COALESCE($4,bio),image=COALESCE($5,image) WHERE id=$6 RETURNING email,username,bio,image", in.User.Email, in.User.Username, hash, in.User.Bio, in.User.Image, id).Scan(&email, &username, &bio, &image)
	if e != nil {
		if isUnique(e) {
			fail(w, 422, "email or username already taken")
		} else {
			fail(w, 500, "server error")
		}
		return
	}
	output(w, 200, map[string]any{"user": userJSON(userData{Email: email, Token: t, Username: username, Bio: bio, Image: image})})
}
func (a *app) profile(ctx context.Context, w http.ResponseWriter, r *http.Request, name string) {
	followRoute := strings.HasSuffix(name, "/follow")
	if followRoute {
		name = strings.TrimSuffix(name, "/follow")
	}
	id, _, ok, p := a.auth(r)
	if p && !ok {
		fail(w, 401, "unauthorized")
		return
	}
	if e := r.Method; (!followRoute && e != http.MethodGet) || (followRoute && e != http.MethodPost && e != http.MethodDelete) {
		fail(w, 405, "method not allowed")
		return
	}
	var bio, image *string
	var following bool
	if r.Method == http.MethodGet {
		e := a.db.QueryRow(ctx, "SELECT u.bio,u.image,EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id) FROM users u WHERE u.username=$2", id, name).Scan(&bio, &image, &following)
		if e != nil {
			fail(w, 404, "not found")
			return
		}
		output(w, 200, map[string]any{"profile": profileJSON(profileData{Username: name, Bio: bio, Image: image, Following: following})})
		return
	}
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var username string
	if r.Method == http.MethodPost {
		e := a.db.QueryRow(ctx, "WITH u AS(SELECT id,username,bio,image FROM users WHERE username=$1),i AS(INSERT INTO follows(follower_id,followee_id) SELECT $2,id FROM u ON CONFLICT DO NOTHING) SELECT username,bio,image FROM u", name, id).Scan(&username, &bio, &image)
		if e != nil {
			fail(w, 404, "not found")
			return
		}
		following = true
	} else {
		_, e := a.db.Exec(ctx, "DELETE FROM follows WHERE follower_id=$1 AND followee_id=(SELECT id FROM users WHERE username=$2)", id, name)
		if e != nil {
			fail(w, 404, "not found")
			return
		}
		e = a.db.QueryRow(ctx, "SELECT username,bio,image FROM users WHERE username=$1", name).Scan(&username, &bio, &image)
		if e != nil {
			fail(w, 404, "not found")
			return
		}
	}
	output(w, 200, map[string]any{"profile": profileJSON(profileData{Username: username, Bio: bio, Image: image, Following: following})})
}
func page(r *http.Request) (int, int, error) {
	l, o := 20, 0
	var e error
	if _, present := r.URL.Query()["limit"]; present {
		x := r.URL.Query().Get("limit")
		if !digits(x) {
			return 0, 0, errors.New("limit")
		}
		l, e = strconv.Atoi(x)
		if e != nil || l < 1 || l > 100 {
			return 0, 0, errors.New("limit")
		}
	}
	if _, present := r.URL.Query()["offset"]; present {
		x := r.URL.Query().Get("offset")
		if !digits(x) {
			return 0, 0, errors.New("offset")
		}
		o, e = strconv.Atoi(x)
		if e != nil || o < 0 {
			return 0, 0, errors.New("offset")
		}
	}
	return l, o, nil
}
func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
func (a *app) tags(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, 405, "method not allowed")
		return
	}
	rows, e := a.db.Query(ctx, "SELECT name FROM tags ORDER BY name")
	if e != nil {
		fail(w, 500, "server error")
		return
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil {
			out = append(out, s)
		}
	}
	output(w, 200, map[string]any{"tags": out})
}

func (a *app) list(ctx context.Context, viewer int64, where string, extra []any, limit, offset int) ([]articleData, int, error) {
	args := []any{viewer}
	args = append(args, extra...)
	lp := len(args) + 1
	op := lp + 1
	q := fmt.Sprintf("SELECT a.slug,a.title,a.description,a.created_at,a.updated_at,COALESCE(ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id ORDER BY t.name),'{}'),(SELECT count(*) FROM favorites f WHERE f.article_id=a.id),EXISTS(SELECT 1 FROM favorites f WHERE f.article_id=a.id AND f.user_id=$1),u.username,u.bio,u.image,EXISTS(SELECT 1 FROM follows fo WHERE fo.follower_id=$1 AND fo.followee_id=a.author_id) FROM articles a JOIN users u ON u.id=a.author_id WHERE %s ORDER BY a.id DESC LIMIT $%d OFFSET $%d", where, lp, op)
	rows, e := a.db.Query(ctx, q, append(args, limit, offset)...)
	if e != nil {
		return nil, 0, e
	}
	defer rows.Close()
	out := []articleData{}
	for rows.Next() {
		var x articleData
		var tags []string
		var bio, image *string
		var favs int
		var following bool
		if e = rows.Scan(&x.Slug, &x.Title, &x.Description, &x.Created, &x.Updated, &tags, &favs, &x.Favorited, &x.Author.Username, &bio, &image, &following); e != nil {
			return nil, 0, e
		}
		x.Tags = tags
		x.Favorites = favs
		x.Author.Bio = bio
		x.Author.Image = image
		x.Author.Following = following
		out = append(out, x)
	}
	cq := "SELECT count(*) FROM (SELECT 1 FROM articles a JOIN users u ON u.id=a.author_id WHERE " + where + " LIMIT 1000) s"
	var count int
	cargs := []any{}
	for _, v := range extra {
		cargs = append(cargs, v)
	}
	if len(cargs) > 0 {
		cq = strings.ReplaceAll(cq, "$2", "$1")
	} else {
		cq = "SELECT count(*) FROM (SELECT 1 FROM articles LIMIT 1000) s"
	}
	if e = a.db.QueryRow(ctx, cq, cargs...).Scan(&count); e != nil {
		return nil, 0, e
	}
	return out, count, nil
}
func (a *app) articleList(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		a.createArticle(ctx, w, r)
		return
	}
	if r.Method != http.MethodGet {
		fail(w, 405, "method not allowed")
		return
	}
	id, _, ok, p := a.auth(r)
	if p && !ok {
		fail(w, 401, "unauthorized")
		return
	}
	limit, offset, e := page(r)
	if e != nil {
		fail(w, 422, "validation error")
		return
	}
	q := r.URL.Query()
	where := "TRUE"
	var extra []any
	if v := q.Get("tag"); v != "" {
		where = "a.id IN (SELECT at.article_id FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE t.name=$2)"
		extra = []any{v}
	} else if v := q.Get("author"); v != "" {
		where = "a.author_id=(SELECT id FROM users WHERE username=$2)"
		extra = []any{v}
	} else if v := q.Get("favorited"); v != "" {
		where = "a.id IN (SELECT f.article_id FROM favorites f JOIN users u ON u.id=f.user_id WHERE u.username=$2)"
		extra = []any{v}
	}
	out, count, e := a.list(ctx, id, where, extra, limit, offset)
	if e != nil {
		fail(w, 500, "server error")
		return
	}
	items := make([]any, 0, len(out))
	for _, x := range out {
		items = append(items, articleJSON(x))
	}
	output(w, 200, map[string]any{"articles": items, "articlesCount": count})
}
func (a *app) feed(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		fail(w, 405, "method not allowed")
		return
	}
	id, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	limit, offset, e := page(r)
	if e != nil {
		fail(w, 422, "validation error")
		return
	}
	out, count, e := a.list(ctx, id, "a.author_id IN (SELECT followee_id FROM follows WHERE follower_id=$2)", []any{id}, limit, offset)
	if e != nil {
		fail(w, 500, "server error")
		return
	}
	items := make([]any, 0, len(out))
	for _, x := range out {
		items = append(items, articleJSON(x))
	}
	output(w, 200, map[string]any{"articles": items, "articlesCount": count})
}
func (a *app) load(ctx context.Context, viewer int64, slug string, body bool) (articleData, error) {
	cols := "a.slug,a.title,a.description,"
	if body {
		cols += "a.body,"
	}
	cols += "a.created_at,a.updated_at"
	q := fmt.Sprintf("SELECT %s,COALESCE(ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id ORDER BY t.name),'{}'),(SELECT count(*) FROM favorites f WHERE f.article_id=a.id),EXISTS(SELECT 1 FROM favorites f WHERE f.article_id=a.id AND f.user_id=$1),u.username,u.bio,u.image,EXISTS(SELECT 1 FROM follows fo WHERE fo.follower_id=$1 AND fo.followee_id=a.author_id) FROM articles a JOIN users u ON u.id=a.author_id WHERE a.slug=$2", cols)
	var x articleData
	var tags []string
	var bio, image *string
	var favs int
	var following bool
	var e error
	if body {
		e = a.db.QueryRow(ctx, q, viewer, slug).Scan(&x.Slug, &x.Title, &x.Description, &x.Body, &x.Created, &x.Updated, &tags, &favs, &x.Favorited, &x.Author.Username, &bio, &image, &following)
	} else {
		e = a.db.QueryRow(ctx, q, viewer, slug).Scan(&x.Slug, &x.Title, &x.Description, &x.Created, &x.Updated, &tags, &favs, &x.Favorited, &x.Author.Username, &bio, &image, &following)
	}
	if e != nil {
		return x, e
	}
	x.Tags = tags
	x.Favorites = favs
	x.Author.Bio = bio
	x.Author.Image = image
	x.Author.Following = following
	return x, nil
}
func (a *app) articleRoute(ctx context.Context, w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(rest, "/")
	slug := parts[0]
	if len(parts) == 1 && r.Method == http.MethodGet {
		id, _, ok, p := a.auth(r)
		if p && !ok {
			fail(w, 401, "unauthorized")
			return
		}
		x, e := a.load(ctx, id, slug, true)
		if e != nil {
			fail(w, 404, "not found")
			return
		}
		output(w, 200, map[string]any{"article": fullArticleJSON(x)})
		return
	}
	if len(parts) == 1 && r.Method == http.MethodPut {
		a.updateArticle(ctx, w, r, slug)
		return
	}
	if len(parts) == 1 && r.Method == http.MethodDelete {
		a.deleteArticle(ctx, w, r, slug)
		return
	}
	if len(parts) == 2 && parts[1] == "favorite" {
		a.favorite(ctx, w, r, slug)
		return
	}
	if len(parts) == 2 && parts[1] == "comments" {
		if r.Method == http.MethodGet {
			a.comments(ctx, w, r, slug)
		} else if r.Method == http.MethodPost {
			a.createComment(ctx, w, r, slug)
		} else {
			fail(w, 405, "method not allowed")
		}
		return
	}
	if len(parts) == 3 && parts[1] == "comments" && r.Method == http.MethodDelete {
		a.deleteComment(ctx, w, r, slug, parts[2])
		return
	}
	fail(w, 404, "not found")
}
func (a *app) createArticle(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	id, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var in articleInput
	if decode(r, &in) != nil || in.Article.Title == nil || in.Article.Description == nil || in.Article.Body == nil || text(in.Article.Title) == "" || text(in.Article.Description) == "" || text(in.Article.Body) == "" {
		fail(w, 422, "validation error")
		return
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		fail(w, 500, "server error")
		return
	}
	defer tx.Rollback(ctx)
	var aid int64
	var slug string
	e = tx.QueryRow(ctx, "WITH n AS (SELECT nextval('articles_id_seq') AS id) INSERT INTO articles(id,author_id,title,description,body,slug) SELECT n.id,$1,$2,$3,$4,trim(both '-' from lower(regexp_replace($2,'[^A-Za-z0-9]+','-','g'))) || '-' || n.id FROM n RETURNING id,slug", id, text(in.Article.Title), text(in.Article.Description), text(in.Article.Body)).Scan(&aid, &slug)
	if e != nil {
		fail(w, 422, "validation error")
		return
	}
	for _, tag := range in.Article.TagList {
		if tag == nil || text(tag) == "" {
			fail(w, 422, "validation error")
			return
		}
		if _, e = tx.Exec(ctx, "INSERT INTO tags(name) VALUES($1) ON CONFLICT(name) DO NOTHING", text(tag)); e != nil {
			fail(w, 500, "server error")
			return
		}
		if _, e = tx.Exec(ctx, "INSERT INTO article_tags(article_id,tag_id) SELECT $1,id FROM tags WHERE name=$2 ON CONFLICT DO NOTHING", aid, text(tag)); e != nil {
			fail(w, 500, "server error")
			return
		}
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, 500, "server error")
		return
	}
	x, e := a.load(ctx, id, slug, true)
	if e != nil {
		fail(w, 500, "server error")
		return
	}
	output(w, 201, map[string]any{"article": fullArticleJSON(x)})
}

func (a *app) comments(ctx context.Context, w http.ResponseWriter, r *http.Request, slug string) {
	id, _, ok, p := a.auth(r)
	if p && !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var exists bool
	if err := a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM articles WHERE slug=$1)", slug).Scan(&exists); err != nil || !exists {
		fail(w, 404, "not found")
		return
	}
	rows, e := a.db.Query(ctx, "SELECT c.id,c.body,c.created_at,c.updated_at,u.username,u.bio,u.image,EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=c.author_id) FROM comments c JOIN articles ar ON ar.id=c.article_id JOIN users u ON u.id=c.author_id WHERE ar.slug=$2 ORDER BY c.created_at DESC,c.id DESC", id, slug)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var x commentData
		var bio, image *string
		var following bool
		if rows.Scan(&x.ID, &x.Body, &x.Created, &x.Updated, &x.Author.Username, &bio, &image, &following) == nil {
			x.Author.Bio = bio
			x.Author.Image = image
			x.Author.Following = following
			out = append(out, commentJSON(x))
		}
	}
	output(w, 200, map[string]any{"comments": out})
}
func (a *app) createComment(ctx context.Context, w http.ResponseWriter, r *http.Request, slug string) {
	id, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var in commentInput
	if decode(r, &in) != nil || in.Comment.Body == nil || text(in.Comment.Body) == "" {
		fail(w, 422, "validation error")
		return
	}
	var x commentData
	var bio, image *string
	e := a.db.QueryRow(ctx, "WITH c AS (INSERT INTO comments(article_id,author_id,body) SELECT id,$1,$2 FROM articles WHERE slug=$3 RETURNING id,body,created_at,updated_at,author_id) SELECT c.id,c.body,c.created_at,c.updated_at,u.username,u.bio,u.image FROM c JOIN users u ON u.id=c.author_id", id, text(in.Comment.Body), slug).Scan(&x.ID, &x.Body, &x.Created, &x.Updated, &x.Author.Username, &bio, &image)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	x.Author.Bio = bio
	x.Author.Image = image
	output(w, 201, map[string]any{"comment": commentJSON(x)})
}
func (a *app) deleteComment(ctx context.Context, w http.ResponseWriter, r *http.Request, slug, idstr string) {
	uid, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	id, e := strconv.ParseInt(idstr, 10, 64)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	var owner int64
	if e := a.db.QueryRow(ctx, "SELECT c.author_id FROM comments c JOIN articles ar ON ar.id=c.article_id WHERE c.id=$1 AND ar.slug=$2", id, slug).Scan(&owner); e != nil {
		fail(w, 404, "not found")
		return
	}
	if owner != uid {
		fail(w, 403, "forbidden")
		return
	}
	if _, e := a.db.Exec(ctx, "DELETE FROM comments WHERE id=$1", id); e != nil {
		fail(w, 500, "server error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (a *app) favorite(ctx context.Context, w http.ResponseWriter, r *http.Request, slug string) {
	uid, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	if r.Method == http.MethodPost {
		_, _ = a.db.Exec(ctx, "INSERT INTO favorites(user_id,article_id) SELECT $1,id FROM articles WHERE slug=$2 ON CONFLICT DO NOTHING", uid, slug)
	} else if r.Method == http.MethodDelete {
		_, _ = a.db.Exec(ctx, "DELETE FROM favorites WHERE user_id=$1 AND article_id=(SELECT id FROM articles WHERE slug=$2)", uid, slug)
	} else {
		fail(w, 405, "method not allowed")
		return
	}
	x, e := a.load(ctx, uid, slug, true)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	output(w, 200, map[string]any{"article": fullArticleJSON(x)})
}
func (a *app) updateArticle(ctx context.Context, w http.ResponseWriter, r *http.Request, slug string) {
	uid, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var in articleInput
	wrapped, err := decodeArticle(r, &in)
	if err != nil || !wrapped {
		fail(w, 422, "validation error")
		return
	}
	if (in.Article.Title != nil && text(in.Article.Title) == "") || (in.Article.Description != nil && text(in.Article.Description) == "") || (in.Article.Body != nil && text(in.Article.Body) == "") {
		fail(w, 422, "validation error")
		return
	}
	var articleID, owner int64
	if e := a.db.QueryRow(ctx, "SELECT id,author_id FROM articles WHERE slug=$1", slug).Scan(&articleID, &owner); e != nil {
		fail(w, 404, "not found")
		return
	}
	if owner != uid {
		fail(w, 403, "forbidden")
		return
	}
	var newSlug string
	_, e := a.db.Exec(ctx, "UPDATE articles SET title=COALESCE($1,title),description=COALESCE($2,description),body=COALESCE($3,body),slug=CASE WHEN $1 IS NULL THEN slug ELSE trim(both '-' from lower(regexp_replace($1,'[^A-Za-z0-9]+','-','g'))) || '-' || id END,updated_at=now() WHERE id=$4", nullablePtr(in.Article.Title), nullablePtr(in.Article.Description), nullablePtr(in.Article.Body), articleID)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	if in.Article.Title != nil {
		newSlug = fmt.Sprintf("%s-%d", slugify(text(in.Article.Title)), articleID)
	} else {
		newSlug = slug
	}
	x, e := a.load(ctx, uid, newSlug, true)
	if e != nil {
		fail(w, 404, "not found")
		return
	}
	output(w, 200, map[string]any{"article": fullArticleJSON(x)})
}
func (a *app) deleteArticle(ctx context.Context, w http.ResponseWriter, r *http.Request, slug string) {
	uid, _, ok, p := a.auth(r)
	if !p || !ok {
		fail(w, 401, "unauthorized")
		return
	}
	var owner int64
	if e := a.db.QueryRow(ctx, "SELECT author_id FROM articles WHERE slug=$1", slug).Scan(&owner); e != nil {
		fail(w, 404, "not found")
		return
	}
	if owner != uid {
		fail(w, 403, "forbidden")
		return
	}
	if _, e := a.db.Exec(ctx, "DELETE FROM articles WHERE slug=$1", slug); e != nil {
		fail(w, 500, "server error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
