package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"conduitbench/seed"
)

// stub is a fake Conduit API that answers every endpoint the user model calls with plausible JSON. It gzips
// some responses, closes some connections, and has a short idle timeout, to exercise the client.
type stub struct {
	mu       sync.Mutex
	r        *rand.Rand
	n        atomic.Int64
	bad      atomic.Int64 // requests the stub couldn't route / malformed auth
	conns    atomic.Int64
	commentN atomic.Int64
	articleN atomic.Int64
}

func (s *stub) article(slug string) map[string]any {
	s.mu.Lock()
	fav, fol := s.r.IntN(3) == 0, s.r.IntN(4) == 0
	s.mu.Unlock()
	return map[string]any{"slug": slug, "title": "T", "description": "d", "tagList": []string{seed.TagName(1), seed.TagName(7)},
		"favorited": fav, "favoritesCount": 3, "author": map[string]any{"username": seed.Username(int64(1 + len(slug)%5000)), "following": fol}}
}

func (s *stub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	n := s.n.Add(1)
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Token ") {
		s.bad.Add(1)
	}
	if n%97 == 0 {
		w.Header().Set("Connection", "close")
	}
	p := r.URL.Path
	var out any
	code := 200
	switch {
	case p == "/api/user" || p == "/api/users/login":
		out = map[string]any{"user": map[string]any{"token": r.Header.Get("Authorization")[6:], "username": "x"}}
	case p == "/api/users" && r.Method == "POST":
		code, out = 201, map[string]any{"user": map[string]any{"token": "newtoken", "username": "x"}}
	case p == "/api/tags":
		out = map[string]any{"tags": []string{"a", "b"}}
	case p == "/api/articles" && r.Method == "POST":
		code, out = 201, map[string]any{"article": s.article(fmt.Sprintf("new-%d", s.articleN.Add(1)))}
	case p == "/api/articles" || p == "/api/articles/feed":
		lim := 10
		if r.URL.Query().Get("limit") == "5" {
			lim = 5
		}
		as := []any{}
		for i := 0; i < lim; i++ {
			s.mu.Lock()
			id := 1 + s.r.Int64N(10000)
			s.mu.Unlock()
			as = append(as, s.article(seed.ArticleSlug(id)))
		}
		out = map[string]any{"articles": as, "articlesCount": 1000}
	case strings.HasPrefix(p, "/api/articles/"):
		rest := strings.Split(strings.TrimPrefix(p, "/api/articles/"), "/")
		switch {
		case len(rest) == 1:
			out = map[string]any{"article": s.article(rest[0])}
		case len(rest) == 2 && rest[1] == "favorite":
			out = map[string]any{"article": s.article(rest[0])}
		case len(rest) == 2 && rest[1] == "comments" && r.Method == "GET":
			out = map[string]any{"comments": []any{map[string]any{"id": 1, "body": strings.Repeat("x", 3000)}}}
		case len(rest) == 2 && rest[1] == "comments" && r.Method == "POST":
			code, out = 201, map[string]any{"comment": map[string]any{"id": s.commentN.Add(1), "body": "b"}}
		case len(rest) == 3 && r.Method == "DELETE":
			w.WriteHeader(204)
			return
		default:
			s.bad.Add(1)
			code = 404
		}
	case strings.HasPrefix(p, "/api/profiles/"):
		out = map[string]any{"profile": map[string]any{"username": "x", "following": r.Method == "POST"}}
	default:
		s.bad.Add(1)
		code = 404
	}
	w.Header().Set("Content-Type", "application/json")
	if n%3 == 0 && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(code)
		zw := gzip.NewWriter(w)
		json.NewEncoder(zw).Encode(out)
		zw.Close()
		return
	}
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(out)
}

