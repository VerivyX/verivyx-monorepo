package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// setupTestRedis starts a miniredis instance, points the package-level rdb at it,
// and registers cleanup. Returns the miniredis server so callers can close it early
// to simulate Redis being down.
func setupTestRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mr := miniredis.RunT(t)
	old := rdb
	rdb = redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb = old })
	return mr
}

// buildInternalSettleBody constructs the JSON body for POST /api/v1/payment/internal/x-payment-settle.
func buildInternalSettleBody(domain, slug, tx string) []byte {
	body := map[string]interface{}{
		"domain": domain,
		"slug":   slug,
		"xPayment": map[string]interface{}{
			"x402Version": X402Version,
			"scheme":      SchemeExact,
			"network":     NetworkTestnet,
			"payload": map[string]interface{}{
				"transaction": tx,
				"payer":       "GPAYER-BIND",
			},
		},
	}
	b, _ := json.Marshal(body)
	return b
}

// buildPublicSettleBody constructs the JSON body for POST /api/v1/payment/settle.
// Uses a trusted (splitPayments-carrying) requirement so resolveRequirement skips
// the domain lookup; the Resource.URL drives domain/slug derivation.
func buildPublicSettleBody(resourceURL, tx string) []byte {
	trustedReq := PaymentRequirement{
		Scheme:  SchemeExact,
		Network: NetworkTestnet,
		Asset:   "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		Amount:  "50000",
		PayTo:   "GABCDEF1234567890DEMO",
		Extra: map[string]interface{}{
			"splitPayments": []interface{}{},
		},
	}
	req := facilitatorRequest{
		X402Version: X402Version,
		PaymentPayload: PaymentPayload{
			X402Version: X402Version,
			Scheme:      SchemeExact,
			Network:     NetworkTestnet,
			Resource:    &ResourceInfo{URL: resourceURL},
			Accepted:    trustedReq,
			Payload: map[string]interface{}{
				"transaction": tx,
				"payer":       "GPAYER-PUB",
			},
		},
		PaymentRequirements: trustedReq,
	}
	b, _ := json.Marshal(req)
	return b
}

const bindingTestToken = "bind-test-token"

func setupBindingTest(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	internalToken = bindingTestToken
	t.Cleanup(func() { internalToken = "" })

	// Stub the domain lookup so the internal handler doesn't hit auth-service.
	origFn := lookupDomainFn
	lookupDomainFn = func(domain string) (*DomainConfig, error) {
		return &DomainConfig{
			Domain:          domain,
			StellarAddress:  "GABCDEF1234567890DEMO",
			PlatformAddress: "GPLATFORM1234",
			PricePerRequest: 0.005,
			PaywallEnabled:  true,
		}, nil
	}
	t.Cleanup(func() { lookupDomainFn = origFn })

	return setupTestRedis(t)
}

