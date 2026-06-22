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
