package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// A minimal HTTP/1.1 keep-alive client: one TCP connection per virtual user, like a browser tab talking to one
// origin. net/http's Transport would cost two extra goroutines and ~10 KB of buffers per idle connection; here an
// idle user holds only its net.Conn, and the read/write buffers are borrowed from pools for the duration of a
// request. Responses are parsed with net/http.ReadResponse (chunked, content-length, Connection: close).

const reqTimeout = 10 * time.Second

var (
	brPool  = sync.Pool{New: func() any { return bufio.NewReaderSize(nil, 4096) }}
	bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}
	gzPool  sync.Pool
)

type httpTarget struct {
	addrs []string       // host:port to dial; VU g dials addrs[g mod len] (several IPs of one target: >64k users per load box)
	srcs  []*net.TCPAddr // local IPs to dial from (-src); VU g binds srcs[g/len(addrs) mod len]; none = the kernel picks
	host  string         // Host header (the first target's)
}

type conn struct {
	c      net.Conn
	addr   string       // host:port this user dials
	local  *net.TCPAddr // local IP this user dials from (nil = the kernel picks)
	reused bool         // has served at least one response
}

func (c *conn) close() {
	if c.c != nil {
		c.c.Close()
		c.c = nil
	}
}

// bindNoPort sets IP_BIND_ADDRESS_NO_PORT (Linux) on a socket bound to a -src IP, so its port is chosen at
// connect time, unique per destination, instead of at bind time from the whole range.
func bindNoPort(_, _ string, rc syscall.RawConn) error {
	const ipBindAddressNoPort = 24
	rc.Control(func(fd uintptr) { syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, ipBindAddressNoPort, 1) })
	return nil
}

var dialer = net.Dialer{KeepAlive: -1} // browsers don't send TCP keep-alive probes on idle sockets this often; HTTP keep-alive is what matters

// do sends one request and reads the whole response. If want is non-nil and the status is 2xx, it gets the
// (decompressed) body, which is only valid during the call. A request on a reused connection that fails before
// any response byte arrives (the server closed the idle connection) is retried once on a fresh connection,
// as browsers do.
func (c *conn) do(t *httpTarget, dials *atomic.Int64, method, path, token string, body []byte, want func([]byte)) (int, error) {
	deadline := time.Now().Add(reqTimeout)
	wb := bufPool.Get().(*bytes.Buffer)
	wb.Reset()
	wb.WriteString(method)
	wb.WriteByte(' ')
	wb.WriteString(path)
	wb.WriteString(" HTTP/1.1\r\nHost: ")
	wb.WriteString(t.host)
	wb.WriteString("\r\nUser-Agent: conduit-loadgen/1\r\nAccept: application/json\r\nAccept-Encoding: gzip\r\n")
	if token != "" {
		wb.WriteString("Authorization: Token ")
		wb.WriteString(token)
		wb.WriteString("\r\n")
	}
	if body != nil || method != "GET" {
		if body != nil {
			wb.WriteString("Content-Type: application/json\r\n")
		}
		wb.WriteString("Content-Length: ")
		wb.WriteString(strconv.Itoa(len(body)))
		wb.WriteString("\r\n")
	}
	wb.WriteString("\r\n")
	wb.Write(body)
	defer bufPool.Put(wb)

	for attempt := 0; ; attempt++ {
		status, retryable, err := c.roundTrip(t, dials, wb.Bytes(), deadline, want)
		if err == nil {
			return status, nil
		}
		c.close()
		if retryable && attempt == 0 && time.Now().Before(deadline) {
			continue
		}
		if time.Now().After(deadline) {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				err = errTimeout
			}
		}
		return 0, err
	}
}

func (c *conn) roundTrip(t *httpTarget, dials *atomic.Int64, req []byte, deadline time.Time, want func([]byte)) (status int, retryable bool, err error) {
	if c.c == nil {
		dials.Add(1)
		d := dialer
		d.Deadline = deadline
		if c.local != nil {
			d.LocalAddr, d.Control = c.local, bindNoPort
		}
		nc, err := d.Dial("tcp", c.addr)
		if err != nil {
			return 0, false, err
		}
		if tc, ok := nc.(*net.TCPConn); ok {
			tc.SetNoDelay(true)
		}
		c.c, c.reused = nc, false
	}
	reused := c.reused
	c.c.SetDeadline(deadline)
	if _, err := c.c.Write(req); err != nil {
		return 0, reused && isConnGone(err), err
	}
	br := brPool.Get().(*bufio.Reader)
	br.Reset(c.c)
	defer func() { br.Reset(nil); brPool.Put(br) }()
	if _, err := br.Peek(1); err != nil {
		return 0, reused && isConnGone(err), err
	}
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return 0, false, err
	}
	status = resp.StatusCode
	if want != nil && status >= 200 && status < 300 {
		err = readBody(resp, want)
	} else {
		_, err = io.Copy(io.Discard, resp.Body)
	}
	resp.Body.Close()
	if err != nil {
		return 0, false, err
	}
	c.reused = true
	if resp.Close || br.Buffered() > 0 {
		c.close()
	}
	return status, false, nil
}

func readBody(resp *http.Response, want func([]byte)) error {
	b := bufPool.Get().(*bytes.Buffer)
	b.Reset()
	defer bufPool.Put(b)
	var r io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		var zr *gzip.Reader
		if v := gzPool.Get(); v != nil {
			zr = v.(*gzip.Reader)
			if err := zr.Reset(resp.Body); err != nil {
				return err
			}
		} else {
			var err error
			if zr, err = gzip.NewReader(resp.Body); err != nil {
				return err
			}
		}
		defer gzPool.Put(zr)
		r = zr
	}
	if _, err := b.ReadFrom(r); err != nil {
		return err
	}
	if r != resp.Body { // drain trailing gzip framing
		io.Copy(io.Discard, resp.Body)
	}
	want(b.Bytes())
	return nil
}

func isConnGone(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE)
}
