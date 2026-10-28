package main

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"

	"conduitbench/seed"
)

// Shared, read-only configuration of the user model.
type model struct {
	target     *httpTarget
	rec        *Recorder
	secret     []byte
	thinkScale float64
	nArticles  int
	deepZipf   *seed.Zipf // Zipf(0.9) over article recency rank
	tagIndex   map[string]uint8
	runTag     string // sanitized run id, for unique sign-up names
	box        int
	pageCDF    [nPages]float64
	stopAt     time.Time
}

func newModel(t *httpTarget, rec *Recorder, secret string, thinkScale float64, nArticles int, runID string, box int, stopAt time.Time) *model {
	m := &model{target: t, rec: rec, secret: []byte(secret), thinkScale: thinkScale, nArticles: nArticles,
		deepZipf: seed.NewZipf(nArticles, 0.9), tagIndex: map[string]uint8{}, box: box, stopAt: stopAt}
	for i := 1; i <= seed.NTags; i++ {
		m.tagIndex[seed.TagName(i)] = uint8(i - 1)
	}
	var b strings.Builder
	for _, c := range strings.ToLower(runID) {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			b.WriteRune(c)
		}
	}
	m.runTag = b.String()
	if len(m.runTag) > 24 {
		m.runTag = m.runTag[len(m.runTag)-24:]
	}
	sum := 0.0
	for i, w := range pageWeights {
		sum += w
		m.pageCDF[i] = sum
	}
	for i := range m.pageCDF {
		m.pageCDF[i] /= sum
	}
	return m
}

// articleRef is what a user remembers about an article it has seen in a list or opened.
type articleRef struct {
	slug      string
	author    string
	favorited bool
	following bool
	tags      []uint8 // seed tag indexes (0-based)
}

type ownComment struct {
	slug string
	id   int64
}

// VU is one simulated human.
type VU struct {
	m      *model
	r      *rand.Rand
	conn   conn
	userID int64  // seeded user id (0 after a sign-up)
	name   string // own username
	email  string // only for signed-up users (seeded emails are derived)
	token  string

	// per-session state
	list     []articleRef
	cur      *articleRef
	pending  int // page deferred because it needed an article first (-1 = none)
	articles []string
	comments []ownComment

	timer *time.Timer
}

func newVU(m *model, globalIdx int64, seedv uint64) *VU {
	id := globalIdx%seed.NUsers + 1
	v := &VU{m: m, r: rand.New(rand.NewPCG(seedv, uint64(globalIdx))), userID: id, pending: -1}
	n := int64(len(m.target.addrs))
	v.conn.addr = m.target.addrs[globalIdx%n]
	if len(m.target.srcs) > 0 {
		v.conn.local = m.target.srcs[globalIdx/n%int64(len(m.target.srcs))]
	}
	return v
}

// ---------- timing ----------

func (v *VU) expDur(mean, cap time.Duration) time.Duration {
	d := time.Duration(v.r.ExpFloat64() * float64(mean))
	if d > cap {
		d = cap
	}
	return time.Duration(float64(d) * v.m.thinkScale)
}

func (v *VU) think() time.Duration { return v.expDur(7*time.Second, 70*time.Second) }

// sleepUntil returns false if the run is over.
func (v *VU) sleepUntil(ctx context.Context, t time.Time) bool {
	d := time.Until(t)
	if d > 0 {
		if v.timer == nil {
			v.timer = time.NewTimer(d)
		} else {
			v.timer.Reset(d)
		}
		select {
		case <-ctx.Done():
			v.timer.Stop()
			return false
		case <-v.timer.C:
		}
		now := time.Now()
		v.m.rec.wakeLag(now, now.Sub(t))
	}
	return ctx.Err() == nil
}

func (v *VU) sleep(ctx context.Context, d time.Duration) bool {
	return v.sleepUntil(ctx, time.Now().Add(d))
}

// ---------- main loop ----------

