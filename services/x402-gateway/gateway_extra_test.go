package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPaymentSplit(t *testing.T) {
	// default platform fee (0.001) when PlatformFee is unset
	if creator, fee := paymentSplit(&DomainConfig{PricePerRequest: 0.005}); creator != 0.004 || fee != 0.001 {
		t.Errorf("default split = (%v, %v); want (0.004, 0.001)", creator, fee)
	}
	// explicit platform fee
	if creator, fee := paymentSplit(&DomainConfig{PricePerRequest: 0.01, PlatformFee: 0.002}); creator != 0.008 || fee != 0.002 {
		t.Errorf("explicit split = (%v, %v); want (0.008, 0.002)", creator, fee)
	}
	// price below fee → creator share floored at 0 (platform never overdraws creator)
	if creator, fee := paymentSplit(&DomainConfig{PricePerRequest: 0.0005, PlatformFee: 0.001}); creator != 0 || fee != 0.001 {
		t.Errorf("underwater split = (%v, %v); want (0, 0.001)", creator, fee)
	}
	// nil config is safe
	if creator, fee := paymentSplit(nil); creator != 0 || fee != 0 {
		t.Errorf("nil split = (%v, %v); want (0, 0)", creator, fee)
	}
}

func TestUsdcToAtomicNonPositive(t *testing.T) {
	if usdcToAtomic(0) != "0" || usdcToAtomic(-1) != "0" {
		t.Errorf("non-positive amounts must produce 0")
	}
}

func TestBuildRequirementsDualAccepts(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("SOROBAN_PAYWALL_CONTRACT_ID", "CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH")

	cfg := &DomainConfig{
		Domain:          "demo.com",
		StellarAddress:  "GABCDEF1234567890DEMO",
		PlatformAddress: "GPLATFORM1234567890",
		PricePerRequest: 0.005,
		PaywallEnabled:  true,
	}
	got := buildRequirements(cfg)
	if len(got) != 2 {
		t.Fatalf("expected 2 accepts (Soroban + classic); got %d", len(got))
	}

	// Entry 0 — Soroban spec-compliant: payTo = contract, fees sponsored, no splitPayments.
	soroban := got[0]
	if soroban.PayTo != "CAERLWHD47NXIAWNPXUF726BNHPFCYSFU3BVVMWQ2G4LBPWG7GXUTGXH" {
		t.Errorf("soroban payTo should be the paywall contract; got %s", soroban.PayTo)
	}
	if soroban.Asset != "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" {
		t.Errorf("soroban asset should be the SEP-41 USDC contract; got %s", soroban.Asset)
	}
	if v, _ := soroban.Extra["areFeesSponsored"].(bool); !v {
		t.Errorf("soroban areFeesSponsored must be true")
	}
	if _, hasSplit := soroban.Extra["splitPayments"]; hasSplit {
		t.Errorf("soroban entry must NOT carry splitPayments (triggers 2-op check in relayer)")
	}
	if _, hasDist := soroban.Extra["distribution"]; !hasDist {
		t.Errorf("soroban entry must carry informational distribution")
	}
	if soroban.Amount != "50000" {
		t.Errorf("soroban amount should be full price (50000); got %s", soroban.Amount)
	}

	// Entry 1 — classic: payTo = creator, splitPayments present, not sponsored.
	classic := got[1]
	if classic.PayTo != cfg.StellarAddress {
		t.Errorf("classic payTo should be the creator; got %s", classic.PayTo)
	}
	if v, _ := classic.Extra["areFeesSponsored"].(bool); v {
		t.Errorf("classic areFeesSponsored must be false")
	}
	splits, ok := classic.Extra["splitPayments"].([]map[string]interface{})
	if !ok || len(splits) != 2 {
		t.Errorf("classic entry must carry 2 splitPayments; got %v", classic.Extra["splitPayments"])
	}
}

func TestIdempotencyAndDigestHelpers(t *testing.T) {
	if idempotencyKey("abc") != "idem:settle:abc" {
		t.Errorf("idempotencyKey format wrong: %s", idempotencyKey("abc"))
	}
	a := bodyDigest([]byte(`{"x":1}`))
	b := bodyDigest([]byte(`{"x":1}`))
	c := bodyDigest([]byte(`{"x":2}`))
	if a != b {
		t.Errorf("bodyDigest must be deterministic")
	}
	if a == c {
		t.Errorf("different bodies must produce different digests")
	}
	if len(a) != 64 {
		t.Errorf("sha256 hex digest must be 64 chars; got %d", len(a))
	}
}

// stubFacilitator returns a *Facilitator configured in stub mode for tests.
// ALLOW_STUB_MODE must be set before calling.
func stubFacilitator(t *testing.T) *Facilitator {
	t.Helper()
	t.Setenv("FACILITATOR_MODE", "stub")
	t.Setenv("ALLOW_STUB_MODE", "true")
	return newFacilitator()
}

