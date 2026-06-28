package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestUsdcToAtomic(t *testing.T) {
	// Ensure a default for tests
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")

	cases := map[float64]string{
		0.005:  "50000",
		0.05:   "500000",
		0.0001: "1000",
		1.0:    "10000000",
	}
	for in, want := range cases {
		got := usdcToAtomic(in)
		if got != want {
			t.Errorf("usdcToAtomic(%v) = %q; want %q", in, got, want)
		}
	}
	if usdcToAtomic(0) != "0" {
		t.Errorf("zero must produce 0")
	}
}

// TestUsdcToAtomicRounding verifies correct rounding (nearest stroop) for values
// that expose binary-float truncation bugs in a naive implementation.
func TestUsdcToAtomicRounding(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0.001, "10000"},      // 0.001 USDC = 10 000 stroops
		{0.005, "50000"},      // regression: existing case
		{1.0, "10000000"},     // whole USDC
		{0.0, "0"},            // zero
		{0.07, "700000"},      // binary-float: 0.07*1e7 = 699999.999… → must round to 700000
		{0.029, "290000"},     // 0.029*1e7 = 289999.999… → must round to 290000
		{0.1, "1000000"},      // 0.1 is not exact in IEEE-754
		{0.003, "30000"},      // 0.003*1e7 = 30000.000…4 → rounds to 30000
	}
	for _, tc := range cases {
		got := usdcToAtomic(tc.in)
		if got != tc.want {
			t.Errorf("usdcToAtomic(%v) = %q; want %q", tc.in, got, tc.want)
		}
	}
	// Output must never contain a decimal point — it is always a plain integer.
	for _, tc := range cases {
		got := usdcToAtomic(tc.in)
		if strings.Contains(got, ".") {
			t.Errorf("usdcToAtomic(%v) = %q contains a decimal point", tc.in, got)
		}
	}
}

// TestRequireSorobanUSDC verifies the mainnet guard helper.
// The mainnet+empty path calls log.Fatalf and is not unit-testable; only the
// non-fatal paths are covered here.
func TestRequireSorobanUSDC(t *testing.T) {
	// testnet with no USDC_CONTRACT_ID → empty string (optional on testnet)
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("USDC_CONTRACT_ID", "")
	if got := requireSorobanUSDC(); got != "" {
		t.Errorf("testnet+no USDC_CONTRACT_ID: got %q, want empty", got)
	}

	// testnet with explicit USDC_CONTRACT_ID → value returned as-is
	const testnetID = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
	t.Setenv("USDC_CONTRACT_ID", testnetID)
	if got := requireSorobanUSDC(); got != testnetID {
		t.Errorf("testnet+USDC_CONTRACT_ID: got %q, want %q", got, testnetID)
	}

	// mainnet with explicit USDC_CONTRACT_ID → value returned (no fatal)
	const mainnetID = "CMAINNETUSDC1234567890ABCDEF"
	t.Setenv("STELLAR_NETWORK", "mainnet")
	t.Setenv("USDC_CONTRACT_ID", mainnetID)
	if got := requireSorobanUSDC(); got != mainnetID {
		t.Errorf("mainnet+USDC_CONTRACT_ID: got %q, want %q", got, mainnetID)
	}
}

func TestBuildRequirementsRespectsToggle(t *testing.T) {
	cfg := &DomainConfig{
		Domain:          "demo.com",
		StellarAddress:  "GABCDEF1234567890DEMO",
		PricePerRequest: 0.005,
		PaywallEnabled:  true,
	}
	got := buildRequirements(cfg)
	if len(got) != 1 {
		t.Fatalf("expected 1 requirement; got %d", len(got))
	}
	r := got[0]
	if r.Scheme != SchemeExact {
		t.Errorf("scheme: %s", r.Scheme)
	}
	network, asset := networkAsset()
	if r.Network != network {
		t.Errorf("network: %s", r.Network)
	}
	if r.Asset != asset {
		t.Errorf("asset: %s", r.Asset)
	}
	if r.PayTo != cfg.StellarAddress {
		t.Errorf("payTo: %s", r.PayTo)
	}
	if r.Amount != "50000" {
		t.Errorf("amount: %s", r.Amount)
	}
	if r.MaxTimeoutSeconds != MaxTimeoutSeconds {
		t.Errorf("maxTimeoutSeconds: %d", r.MaxTimeoutSeconds)
	}
	if extra, ok := r.Extra["areFeesSponsored"].(bool); !ok || extra {
		t.Errorf("areFeesSponsored should be false; got %v", r.Extra["areFeesSponsored"])
	}
	splits, ok := r.Extra["splitPayments"].([]map[string]interface{})
	if !ok || len(splits) != 2 {
		t.Errorf("expected 2 splits; got %v", r.Extra["splitPayments"])
	}

	cfg.PaywallEnabled = false
	if got := buildRequirements(cfg); len(got) != 0 {
		t.Errorf("toggle off should produce empty requirements; got %v", got)
	}
}