func (v *VU) run(ctx context.Context, arrive time.Time) {
	defer v.conn.close()
	if !v.sleepUntil(ctx, arrive) {
		return
	}
	v.m.rec.active.Add(1)
	defer v.m.rec.active.Add(-1)
	v.name = seed.Username(v.userID)
	v.token = mintToken(v.m.secret, v.userID, time.Now())
	if !v.sleep(ctx, v.think()) {
		return
	}
	// Equilibrium start: a user who arrives during the ramp is already partway through a session (logged in,
	// token saved), so the first session skips the session-start request. Session lengths are exponential
	// (memoryless), so the remaining time has the same distribution. Session starts, and with them the bcrypt
	// logins/sign-ups, then arrive at the steady-state rate (users / 15 min) from the first second instead of
	// as a login storm compressed into the ramp.
	first := true
	for ctx.Err() == nil {
		end := time.Now().Add(v.expDur(15*time.Minute, 60*time.Minute))
		if first {
			v.resetSession()
			first = false
		} else {
			v.startSession()
		}
		for ctx.Err() == nil {
			v.page()
			if !v.sleep(ctx, v.think()) {
				return
			}
			if time.Now().After(end) {
				break
			}
		}
	}
}

func (v *VU) resetSession() {
	v.list, v.cur, v.pending, v.articles, v.comments = nil, nil, -1, nil, nil
}

// req runs one request and records it. want (optional) receives the body of a 2xx response.
func (v *VU) req(label int, method, path string, body []byte, want func([]byte)) (int, bool) {
	start := time.Now()
	v.m.rec.started(start)
	status, err := v.conn.do(v.m.target, &v.m.rec.dials, method, path, v.token, body, want)
	v.m.rec.done(label, start, time.Now(), status, err)
	return status, err == nil && status >= 200 && status < 300
}

// ---------- session start ----------

type userResp struct {
	User struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	} `json:"user"`
}

func (v *VU) startSession() {
	v.resetSession()
	now := time.Now()
	u := v.r.Float64()
	switch {
	case u < 0.75: // returning user with a saved token
		v.m.rec.session(SReturning, now)
		if v.userID != 0 {
			v.token = mintToken(v.m.secret, v.userID, now)
		}
		v.req(LUserGet, "GET", "/api/user", nil, nil)
	case u < 0.995: // logs in again (bcrypt verify)
		v.m.rec.session(SLogin, now)
		email := v.email
		if v.userID != 0 {
			email = seed.Email(v.userID)
		}
		body, _ := json.Marshal(map[string]any{"user": map[string]string{"email": email, "password": seed.Password}})
		v.req(LLogin, "POST", "/api/users/login", body, func(b []byte) {
			var ur userResp
			if json.Unmarshal(b, &ur) == nil && ur.User.Token != "" {
				v.token = ur.User.Token
			}
		})
	default: // new sign-up (bcrypt hash), then browses as that user
		v.m.rec.session(SSignup, now)
		n := v.m.rec.signupSeq.Add(1)
		name := "lg" + v.m.runTag + "b" + strconv.Itoa(v.m.box) + "n" + strconv.FormatInt(n, 10)
		email := name + "@loadgen.test"
		body, _ := json.Marshal(map[string]any{"user": map[string]string{"username": name, "email": email, "password": seed.Password}})
		v.req(LSignup, "POST", "/api/users", body, func(b []byte) {
			var ur userResp
			if json.Unmarshal(b, &ur) == nil && ur.User.Token != "" {
				v.token, v.name, v.email, v.userID = ur.User.Token, name, email, 0
			}
		})
	}
}

// ---------- pages ----------

type listResp struct {
	Articles []articleJSON `json:"articles"`
}

type articleJSON struct {
	Slug      string   `json:"slug"`
	TagList   []string `json:"tagList"`
	Favorited bool     `json:"favorited"`
	Author    struct {
		Username  string `json:"username"`
		Following bool   `json:"following"`
	} `json:"author"`
}