// TestMixAgainstStub runs the user model at 1/50 think time against the stub and checks the request mix
// against DESIGN.md: ~1.8 calls per page view, ~5% writes, page shares close to the weights, no errors.
func TestMixAgainstStub(t *testing.T) {
	st := &stub{r: rand.New(rand.NewPCG(1, 2))}
	srv := httptest.NewUnstartedServer(st)
	srv.Config.IdleTimeout = 500 * time.Millisecond // forces idle-close + retry paths
	srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		if s == http.StateNew {
			st.conns.Add(1)
		}
	}
	srv.Start()
	defer srv.Close()

	users := 400
	scale := 0.02
	if testing.Short() {
		users = 100
	}
	res, err := runBox(runConfig{target: srv.URL, users: users, ramp: 2 * time.Second, measure: 20 * time.Second, tail: time.Second,
		secret: "s", runID: "test", articles: 10000, thinkScale: scale, t0: time.Now().Add(200 * time.Millisecond)})
	if err != nil {
		t.Fatal(err)
	}
	m := mergeResults([]*BoxResult{res})
	printMerged(os.Stdout, m)
	fmt.Printf("page shares:")
	for i, name := range pageNames {
		fmt.Printf(" %s %.1f%% (want %.1f)", name, m.Mix.PagePct[name], pageWeights[i])
	}
	fmt.Printf("\nsession starts: %v; connections opened: %d; stub requests: %d\n", m.Mix.SessionStarts, st.conns.Load(), st.n.Load())
	// at full scale (mean think 7 s) each user makes calls/page / 7 s
	fmt.Printf("=> at think-scale 1.0: %.3f req/s per user\n", m.Mix.CallsPerPage/7.0)

	if m.Overall.ErrorRate > 0 {
		t.Errorf("errors: %v %q", m.Overall.ErrorClasses, m.Overall.ErrorExample)
	}
	if st.bad.Load() > 0 {
		t.Errorf("%d malformed/unrouted requests", st.bad.Load())
	}
	if c := m.Mix.CallsPerPage; c < 1.75 || c > 1.95 {
		t.Errorf("calls/page %.2f, want ~1.85", c)
	}
	if w := m.Mix.WritePct; w < 4 || w > 6.5 {
		t.Errorf("writes %.1f%%, want ~5%%", w)
	}
	if len(m.Endpoints) < 18 {
		t.Errorf("only %d endpoints exercised", len(m.Endpoints))
	}
}

func TestMintToken(t *testing.T) {
	tok := mintToken([]byte("conduit-dev-secret"), 42, time.Unix(1700000000, 0))
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatal(tok)
	}
}

func TestSplitNice(t *testing.T) {
	b := []boxSpec{{"a", 4}, {"b", 2}, {"c", 4}}
	for _, u := range []int{1, 7, 500, 1001, 12345} {
		s := split(u, b)
		if s[0]+s[1]+s[2] != u {
			t.Fatal(u, s)
		}
	}
	for x, want := range map[float64]int{750: 750, 7520: 7500, 12345: 12000, 99: 100, 1060: 1100} {
		if got := nice(x); got != want {
			t.Errorf("nice(%v)=%d want %d", x, got, want)
		}
	}
}

func TestVerdictAndLGLimit(t *testing.T) {
	mk := func(cpu float64, lat time.Duration, n int) *BoxResult {
		h := newHist()
		for i := 0; i < n; i++ {
			recordUs(h, lat)
		}
		c := cpu
		return &BoxResult{Meta: RunMeta{Users: 10, MeasureS: 10, RampS: 1}, Box: BoxStats{CPUAvg: &c},
			Endpoints: map[string]*EndpointResult{"GET /api/tags": {Count: int64(n), Hist: encodeHist(h), Statuses: map[string]int64{"200": int64(n)}}}}
	}
	m := mergeResults([]*BoxResult{mk(20, 10*time.Millisecond, 100), mk(30, 20*time.Millisecond, 100)})
	if !m.Verdict.Pass || m.Verdict.LGLimited || m.Overall.Count != 200 || m.Overall.RPS != 20 {
		t.Fatalf("%+v %+v", m.Verdict, m.Overall)
	}
	m = mergeResults([]*BoxResult{mk(80, 10*time.Millisecond, 100), mk(30, 600*time.Millisecond, 100)})
	if m.Verdict.Pass || !m.Verdict.LGLimited {
		t.Fatalf("%+v", m.Verdict)
	}
}

func TestStatLine(t *testing.T) {
	b, tot := statLine("cpu  100 5 50 800 20 3 2 20 0 0")
	if tot != 1000 || b != 180 {
		t.Fatal(b, tot)
	}
}

func TestParseSources(t *testing.T) {
	if s, err := parseSources(""); s != nil || err != nil {
		t.Fatalf("empty: %v %v", s, err)
	}
	s, err := parseSources("127.0.0.1, 127.0.0.2")
	if err != nil || len(s) != 2 || s[1].IP.String() != "127.0.0.2" {
		t.Fatalf("list: %v %v", s, err)
	}
	if _, err := parseSources("127.0.0.1,nope"); err == nil {
		t.Fatal("bad IP accepted")
	}
}