// TestInternalHandlerCrossSlugReplay verifies that:
//  1. A fresh proof settles successfully for slugA (200).
//  2. Re-presenting the same proof for slugB is rejected (402 payment_used_for_other_resource).
//  3. A Redis-down condition fails the binding check closed (503 replay_check_unavailable).
func TestInternalHandlerCrossSlugReplay(t *testing.T) {
	mr := setupBindingTest(t)
	f := stubFacilitator(t)
	r := setupRouter(f)

	const tx = "REPLAY-PROOF-INTERNAL-1"

	// 1. Settle for slug-a — must succeed.
	w1 := httptest.NewRecorder()
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/internal/x-payment-settle",
		bytes.NewReader(buildInternalSettleBody("demo.com", "slug-a", tx)))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("fresh settle slugA: got %d, want 200; body: %s", w1.Code, w1.Body)
	}
	var resp1 map[string]interface{}
	if err := json.Unmarshal(w1.Body.Bytes(), &resp1); err != nil {
		t.Fatalf("decode slugA response: %v", err)
	}
	if success, _ := resp1["success"].(bool); !success {
		t.Fatalf("slugA response.success must be true; got %v", resp1)
	}

	// 2. Same proof, different slug — must be rejected as cross-slug replay.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/internal/x-payment-settle",
		bytes.NewReader(buildInternalSettleBody("demo.com", "slug-b", tx)))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusPaymentRequired {
		t.Fatalf("cross-slug replay: got %d, want 402; body: %s", w2.Code, w2.Body)
	}
	var resp2 map[string]interface{}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("decode slugB response: %v", err)
	}
	if resp2["invalidReason"] != "payment_used_for_other_resource" {
		t.Errorf("cross-slug replay: want invalidReason=payment_used_for_other_resource, got %v", resp2["invalidReason"])
	}

	// 3. Redis down — binding check must fail closed (503).
	mr.Close()
	w3 := httptest.NewRecorder()
	const tx2 = "REPLAY-PROOF-INTERNAL-FRESH"
	req3 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/internal/x-payment-settle",
		bytes.NewReader(buildInternalSettleBody("demo.com", "slug-c", tx2)))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusServiceUnavailable {
		t.Fatalf("Redis down: got %d, want 503; body: %s", w3.Code, w3.Body)
	}
	var resp3 map[string]interface{}
	if err := json.Unmarshal(w3.Body.Bytes(), &resp3); err != nil {
		t.Fatalf("decode Redis-down response: %v", err)
	}
	if resp3["error"] != "replay_check_unavailable" {
		t.Errorf("Redis down: want error=replay_check_unavailable, got %v", resp3["error"])
	}
}

// TestPublicSettleCrossSlugReplay mirrors TestInternalHandlerCrossSlugReplay
// for the public POST /api/v1/payment/settle handler, using a trusted requirement
// with Resource.URL to drive domain/slug derivation.
func TestPublicSettleCrossSlugReplay(t *testing.T) {
	mr := setupBindingTest(t)
	f := stubFacilitator(t)
	r := setupRouter(f)

	const tx = "REPLAY-PROOF-PUBLIC-1"

	// 1. Settle for slug-x — must succeed.
	w1 := httptest.NewRecorder()
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle",
		bytes.NewReader(buildPublicSettleBody("https://demo.com/slug-x", tx)))
	req1.Header.Set("Content-Type", "application/json")
	req1.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusOK {
		t.Fatalf("fresh public settle slug-x: got %d, want 200; body: %s", w1.Code, w1.Body)
	}

	// 2. Same proof, different slug — must be rejected.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle",
		bytes.NewReader(buildPublicSettleBody("https://demo.com/slug-y", tx)))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusPaymentRequired {
		t.Fatalf("public cross-slug replay: got %d, want 402; body: %s", w2.Code, w2.Body)
	}
	var resp2 map[string]interface{}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatalf("decode public slugY response: %v", err)
	}
	if resp2["invalidReason"] != "payment_used_for_other_resource" {
		t.Errorf("public cross-slug: want invalidReason=payment_used_for_other_resource, got %v", resp2["invalidReason"])
	}

	// 3. Redis down — binding check must fail closed (503).
	mr.Close()
	w3 := httptest.NewRecorder()
	const tx3 = "REPLAY-PROOF-PUBLIC-FRESH"
	req3 := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle",
		bytes.NewReader(buildPublicSettleBody("https://demo.com/slug-z", tx3)))
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("X-Internal-Token", bindingTestToken)
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusServiceUnavailable {
		t.Fatalf("public Redis down: got %d, want 503; body: %s", w3.Code, w3.Body)
	}
	var resp3 map[string]interface{}
	if err := json.Unmarshal(w3.Body.Bytes(), &resp3); err != nil {
		t.Fatalf("decode public Redis-down response: %v", err)
	}
	if resp3["error"] != "replay_check_unavailable" {
		t.Errorf("public Redis down: want error=replay_check_unavailable, got %v", resp3["error"])
	}
}
