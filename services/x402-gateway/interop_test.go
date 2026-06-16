package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// x402 v2 spec advertises the price as `maxAmountRequired` per accepts entry.
// We add it ADDITIVELY (alongside the legacy `amount`) so generic v2 clients can
// read it while the Verivyx agent-sdk / MCP server (which read `amount`) keep working.
func TestBuildRequirementsAdvertisesMaxAmountRequired(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	cfg := &DomainConfig{
		Domain:          "demo.com",
		StellarAddress:  "GABCDEF1234567890DEMO",
		PlatformAddress: "GPLATFORM1234567890",
		PricePerRequest: 0.005,
		PaywallEnabled:  true,
	}
	reqs := buildRequirements(cfg)
	if len(reqs) == 0 {
		t.Fatal("expected at least one requirement")
	}
	for i, r := range reqs {
		if r.MaxAmountRequired == "" {
			t.Errorf("entry %d: maxAmountRequired must be set (x402 v2 spec)", i)
		}
		if r.MaxAmountRequired != r.Amount {
			t.Errorf("entry %d: maxAmountRequired (%s) must mirror amount (%s) for backward compat", i, r.MaxAmountRequired, r.Amount)
		}
	}
}

// The spec puts resource/description/mimeType on each accepts entry.
func TestWithResourceStampsPerEntry(t *testing.T) {
	reqs := []PaymentRequirement{{Scheme: SchemeExact}, {Scheme: SchemeExact}}
	out := withResource(reqs, "https://demo.com/hello", "text/html")
	if len(out) != 2 {
		t.Fatalf("expected 2 entries; got %d", len(out))
	}
	for i, r := range out {
		if r.Resource != "https://demo.com/hello" {
			t.Errorf("entry %d: per-entry resource not set; got %q", i, r.Resource)
		}
		if r.MimeType != "text/html" {
			t.Errorf("entry %d: per-entry mimeType not set; got %q", i, r.MimeType)
		}
	}
}