// trustedFacilitatorRequest builds a facilitatorRequest carrying a trusted (Verivyx-style)
// PaymentRequirement so that resolveRequirement passes it through without a domain lookup.
// This lets handler tests focus on the gate logic without a live auth-service.
func trustedFacilitatorRequest() facilitatorRequest {
	trustedReq := PaymentRequirement{
		Scheme:  SchemeExact,
		Network: NetworkTestnet,
		Asset:   "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		Amount:  "50000",
		PayTo:   "GABCDEF1234567890DEMO",
		Extra: map[string]interface{}{
			// splitPayments marks this as a trusted (non-generic) requirement so
			// resolveRequirement returns it unmodified without a domain lookup.
			"splitPayments": []interface{}{},
		},
	}
	payload := PaymentPayload{
		X402Version: X402Version,
		Scheme:      SchemeExact,
		Network:     NetworkTestnet,
		Accepted:    trustedReq,
		Payload: map[string]interface{}{
			"transaction": "TESTHASH",
			"payer":       "GPAYER",
		},
	}
	return facilitatorRequest{
		X402Version:         X402Version,
		PaymentPayload:      payload,
		PaymentRequirements: trustedReq,
	}
}

// TestPublicVerifyRequiresInternalToken asserts that POST /api/v1/payment/verify
// returns 401 when no X-Internal-Token header is sent.
func TestPublicVerifyRequiresInternalToken(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	internalToken = "test-secret-token"
	t.Cleanup(func() { internalToken = "" })
	f := stubFacilitator(t)
	r := setupRouter(f)

	body, _ := json.Marshal(trustedFacilitatorRequest())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/verify", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No X-Internal-Token header — should be rejected.
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("verify without token: got %d, want %d (unauthorized)", w.Code, http.StatusUnauthorized)
	}
}

// TestPublicVerifyAllowedWithInternalToken asserts that POST /api/v1/payment/verify
// accepts the request when the correct X-Internal-Token header is present.
func TestPublicVerifyAllowedWithInternalToken(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	const testToken = "test-secret-token"
	internalToken = testToken
	t.Cleanup(func() { internalToken = "" })
	f := stubFacilitator(t)
	r := setupRouter(f)

	body, _ := json.Marshal(trustedFacilitatorRequest())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/verify", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", testToken)
	r.ServeHTTP(w, req)

	if w.Code == http.StatusUnauthorized {
		t.Errorf("verify with valid token: got 401, want non-401")
	}
}

// TestPublicSettleRequiresInternalToken asserts that POST /api/v1/payment/settle
// returns 401 when no X-Internal-Token header is sent.
func TestPublicSettleRequiresInternalToken(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	internalToken = "test-secret-token"
	t.Cleanup(func() { internalToken = "" })
	f := stubFacilitator(t)
	r := setupRouter(f)

	body, _ := json.Marshal(trustedFacilitatorRequest())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// No X-Internal-Token header — should be rejected.
	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("settle without token: got %d, want %d (unauthorized)", w.Code, http.StatusUnauthorized)
	}
}

// TestPublicSettleAllowedWithInternalToken asserts that POST /api/v1/payment/settle
// accepts the request when the correct X-Internal-Token header is present.
func TestPublicSettleAllowedWithInternalToken(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	const testToken = "test-secret-token"
	internalToken = testToken
	t.Cleanup(func() { internalToken = "" })
	f := stubFacilitator(t)
	r := setupRouter(f)

	body, _ := json.Marshal(trustedFacilitatorRequest())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", testToken)
	r.ServeHTTP(w, req)

	if w.Code == http.StatusUnauthorized {
		t.Errorf("settle with valid token: got 401, want non-401")
	}
}

// TestPublicSettleRejectsInvalidPayment asserts that POST /api/v1/payment/settle
// returns 402 when the facilitator's Verify call reports IsValid=false, and that
// Settle is NOT reached (no settlement response in the body).
func TestPublicSettleRejectsInvalidPayment(t *testing.T) {
	t.Setenv("USDC_CONTRACT_ID", "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA")
	t.Setenv("STELLAR_NETWORK", "testnet")
	t.Setenv("API_PUBLIC_URL", "https://api.verivyx.com")

	const testToken = "test-secret-token"
	internalToken = testToken
	t.Cleanup(func() { internalToken = "" })

	f := stubFacilitator(t)
	f.stubForceInvalid = true // force Verify to return IsValid=false
	r := setupRouter(f)

	body, _ := json.Marshal(trustedFacilitatorRequest())
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/payment/settle", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", testToken)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("invalid payment: got %d, want %d (payment required)", w.Code, http.StatusPaymentRequired)
	}
	// Settle must NOT have been reached — no "success" or "transaction" key in body.
	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("could not decode response body: %v", err)
	}
	if _, ok := resp["success"]; ok {
		t.Error("settle body must not contain 'success' key — Settle should not have been called")
	}
	if _, ok := resp["transaction"]; ok {
		t.Error("settle body must not contain 'transaction' key — Settle should not have been called")
	}
}