func TestPaymentRequiredJSONIsBase64Decodable(t *testing.T) {
	cfg := &DomainConfig{
		Domain:          "demo.com",
		StellarAddress:  "GABCDEF1234567890DEMO",
		PricePerRequest: 0.005,
		PaywallEnabled:  true,
	}
	body := PaymentRequired{
		X402Version: X402Version,
		Resource:    ResourceInfo{URL: "https://demo.com/hello", MimeType: "text/html"},
		Accepts:     buildRequirements(cfg),
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	enc := base64.StdEncoding.EncodeToString(raw)
	dec, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		t.Fatal(err)
	}
	var roundtrip PaymentRequired
	if err := json.Unmarshal(dec, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if roundtrip.X402Version != X402Version {
		t.Fatalf("version mismatch")
	}
	if !strings.HasSuffix(roundtrip.Resource.URL, "/hello") {
		t.Fatalf("url: %s", roundtrip.Resource.URL)
	}
}

func TestSessionKeyShape(t *testing.T) {
	// Paid sessions are scoped to the paying account so one payment never unlocks
	// the resource for other (anonymous) callers.
	if sessionKey("a.com", "x", "GPAYER") != "paid:a.com:x:GPAYER" {
		t.Fatal()
	}
	// Different payers get distinct keys for the same resource.
	if sessionKey("a.com", "x", "GA") == sessionKey("a.com", "x", "GB") {
		t.Fatal("payer must scope the session key")
	}
}

func TestSiteKeyFor(t *testing.T) {
	// Prefer siteId when present.
	if got := siteKeyFor(&DomainConfig{Domain: "a.com", SiteId: "site_x"}, "a.com"); got != "site_x" {
		t.Errorf("siteKeyFor with siteId = %q; want site_x", got)
	}
	// Fall back to the passed domain when siteId is empty (older data).
	if got := siteKeyFor(&DomainConfig{Domain: "a.com"}, "a.com"); got != "a.com" {
		t.Errorf("siteKeyFor empty siteId = %q; want a.com", got)
	}
	// Nil config falls back to the domain (never 500s).
	if got := siteKeyFor(nil, "a.com"); got != "a.com" {
		t.Errorf("siteKeyFor(nil) = %q; want a.com", got)
	}
}

func TestOnchainKeyFor(t *testing.T) {
	// Explicit onchainKey wins (new token-only site → siteId key).
	if got := onchainKeyFor(&DomainConfig{Domain: "a.com", OnchainKey: "site_x"}); got != "site_x" {
		t.Errorf("onchainKeyFor explicit = %q; want site_x", got)
	}
	// Legacy site: onchainKey empty → falls back to the domain (on-chain key unchanged).
	if got := onchainKeyFor(&DomainConfig{Domain: "web-test.verivyx.com"}); got != "web-test.verivyx.com" {
		t.Errorf("onchainKeyFor legacy = %q; want web-test.verivyx.com", got)
	}
	if got := onchainKeyFor(nil); got != "" {
		t.Errorf("onchainKeyFor(nil) = %q; want empty", got)
	}
}

// TestResolveSite covers token-primary resolution with domain as legacy fallback.
func TestResolveSite(t *testing.T) {
	origToken, origDomain := lookupTokenFn, lookupDomainFn
	defer func() { lookupTokenFn, lookupDomainFn = origToken, origDomain }()

	tokenCfg := &DomainConfig{Domain: "", SiteId: "site_tok", OnchainKey: "site_tok"}
	domainCfg := &DomainConfig{Domain: "a.com", SiteId: "site_dom"}

	// 1) Token present + resolves → token config wins, domain lookup not consulted.
	t.Run("token primary", func(t *testing.T) {
		lookupTokenFn = func(tok string) (*DomainConfig, error) {
			if tok != "tok_123" {
				t.Errorf("unexpected token %q", tok)
			}
			return tokenCfg, nil
		}
		lookupDomainFn = func(d string) (*DomainConfig, error) {
			t.Errorf("domain lookup must not run when token resolves; got %q", d)
			return nil, nil
		}
		got, err := resolveSite("tok_123", "a.com")
		if err != nil || got != tokenCfg {
			t.Fatalf("resolveSite token = %v, %v; want tokenCfg", got, err)
		}
	})

	// 2) Token empty → falls back to domain lookup.
	t.Run("domain fallback (no token)", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) {
			t.Error("token lookup must not run when token is empty")
			return nil, nil
		}
		lookupDomainFn = func(d string) (*DomainConfig, error) {
			if d != "a.com" {
				t.Errorf("unexpected domain %q", d)
			}
			return domainCfg, nil
		}
		got, err := resolveSite("", "a.com")
		if err != nil || got != domainCfg {
			t.Fatalf("resolveSite domain = %v, %v; want domainCfg", got, err)
		}
	})

	// 3) Token present but not found (nil) → falls back to domain.
	t.Run("token miss falls back to domain", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) { return nil, nil }
		lookupDomainFn = func(string) (*DomainConfig, error) { return domainCfg, nil }
		got, err := resolveSite("tok_unknown", "a.com")
		if err != nil || got != domainCfg {
			t.Fatalf("resolveSite token-miss = %v, %v; want domainCfg", got, err)
		}
	})

	// 4) Both yield nil → not found (nil, nil).
	t.Run("both nil", func(t *testing.T) {
		lookupTokenFn = func(string) (*DomainConfig, error) { return nil, nil }
		lookupDomainFn = func(string) (*DomainConfig, error) { return nil, nil }
		got, err := resolveSite("tok_x", "a.com")
		if err != nil || got != nil {
			t.Fatalf("resolveSite both-nil = %v, %v; want nil,nil", got, err)
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
		if err != nil || got != nil {
			t.Fatalf("resolveSite empty = %v, %v; want nil,nil", got, err)
		}
	})
}

func TestProofHash_StableAndDistinct(t *testing.T) {
	a := proofHash("AAAAtx1")
	if a != proofHash("AAAAtx1") {
		t.Fatal("not stable")
	}
	if a == proofHash("AAAAtx2") {
		t.Fatal("collision")
	}
}

func TestBindingDecision(t *testing.T) {
	if bindingDecision("", "d:s") != "ok" {
		t.Fatal("fresh should be ok")
	}
	if bindingDecision("d:s", "d:s") != "ok" {
		t.Fatal("same resource ok")
	}
	if bindingDecision("d:other", "d:s") != "reuse" {
		t.Fatal("cross-slug must be reuse")
	}
}