// A generic x402 v2 client reads scheme/network at the top level of the payload.
// We expose them flat ADDITIVELY while keeping the `accepted` wrapper for the
// Verivyx relayer / agent-sdk that read it.
func TestPaymentPayloadAdvertisesFlatSchemeNetwork(t *testing.T) {
	p := PaymentPayload{
		X402Version: X402Version,
		Scheme:      SchemeExact,
		Network:     NetworkTestnet,
		Accepted:    PaymentRequirement{Scheme: SchemeExact, Network: NetworkTestnet},
		Payload:     map[string]interface{}{"transaction": "abc"},
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	if !strings.Contains(s, `"scheme":"exact"`) {
		t.Errorf("payload must expose flat scheme; got %s", s)
	}
	if !strings.Contains(s, `"network":"stellar:testnet"`) {
		t.Errorf("payload must expose flat network; got %s", s)
	}
	if !strings.Contains(s, `"accepted"`) {
		t.Errorf("payload must still carry the accepted wrapper for backward compat; got %s", s)
	}
}

func TestIsGenericRequirement(t *testing.T) {
	// Trusted: classic Verivyx requirement carries splitPayments.
	classic := PaymentRequirement{Extra: map[string]interface{}{"splitPayments": []interface{}{}}}
	if isGenericRequirement(classic) {
		t.Error("classic requirement with splitPayments must be trusted, not generic")
	}
	// Trusted: Soroban Verivyx requirement carries paywallContract.
	soroban := PaymentRequirement{Extra: map[string]interface{}{"paywallContract": "CAERLWHD"}}
	if isGenericRequirement(soroban) {
		t.Error("Soroban requirement with paywallContract must be trusted, not generic")
	}
	// Generic: spec-shaped requirement with only areFeesSponsored.
	generic := PaymentRequirement{Extra: map[string]interface{}{"areFeesSponsored": true}}
	if !isGenericRequirement(generic) {
		t.Error("requirement without Verivyx settlement extras must be generic")
	}
	// Generic: no extra at all.
	if !isGenericRequirement(PaymentRequirement{}) {
		t.Error("requirement with nil extra must be generic")
	}
}

func TestPickRequirement(t *testing.T) {
	soroban := PaymentRequirement{Asset: "CBIELTK6CONTRACT"}
	classic := PaymentRequirement{Asset: "USDC:GBBD47"}
	reqs := []PaymentRequirement{soroban, classic}

	// Exact asset match wins regardless of preference.
	if got, ok := pickRequirement(reqs, "USDC:GBBD47", true); !ok || got.Asset != classic.Asset {
		t.Errorf("asset match: got (%v, %v), want classic", got.Asset, ok)
	}
	// No hint, preferSoroban=true → contract-id entry.
	if got, ok := pickRequirement(reqs, "", true); !ok || got.Asset != soroban.Asset {
		t.Errorf("preferSoroban: got %v, want soroban", got.Asset)
	}
	// No hint, preferSoroban=false → classic entry (preserves /x-payment-settle default).
	if got, ok := pickRequirement(reqs, "", false); !ok || got.Asset != classic.Asset {
		t.Errorf("preferClassic: got %v, want classic", got.Asset)
	}
	// Empty slice → not ok.
	if _, ok := pickRequirement(nil, "", true); ok {
		t.Error("empty reqs must return ok=false")
	}
}

func TestDeriveResource(t *testing.T) {
	// From payload.Resource.URL with slug.
	p := PaymentPayload{Resource: &ResourceInfo{URL: "https://demo.com/article-1"}}
	d, s := deriveResource(p, PaymentRequirement{}, "", "")
	if d != "demo.com" || s != "article-1" {
		t.Errorf("payload resource: got (%q,%q), want (demo.com, article-1)", d, s)
	}
	// Falls back to per-entry requirement resource.
	d, s = deriveResource(PaymentPayload{}, PaymentRequirement{Resource: "http://x.io/p/2/"}, "", "")
	if d != "x.io" || s != "p/2" {
		t.Errorf("entry resource: got (%q,%q), want (x.io, p/2)", d, s)
	}
	// Headers override.
	d, s = deriveResource(p, PaymentRequirement{}, "override.com", "slug9")
	if d != "override.com" || s != "slug9" {
		t.Errorf("header override: got (%q,%q), want (override.com, slug9)", d, s)
	}
	// Nothing present.
	d, s = deriveResource(PaymentPayload{}, PaymentRequirement{}, "", "")
	if d != "" || s != "" {
		t.Errorf("empty: got (%q,%q), want empty", d, s)
	}
}

func TestHTTPStatusForResolveErr(t *testing.T) {
	cases := map[error]int{
		errDomainRequired:        http.StatusBadRequest,          // 400
		errDomainNotRegistered:   http.StatusNotFound,            // 404
		errNoMatchingRequirement: http.StatusUnprocessableEntity, // 422
		fmt.Errorf("other"):      http.StatusBadGateway,         // 502
	}
	for err, want := range cases {
		if got := httpStatusForResolveErr(err); got != want {
			t.Errorf("err %v: got %d, want %d", err, got, want)
		}
	}
}

func TestResolveRequirement(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("SOROBAN_PAYWALL_CONTRACT_ID", "CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH")
	t.Setenv("STELLAR_NETWORK", "testnet")

	orig := lookupDomainFn
	defer func() { lookupDomainFn = orig }()
	lookupDomainFn = func(domain string) (*DomainConfig, error) {
		if domain != "demo.com" {
			return nil, nil
		}
		return &DomainConfig{
			Domain: "demo.com", StellarAddress: "GCREATOR", PlatformAddress: "GPLATFORM",
			PricePerRequest: 0.005, PaywallEnabled: true,
		}, nil
	}

	// Trusted requirement (carries splitPayments) is returned unchanged.
	trusted := PaymentRequirement{Asset: "USDC:GBBD47", Amount: "50000",
		Extra: map[string]interface{}{"splitPayments": []interface{}{}}}
	got, tdomain, tslug, err := resolveRequirement(PaymentPayload{Resource: &ResourceInfo{URL: "https://demo.com/a"}}, trusted, "", "")
	if err != nil {
		t.Fatalf("trusted: unexpected err %v", err)
	}
	if got.Amount != "50000" || got.Asset != "USDC:GBBD47" {
		t.Errorf("trusted requirement must pass through unmodified, got %+v", got)
	}
	if tdomain != "demo.com" || tslug != "a" {
		t.Errorf("trusted: deriveResource must still run, got (%q,%q), want (demo.com, a)", tdomain, tslug)
	}

	// Generic Soroban requirement → reconstructed with Verivyx extras.
	generic := PaymentRequirement{
		Asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
		Extra: map[string]interface{}{"areFeesSponsored": true},
	}
	payload := PaymentPayload{Resource: &ResourceInfo{URL: "https://demo.com/article"}}
	canon, domain, slug, err := resolveRequirement(payload, generic, "", "")
	if err != nil {
		t.Fatalf("generic: unexpected err %v", err)
	}
	if domain != "demo.com" || slug != "article" {
		t.Errorf("generic: derived (%q,%q), want (demo.com, article)", domain, slug)
	}
	if canon.Amount == "" {
		t.Error("generic: reconstructed requirement must carry amount")
	}
	if _, ok := canon.Extra["paywallContract"]; !ok {
		t.Error("generic: reconstructed Soroban requirement must carry extra.paywallContract")
	}
	if _, ok := canon.Extra["domain"]; !ok {
		t.Error("generic: reconstructed Soroban requirement must carry extra.domain")
	}

	// Generic but domain not derivable → errDomainRequired.
	if _, _, _, err := resolveRequirement(PaymentPayload{}, generic, "", ""); err != errDomainRequired {
		t.Errorf("missing domain: got err %v, want errDomainRequired", err)
	}

	// Generic, domain not registered → errDomainNotRegistered.
	if _, _, _, err := resolveRequirement(PaymentPayload{Resource: &ResourceInfo{URL: "https://nope.com/x"}}, generic, "", ""); err != errDomainNotRegistered {
		t.Errorf("unregistered domain: got err %v, want errDomainNotRegistered", err)
	}
}
