package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestValidHostname(t *testing.T) {
	valid := []string{
		"example.com",
		"web-test.verivyx.com",
		"a.b.c.co.uk",
		"xn--nxasmq6b.com",
	}
	invalid := []string{
		"",
		"evil.com/path",
		"a.com@evil.com",
		"a.com#@evil.com",
		"a.com:8080",
		"a.com?x=1",
		"a.com/../b",
		"http://a.com",
		" a.com",
		"a..com",
		strings.Repeat("a", 254) + ".com",
		"-a.com",
		"a_b.com",
	}
	for _, h := range valid {
		if !isValidHostname(h) {
			t.Errorf("isValidHostname(%q) = false; want true", h)
		}
	}
	for _, h := range invalid {
		if isValidHostname(h) {
			t.Errorf("isValidHostname(%q) = true; want false", h)
		}
	}
}

func TestClassifyAgent(t *testing.T) {
	cases := []struct {
		ua       string
		wantName string
		wantCat  string
	}{
		{"Mozilla/5.0 (compatible; GPTBot/1.1)", "OAI-SearchBot (OpenAI)", "Deep Research"},
		{"OAI-SearchBot/1.0", "OAI-SearchBot (OpenAI)", "Deep Research"},
		{"PerplexityBot/1.0", "PerplexityBot", "RAG Search"},
		{"Mozilla/5.0 (compatible; ClaudeBot/1.0; +anthropic.com)", "ClaudeBot (Anthropic)", "Deep Research"},
		{"Google-Extended", "Google-Extended", "Training Scraper"},
		{"Bytespider", "ByteSpider (TikTok)", "Training Scraper"},
		{"HeadlessChrome/120 puppeteer", "Unknown Headless Chrome", "Training Scraper"},
		{"curl/8.0", "Unknown Agent", "Training Scraper"},
		{"", "Unknown Agent", "Training Scraper"},
	}
	for _, c := range cases {
		name, cat := classifyAgent(c.ua)
		if name != c.wantName || cat != c.wantCat {
			t.Errorf("classifyAgent(%q) = (%q, %q); want (%q, %q)", c.ua, name, cat, c.wantName, c.wantCat)
		}
	}
}

func TestSetPaymentRequiredHeaderIsBase64Decodable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)

	body := map[string]interface{}{"x402Version": 2, "accepts": []string{"a", "b"}}
	setPaymentRequiredHeader(c, body)

	for _, h := range []string{"X-Payment-Required", "Payment-Required"} {
		enc := w.Header().Get(h)
		if enc == "" {
			t.Fatalf("%s header not set", h)
		}
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			t.Fatalf("%s not base64: %v", h, err)
		}
		var round map[string]interface{}
		if err := json.Unmarshal(raw, &round); err != nil {
			t.Fatalf("%s payload not JSON: %v", h, err)
		}
		if round["x402Version"].(float64) != 2 {
			t.Errorf("%s lost x402Version", h)
		}
	}
}

// TestResolveSite covers token-primary resolution with domain as legacy fallback.
func TestResolveSite(t *testing.T) {
	origDomain := lookupDomainFn
	origToken := lookupTokenFn
	defer func() { lookupDomainFn = origDomain; lookupTokenFn = origToken }()

	tokenCfg := &DomainConfig{Domain: ""}
	domainCfg := &DomainConfig{Domain: "ex.com"}

	// 1) Token present + resolves → token config wins, domain lookup not consulted.
	t.Run("token primary", func(t *testing.T) {
		lookupTokenFn = func(tok string) (*DomainConfig, error) {
			if tok != "tok_abc" {
				t.Errorf("unexpected token %q", tok)
			}
			return tokenCfg, nil
		}
		lookupDomainFn = func(d string) (*DomainConfig, error) {
			t.Errorf("domain lookup must not run when token resolves; got %q", d)
			return nil, nil
		}
		got, err := resolveSite("tok_abc", "ex.com")
		if err != nil || got != tokenCfg {
			t.Fatalf("resolveSite token = %v, %v; want tokenCfg", got, err)
		}
	})

	// 2) No token → domain fallback.
	t.Run("domain fallback (no token)", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) {
			t.Error("token lookup must not run when token is empty")
			return nil, nil
		}
		lookupDomainFn = func(d string) (*DomainConfig, error) {
			if d != "ex.com" {
				t.Errorf("unexpected domain %q", d)
			}
			return domainCfg, nil
		}
		got, err := resolveSite("", "ex.com")
		if err != nil || got != domainCfg {
			t.Fatalf("resolveSite domain = %v, %v; want domainCfg", got, err)
		}
	})

	// 3) Token miss (nil) → falls back to domain.
	t.Run("token miss falls back to domain", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) { return nil, nil }
		lookupDomainFn = func(string) (*DomainConfig, error) { return domainCfg, nil }
		got, err := resolveSite("tok_missing", "ex.com")
		if err != nil || got != domainCfg {
			t.Fatalf("resolveSite token-miss = %v, %v; want domainCfg", got, err)
		}
	})

	// 4) Token-only (no domain) resolves → token config, no domain lookup.
	t.Run("token only no domain", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) { return tokenCfg, nil }
		lookupDomainFn = func(d string) (*DomainConfig, error) {
			t.Errorf("domain lookup must not run; got %q", d)
			return nil, nil
		}
		got, err := resolveSite("tok_abc", "")
		if err != nil || got != tokenCfg {
			t.Fatalf("resolveSite token-only = %v, %v; want tokenCfg", got, err)
		}
	})

	// 5) No token + no domain → nil,nil (neither lookup invoked).
	t.Run("empty token and domain", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) {
			t.Error("token lookup must not run")
			return nil, nil
		}
		lookupDomainFn = func(string) (*DomainConfig, error) {
			t.Error("domain lookup must not run")
			return nil, nil
		}
		got, err := resolveSite("", "")
		if got != nil || err != nil {
			t.Fatalf("resolveSite empty = %v, %v; want nil,nil", got, err)
		}
	})
}