func (v *VU) ref(a *articleJSON) articleRef {
	r := articleRef{slug: a.Slug, author: a.Author.Username, favorited: a.Favorited, following: a.Author.Following}
	for _, t := range a.TagList {
		if i, ok := v.m.tagIndex[t]; ok {
			r.tags = append(r.tags, i)
		}
	}
	return r
}

func (v *VU) parseList(b []byte) {
	var lr listResp
	if json.Unmarshal(b, &lr) != nil || len(lr.Articles) == 0 {
		return // an empty list (e.g. a feed of nobody) leaves the previous list on screen
	}
	l := make([]articleRef, len(lr.Articles))
	for i := range lr.Articles {
		l[i] = v.ref(&lr.Articles[i])
	}
	v.list = l
}

func (v *VU) parseArticle(b []byte) {
	var ar struct {
		Article articleJSON `json:"article"`
	}
	if json.Unmarshal(b, &ar) == nil && ar.Article.Slug != "" {
		r := v.ref(&ar.Article)
		v.cur = &r
	}
}

func (v *VU) offset() string {
	if v.r.Float64() < 0.7 {
		return "0"
	}
	return strconv.Itoa(10 * (1 + v.r.IntN(4))) // pages 2–5
}

func (v *VU) drawPage() int {
	u := v.r.Float64()
	for i, c := range v.m.pageCDF {
		if u < c {
			return i
		}
	}
	return PArticle
}

// page performs one page view.
func (v *VU) page() {
	p := v.pending
	v.pending = -1
	if p < 0 {
		p = v.drawPage()
	}
	switch p {
	case PProfile, PProfileFav, PFavorite, PComment, PFollow:
		if v.cur == nil { // needs a current article: open one first, do this page next
			v.pending = p
			p = PArticle
		}
	}
	if p == PFollow && v.cur.author == v.name {
		p = PArticle // no follow button on your own article
	}
	if p == PEdit && len(v.articles) == 0 {
		p = PArticle
	}
	if p == PDeleteComment && len(v.comments) == 0 {
		p = PArticle
	}
	v.m.rec.page(p, time.Now())

	switch p {
	case PHome:
		v.req(LTags, "GET", "/api/tags", nil, nil)
		v.req(LList, "GET", "/api/articles?limit=10&offset="+v.offset(), nil, v.parseList)
	case PYourFeed:
		v.req(LTags, "GET", "/api/tags", nil, nil)
		v.req(LFeed, "GET", "/api/articles/feed?limit=10&offset="+v.offset(), nil, v.parseList)
	case PTag:
		var tag string
		if v.cur != nil && len(v.cur.tags) > 0 && v.r.IntN(2) == 0 {
			tag = seed.TagName(int(v.cur.tags[v.r.IntN(len(v.cur.tags))]) + 1)
		} else {
			tag = seed.TagName(seed.SampleTag(v.r))
		}
		v.req(LListTag, "GET", "/api/articles?tag="+tag+"&limit=10&offset="+v.offset(), nil, v.parseList)
	case PArticle:
		v.articlePage(v.chooseArticle())
	case PProfile:
		u := v.cur.author
		v.req(LProfile, "GET", "/api/profiles/"+u, nil, nil)
		v.req(LListAuthor, "GET", "/api/articles?author="+u+"&limit=5", nil, v.parseList)
	case PProfileFav:
		u := v.cur.author
		v.req(LProfile, "GET", "/api/profiles/"+u, nil, nil)
		v.req(LListFav, "GET", "/api/articles?favorited="+u+"&limit=5", nil, v.parseList)
	case PFavorite:
		a := v.cur
		if a.favorited {
			if _, ok := v.req(LFavDel, "DELETE", "/api/articles/"+a.slug+"/favorite", nil, nil); ok {
				a.favorited = false
			}
		} else if _, ok := v.req(LFavPost, "POST", "/api/articles/"+a.slug+"/favorite", nil, nil); ok {
			a.favorited = true
		}
	case PComment:
		slug := v.cur.slug
		body, _ := json.Marshal(map[string]any{"comment": map[string]string{"body": seed.Sentence(v.r)}})
		v.req(LCommentPost, "POST", "/api/articles/"+slug+"/comments", body, func(b []byte) {
			var cr struct {
				Comment struct {
					ID int64 `json:"id"`
				} `json:"comment"`
			}
			if json.Unmarshal(b, &cr) == nil && cr.Comment.ID != 0 {
				v.comments = append(v.comments, ownComment{slug, cr.Comment.ID})
			}
		})
	case PFollow:
		a := v.cur
		if a.following {
			if _, ok := v.req(LFollowDel, "DELETE", "/api/profiles/"+a.author+"/follow", nil, nil); ok {
				a.following = false
			}
		} else if _, ok := v.req(LFollowPost, "POST", "/api/profiles/"+a.author+"/follow", nil, nil); ok {
			a.following = true
		}
	case PPublish:
		var slug string
		v.req(LArticlePost, "POST", "/api/articles", v.newArticle(), func(b []byte) {
			var ar struct {
				Article articleJSON `json:"article"`
			}
			if json.Unmarshal(b, &ar) == nil {
				slug = ar.Article.Slug
			}
		})
		if slug != "" {
			v.articles = append(v.articles, slug)
			v.articlePage(slug)
		}
	case PEdit:
		slug := v.articles[v.r.IntN(len(v.articles))]
		v.req(LArticle, "GET", "/api/articles/"+slug, nil, v.parseArticle)
		body, _ := json.Marshal(map[string]any{"article": map[string]string{"body": v.text(2 + v.r.IntN(3))}})
		v.req(LArticlePut, "PUT", "/api/articles/"+slug, body, nil)
	case PDeleteComment:
		i := v.r.IntN(len(v.comments))
		c := v.comments[i]
		v.comments = append(v.comments[:i], v.comments[i+1:]...)
		v.req(LCommentDel, "DELETE", "/api/articles/"+c.slug+"/comments/"+strconv.FormatInt(c.id, 10), nil, nil)
	case PSettings:
		v.req(LUserGet, "GET", "/api/user", nil, nil)
		body, _ := json.Marshal(map[string]any{"user": map[string]string{"bio": seed.Sentence(v.r)}})
		v.req(LUserPut, "PUT", "/api/user", body, nil)
	}
}