// seedDomainCache pre-seeds the domain cache so hydrateHandler does not make
// a real HTTP call to auth-service during tests.
func seedDomainCache(cfg *DomainConfig) {
	domainCacheMu.Lock()
	domainCacheMap[cfg.Domain] = domainCacheEntry{
		cfg:       cfg,
		expiresAt: time.Now().Add(domainCacheTTL),
	}
	domainCacheMu.Unlock()
}

// TestHydrate_AuthorizeMode_NoBody verifies that X-Verivyx-Mode: authorize causes
// the handler to return {authorized:true} without an "html" field and without
// calling fetchArticleBody, even when x402 settlement succeeds.
func TestHydrate_AuthorizeMode_NoBody(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Set required package-level vars that hydrateHandler reads.
	internalTok = []byte("test-internal-token")
	sessionKey = []byte("test-session-key")

	// Start a mock gateway that always returns a successful settle response.
	mockGW := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "x-payment-settle") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"success":true,"transaction":"mock-tx-abc123","network":"testnet","payer":"GPAYER"}`))
			return
		}
		// Any other path (e.g. requirements) — return empty 402 body.
		w.WriteHeader(http.StatusPaymentRequired)
		w.Write([]byte(`{}`))
	}))
	defer mockGW.Close()
	os.Setenv("GATEWAY_URL", mockGW.URL)

	// Pre-seed the domain cache so lookupDomain returns immediately.
	seedDomainCache(&DomainConfig{
		Domain:         "ex.com",
		PaywallEnabled: true,
		WpInternalToken: "wp-tok",
	})

	// Build a minimal valid X-PAYMENT header (base64 of a JSON blob the handler
	// will forward to the mock gateway — content doesn't matter for this test
	// because the mock always returns success).
	xPayload := base64.StdEncoding.EncodeToString([]byte(
		`{"x402Version":2,"scheme":"stellar","network":"testnet","payload":{"transaction":"raw-tx","payer":"GPAYER"}}`,
	))

	body := strings.NewReader(`{"domain":"ex.com","slug":"a"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/content/hydrate", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-PAYMENT", xPayload)
	req.Header.Set("X-Verivyx-Mode", "authorize")

	rr := httptest.NewRecorder()

	// Call hydrateHandler via a minimal Gin engine.
	r := gin.New()
	r.POST("/api/v1/content/hydrate", hydrateHandler)
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d — body: %s", rr.Code, rr.Body.String())
	}

	var out map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("response not JSON: %v — body: %s", err, rr.Body.String())
	}
	if out["html"] != nil {
		t.Fatal("authorize mode must not return html")
	}
	if out["authorized"] != true {
		t.Fatalf("expected authorized:true, got %v — full body: %s", out["authorized"], rr.Body.String())
	}
	if out["transaction"] != "mock-tx-abc123" {
		t.Errorf("expected transaction=mock-tx-abc123, got %v", out["transaction"])
	}
	// PAYMENT-RESPONSE header must still be set (x402 spec compliance).
	if rr.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("PAYMENT-RESPONSE header must be set even in authorize-only mode")
	}
}