// chooseArticle: 80% from the last list seen, 20% a deep link (Zipf(0.9) over recency rank).
func (v *VU) chooseArticle() string {
	if len(v.list) > 0 && v.r.Float64() < 0.8 {
		return v.list[v.r.IntN(len(v.list))].slug
	}
	rank := v.m.deepZipf.Sample(v.r)
	return seed.ArticleSlug(int64(v.m.nArticles - rank))
}

func (v *VU) articlePage(slug string) {
	v.req(LArticle, "GET", "/api/articles/"+slug, nil, v.parseArticle)
	v.req(LComments, "GET", "/api/articles/"+slug+"/comments", nil, nil)
}

func (v *VU) text(paragraphs int) string {
	ps := make([]string, paragraphs)
	for i := range ps {
		n := 2 + v.r.IntN(4)
		ss := make([]string, n)
		for j := range ss {
			ss[j] = seed.Sentence(v.r)
		}
		ps[i] = strings.Join(ss, " ")
	}
	return strings.Join(ps, "\n\n")
}

func (v *VU) newArticle() []byte {
	w := make([]string, 3+v.r.IntN(5))
	for i := range w {
		x := seed.Word(v.r)
		w[i] = strings.ToUpper(x[:1]) + x[1:]
	}
	n := 1 + v.r.IntN(3)
	tags := make([]string, 0, n)
	seen := map[int]bool{}
	for len(tags) < n {
		t := seed.SampleTag(v.r)
		if !seen[t] {
			seen[t] = true
			tags = append(tags, seed.TagName(t))
		}
	}
	body, _ := json.Marshal(map[string]any{"article": map[string]any{
		"title": strings.Join(w, " "), "description": seed.Sentence(v.r), "body": v.text(2 + v.r.IntN(3)), "tagList": tags,
	}})
	return body
}
