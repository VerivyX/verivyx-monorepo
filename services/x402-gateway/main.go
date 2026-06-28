package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

// ----------------------- constants & networks ------------------------

const (
	X402Version = 2
	SchemeExact = "exact"

	NetworkTestnet = "stellar:testnet"
	NetworkMainnet = "stellar:pubnet"

	USDCDecimals      = 7
	MaxTimeoutSeconds = 60

	SessionTTL = 1 * time.Hour
	// Replay window for /settle Idempotency-Key. 24h is more than enough to ride
	// out client retries; longer would let stale keys block legit settlements.
	IdempotencyTTL = 24 * time.Hour
	// ConsumedTTL is how long a payment proof is remembered as bound to a (domain,slug).
	// Long enough to outlast any retry window; keeps the cross-slug replay gate active.
	ConsumedTTL = 24 * time.Hour
)

var ctx = context.Background()
var rdb *redis.Client

// ----------------------- spec types ----------------------------------

type ResourceInfo struct {
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

type PaymentRequirement struct {
	Scheme string `json:"scheme"`
	Network string `json:"network"`
	// Amount is the canonical x402 v2 field name (per coinbase/x402
	// specs/x402-specification-v2.md). MaxAmountRequired carries the same value
	// under the x402 v1 field name so v1 clients (and the agent-sdk's tolerant
	// parser) interop too.
	Amount            string                 `json:"amount"`
	MaxAmountRequired string                 `json:"maxAmountRequired"`
	Asset             string                 `json:"asset"`
	PayTo             string                 `json:"payTo"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds"`
	// Per-entry resource/description/mimeType (x402 v2 puts these on each accepts
	// entry). Emitted additively; the top-level PaymentRequired.Resource stays too.
	Resource    string                 `json:"resource,omitempty"`
	Description string                 `json:"description,omitempty"`
	MimeType    string                 `json:"mimeType,omitempty"`
	Extra       map[string]interface{} `json:"extra,omitempty"`
}

type PaymentRequired struct {
	X402Version int                    `json:"x402Version"`
	Error       string                 `json:"error,omitempty"`
	Resource    ResourceInfo           `json:"resource"`
	Accepts     []PaymentRequirement   `json:"accepts"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
}

type PaymentPayload struct {
	X402Version int `json:"x402Version"`
	// Scheme/Network are advertised flat for generic x402 v2 clients that read
	// them at the top level. The Accepted wrapper is kept for the Verivyx relayer
	// and agent-sdk, which read scheme/network/asset from inside `accepted`.
	Scheme     string                 `json:"scheme,omitempty"`
	Network    string                 `json:"network,omitempty"`
	Resource   *ResourceInfo          `json:"resource,omitempty"`
	Accepted   PaymentRequirement     `json:"accepted"`
	Payload    map[string]interface{} `json:"payload"`
	Extensions map[string]interface{} `json:"extensions,omitempty"`
}

type VerifyResponse struct {
	IsValid       bool   `json:"isValid"`
	InvalidReason string `json:"invalidReason,omitempty"`
	Payer         string `json:"payer,omitempty"`
}

type SettlementResponse struct {
	Success     bool   `json:"success"`
	ErrorReason string `json:"errorReason,omitempty"`
	Transaction string `json:"transaction"`
	// DistributeTransaction is the on-chain split tx hash for the Soroban x402 path.
	// The relayer returns it after contract.distribute() runs; surfacing it here lets
	// API callers and the dashboard show proof of the on-chain creator/platform split.
	DistributeTransaction string                 `json:"distributeTransaction,omitempty"`
	Network               string                 `json:"network"`
	Payer                 string                 `json:"payer,omitempty"`
	Amount                string                 `json:"amount,omitempty"`
	Extensions            map[string]interface{} `json:"extensions,omitempty"`
}

// ----------------------- internal types ------------------------------

type DomainConfig struct {
	Domain          string  `json:"domain"`
	StellarAddress  string  `json:"stellar_address"`
	PricePerRequest float64 `json:"pricePerRequest"`
	PlatformFee     float64 `json:"platformFee"`
	PlatformAddress string  `json:"platform_address"`
	PaywallEnabled  bool    `json:"paywallEnabled"`
	// SiteId is the stable tenant identifier returned by the auth lookup. Sessions
	// and the consumed-proof binding key on it (falling back to Domain for older
	// data that predates the siteId backfill). Phase 1: re-key only; resolution
	// stays by-domain.
	SiteId string `json:"siteId"`
	// OnchainKey is the stable key used for the relayer's distribute()/register —
	// the domain for legacy sites (no contract re-registration) and the siteId for
	// new token-only sites. Falls back to Domain when empty.
	OnchainKey string `json:"onchainKey"`
}

// siteKeyFor returns the stable site identifier used to key Redis sessions and the
// consumed-proof binding. Prefers cfg.SiteId; falls back to the domain for older
// data (pre-backfill) so nothing 500s. The session/binding key SOURCE changes
// (domain → siteId); the C1 binding LOGIC is unchanged.
func siteKeyFor(cfg *DomainConfig, domain string) string {
	if cfg != nil && cfg.SiteId != "" {
		return cfg.SiteId
	}
	return domain
}

// onchainKeyFor returns the stable on-chain key for distribute()/register. Prefers
// cfg.OnchainKey; falls back to cfg.Domain so legacy domain-registered sites keep
// their existing on-chain key (no contract re-registration).
func onchainKeyFor(cfg *DomainConfig) string {
	if cfg == nil {
		return ""
	}
	if cfg.OnchainKey != "" {
		return cfg.OnchainKey
	}
	return cfg.Domain
}

// siteIdOf returns the stable tenant siteId from a config, or "" if unavailable.
// Used to tag analytics events so token-only sites (which may have no domain)
// are still attributed (Task 64).
func siteIdOf(cfg *DomainConfig) string {
	if cfg == nil {
		return ""
	}
	return cfg.SiteId
}

// ----------------------- helpers -------------------------------------

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("[FATAL] %s env var is required — set it in .env", key)
	}
	return v
}

var internalToken string

// apiPublicBase is the public API host (e.g. https://api.verivyx.com) advertised
// to X402 clients in the /requirements response. Required at startup.
var apiPublicBase string

// defaultTestnetUSDCIssuer is the canonical classic USDC issuer on Stellar
// testnet (well-known SDF test asset). Testnet is a sandbox, so this default
// keeps it zero-config; override with USDC_ISSUER. Mainnet has no default — the
// issuer must be set explicitly via USDC_ISSUER.
const defaultTestnetUSDCIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"

// networkAsset returns (network, asset) where asset is classic Stellar USDC in
// "CODE:ISSUER" format. This format is required for Operation.payment() in the
// agent-sdk. Soroban contract ID is kept in USDC_CONTRACT_ID for future use.
func networkAsset() (string, string) {
	if env("STELLAR_NETWORK", "testnet") == "mainnet" {
		// Mainnet moves real funds — never assume a default issuer.
		return NetworkMainnet, "USDC:" + mustEnv("USDC_ISSUER")
	}
	return NetworkTestnet, "USDC:" + env("USDC_ISSUER", defaultTestnetUSDCIssuer)
}

// requireSorobanUSDC returns the SEP-41 Soroban USDC contract ID from the
// USDC_CONTRACT_ID env var.  On mainnet the value must be set explicitly —
// a missing/blank ID is a fatal config error (real funds are at stake).  On
// testnet the variable is optional; returning "" causes buildRequirements to
// skip the Soroban entry, keeping local dev zero-config.
func requireSorobanUSDC() string {
	if env("STELLAR_NETWORK", "testnet") == "mainnet" {
		return mustEnv("USDC_CONTRACT_ID")
	}
	return env("USDC_CONTRACT_ID", "")
}

func classifyAgent(ua string) (string, string) {
	low := strings.ToLower(ua)
	switch {
	case strings.Contains(low, "gptbot") || strings.Contains(low, "openai") || strings.Contains(low, "oai-search"):
		return "OAI-SearchBot (OpenAI)", "Deep Research"
	case strings.Contains(low, "perplexity"):
		return "PerplexityBot", "RAG Search"
	case strings.Contains(low, "anthropic") || strings.Contains(low, "claudebot"):
		return "ClaudeBot (Anthropic)", "Deep Research"
	case strings.Contains(low, "googleother") || strings.Contains(low, "google-extended"):
		return "Google-Extended", "Training Scraper"
	case strings.Contains(low, "bytespider"):
		return "ByteSpider (TikTok)", "Training Scraper"
	case strings.Contains(low, "headless") || strings.Contains(low, "puppeteer") || strings.Contains(low, "playwright"):
		return "Unknown Headless Chrome", "Training Scraper"
	default:
		return "Unknown Agent", "Training Scraper"
	}
}

// usdcToAtomic converts a float USDC amount to an atomic-units string (7 decimal
// places = stroops). Uses math.Round so that binary-float imprecision is snapped
// to the nearest stroop rather than being truncated (e.g. 0.07*1e7 = 699999.9999…
// truncates to 699999 without Round). Output is always a plain integer string with
// no decimal point — the shape the x402 spec and the relayer expect for `amount`
// and `maxAmountRequired`.
func usdcToAtomic(usdc float64) string {
	if usdc <= 0 {
		return "0"
	}
	return strconv.FormatInt(int64(math.Round(usdc*1e7)), 10)
}

func lookupDomain(domain string) (*DomainConfig, error) {
	authURL := env("AUTH_SERVICE_URL", "http://auth-service:8083")
	req, _ := http.NewRequest("GET", authURL+"/api/v1/auth/lookup?domain="+domain, nil)
	req.Header.Set("X-Internal-Token", internalToken)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, nil
	}
	var out DomainConfig
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// lookupSiteByToken resolves a site config by its tenant token (Phase 2). Same
// HTTP shape as lookupDomain but hits the auth lookup with ?token=<token>. The
// auth service returns the full DomainConfig (incl. SiteId/OnchainKey). Returns
// nil,nil on 404 (token not found) so callers can fall back to domain.
func lookupSiteByToken(token string) (*DomainConfig, error) {
	authURL := env("AUTH_SERVICE_URL", "http://auth-service:8083")
	req, _ := http.NewRequest("GET", authURL+"/api/v1/auth/lookup?token="+url.QueryEscape(token), nil)
	req.Header.Set("X-Internal-Token", internalToken)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, nil
	}
	var out DomainConfig
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

type EventPayload struct {
	Domain                string  `json:"domain"`
	SiteId                string  `json:"siteId,omitempty"`
	Type                  string  `json:"type"`
	Agent                 string  `json:"agent,omitempty"`
	Category              string  `json:"category,omitempty"`
	AmountUsdc            float64 `json:"amountUsdc,omitempty"`
	SessionID             string  `json:"sessionId,omitempty"`
	TxHash                string  `json:"txHash,omitempty"`
	DistributeTransaction string  `json:"distributeTransaction,omitempty"`
	CreatorAmountUsdc     float64 `json:"creatorAmountUsdc,omitempty"`
	PlatformAmountUsdc    float64 `json:"platformAmountUsdc,omitempty"`
	Network               string  `json:"network,omitempty"`
	Asset                 string  `json:"asset,omitempty"`
	Payer                 string  `json:"payer,omitempty"`
	Status                string  `json:"status,omitempty"`
	IP                    string  `json:"ip,omitempty"`
}

// paymentSplit returns the (creatorShare, platformFee) in USDC for a domain.
// Mirrors buildRequirements: platform fee defaults to 0.001 and the creator
// receives price - fee. Used to record the actual split on each settled payment.
func paymentSplit(cfg *DomainConfig) (creator float64, fee float64) {
	if cfg == nil {
		return 0, 0
	}
	fee = cfg.PlatformFee
	if fee == 0 {
		fee = 0.001 // default platform fee — matches Prisma schema + buildRequirements
	}
	creator = cfg.PricePerRequest - fee
	if creator < 0 {
		creator = 0
	}
	return creator, fee
}

func logEvent(p EventPayload) {
	authSvc := env("AUTH_SERVICE_URL", "http://auth-service:8083")
	body, _ := json.Marshal(p)
	reqCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", authSvc+"/api/v1/auth/events", bytes.NewReader(body))
	if err != nil {
		log.Printf("[warn] logEvent build error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", internalToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[warn] logEvent failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("[warn] logEvent got HTTP %d", resp.StatusCode)
	}
}

// ----------------------- facilitator client --------------------------

// Facilitator is the upstream x402 facilitator (e.g. OpenZeppelin Channels
// "Built on Stellar" service, or self-hosted OpenZeppelin Relayer).
// In stub mode, /verify always passes and /settle returns a fake hash. This
// is ONLY for local dev — production must set FACILITATOR_MODE=proxy and a
// real FACILITATOR_URL.
type Facilitator struct {
	mode          string
	baseURL       string
	apiKey        string
	internalToken string
	client        *http.Client
	// stubForceInvalid is a test-only knob: when true, Verify returns IsValid=false
	// in stub mode so tests can exercise the 402 rejection path without a live facilitator.
	stubForceInvalid bool
}

func newFacilitator() *Facilitator {
	mode := os.Getenv("FACILITATOR_MODE")
	if mode == "" {
		mode = "proxy"
	}
	if mode != "stub" && mode != "proxy" {
		log.Fatalf("FACILITATOR_MODE must be 'proxy' or 'stub', got %q", mode)
	}
	baseURL := strings.TrimRight(os.Getenv("FACILITATOR_URL"), "/")
	if mode == "proxy" && baseURL == "" {
		log.Fatal("[FATAL] FACILITATOR_URL is required when FACILITATOR_MODE=proxy — set it in .env")
	}
	if mode == "stub" {
		if os.Getenv("ALLOW_STUB_MODE") != "true" {
			log.Fatal("[FATAL] FACILITATOR_MODE=stub requires ALLOW_STUB_MODE=true — never use stub in production")
		}
		log.Println("[WARNING] FACILITATOR_MODE=stub active — payments NOT verified on-chain. Local dev only.")
	}
	return &Facilitator{
		mode:          mode,
		baseURL:       baseURL,
		apiKey:        os.Getenv("FACILITATOR_API_KEY"),
		internalToken: os.Getenv("INTERNAL_TOKEN"),
		client:        &http.Client{Timeout: 60 * time.Second},
	}
}

// addAuth attaches the auth header for the configured facilitator.
//   - External facilitator (FACILITATOR_API_KEY set, e.g. OpenZeppelin Channels):
//     Authorization: Bearer <apiKey>.
//   - Internal payment-relayer (no API key): X-Internal-Token, the cross-service
//     auth required by every Verivyx internal endpoint. Never send the internal
//     token to an external facilitator — that would leak the shared secret.
func (f *Facilitator) addAuth(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if f.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+f.apiKey)
	} else if f.internalToken != "" {
		req.Header.Set("X-Internal-Token", f.internalToken)
	}
}

type facilitatorRequest struct {
	X402Version         int                `json:"x402Version"`
	PaymentPayload      PaymentPayload     `json:"paymentPayload"`
	PaymentRequirements PaymentRequirement `json:"paymentRequirements"`
}

func (f *Facilitator) Verify(payload PaymentPayload, req PaymentRequirement) (*VerifyResponse, error) {
	if f.mode == "stub" {
		if f.stubForceInvalid {
			return &VerifyResponse{IsValid: false, InvalidReason: "stub_forced_invalid"}, nil
		}
		return &VerifyResponse{IsValid: true, Payer: "STUB-PAYER"}, nil
	}
	if f.baseURL == "" {
		return nil, fmt.Errorf("FACILITATOR_URL is required in proxy mode")
	}
	body, _ := json.Marshal(facilitatorRequest{X402Version: X402Version, PaymentPayload: payload, PaymentRequirements: req})
	httpReq, _ := http.NewRequest("POST", f.baseURL+"/verify", bytes.NewReader(body))
	f.addAuth(httpReq)
	r, err := f.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	if r.StatusCode >= 500 {
		return nil, fmt.Errorf("facilitator /verify returned %d: %s", r.StatusCode, raw)
	}
	var out VerifyResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("facilitator /verify decode: %w", err)
	}
	return &out, nil
}

func (f *Facilitator) Settle(payload PaymentPayload, req PaymentRequirement) (*SettlementResponse, error) {
	if f.mode == "stub" {
		return &SettlementResponse{
			Success:     true,
			Transaction: fmt.Sprintf("STUB-%d", time.Now().UnixNano()),
			Network:     req.Network,
			Payer:       "STUB-PAYER",
			Amount:      req.Amount,
		}, nil
	}
	if f.baseURL == "" {
		return nil, fmt.Errorf("FACILITATOR_URL is required in proxy mode")
	}
	body, _ := json.Marshal(facilitatorRequest{X402Version: X402Version, PaymentPayload: payload, PaymentRequirements: req})
	httpReq, _ := http.NewRequest("POST", f.baseURL+"/settle", bytes.NewReader(body))
	f.addAuth(httpReq)
	r, err := f.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	if r.StatusCode >= 500 {
		return nil, fmt.Errorf("facilitator /settle returned %d: %s", r.StatusCode, raw)
	}
	var out SettlementResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("facilitator /settle decode: %w", err)
	}
	return &out, nil
}

func (f *Facilitator) Supported() (map[string]interface{}, error) {
	if f.mode == "stub" {
		network, _ := networkAsset()
		return map[string]interface{}{
			"kinds": []map[string]interface{}{
				{"x402Version": X402Version, "scheme": SchemeExact, "network": network},
			},
			"extensions": []string{},
			"signers":    map[string]interface{}{"stellar:*": []string{"STUB"}},
		}, nil
	}
	if f.baseURL == "" {
		return nil, fmt.Errorf("FACILITATOR_URL is required in proxy mode")
	}
	httpReq, _ := http.NewRequest("GET", f.baseURL+"/supported", nil)
	f.addAuth(httpReq)
	r, err := f.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ----------------------- requirements builder ------------------------

func buildRequirements(cfg *DomainConfig) []PaymentRequirement {
	if cfg == nil || !cfg.PaywallEnabled {
		return nil
	}
	network, classicAsset := networkAsset()
	total := cfg.PricePerRequest
	fee := cfg.PlatformFee
	if fee == 0 {
		fee = 0.001 // default platform fee — matches Prisma schema default
	}
	creatorShare := total - fee
	if creatorShare < 0 {
		creatorShare = 0
	}

	split := []map[string]interface{}{
		{"payTo": cfg.StellarAddress, "amount": usdcToAtomic(creatorShare), "role": "creator"},
		{"payTo": cfg.PlatformAddress, "amount": usdcToAtomic(fee), "role": "platform"},
	}

	reqs := []PaymentRequirement{}

	// Entry 1 — Soroban USDC (x402 v2 spec-compliant, fee sponsored by Verivyx).
	// Listed first so spec-compliant clients prefer it.
	// The agent sends a single spec-compliant USDC.transfer to the paywall CONTRACT
	// (payTo = contract). The facilitator then calls contract.distribute() to split
	// on-chain into creator + platform. No `splitPayments` here — a spec client does
	// ONE transfer; the split happens in the contract, not in the client TX.
	// Requires USDC_CONTRACT_ID (SEP-41 Soroban USDC) and SOROBAN_PAYWALL_CONTRACT_ID.
	sorobanUSDC := requireSorobanUSDC()
	paywallContract := env("SOROBAN_PAYWALL_CONTRACT_ID", "")
	if sorobanUSDC != "" && paywallContract != "" {
		reqs = append(reqs, PaymentRequirement{
			Scheme:            SchemeExact,
			Network:           network,
			Amount:            usdcToAtomic(total),
			MaxAmountRequired: usdcToAtomic(total),
			Asset:             sorobanUSDC,
			PayTo:             paywallContract, // agent transfers full amount to the contract
			MaxTimeoutSeconds: MaxTimeoutSeconds,
			Extra: map[string]interface{}{
				"areFeesSponsored": true, // Verivyx sponsors XLM fees; covered by platform fee
				// Informational only — the on-chain split the contract will perform.
				// Not "splitPayments" so the relayer doesn't expect 2 classic ops here.
				"distribution": split,
				// Settlement hints for the relayer's distribute() call. Use the
				// stable on-chain key (domain for legacy sites, siteId for new ones)
				// so register_by_keeper/distribute stay keyed consistently.
				"domain":          onchainKeyFor(cfg),
				"paywallContract": paywallContract,
			},
		})
	}

	// Entry 2 — Classic Stellar USDC (backward compat, Verivyx agent-sdk).
	// Client builds 2 classic payment ops directly to creator + platform and
	// covers their own XLM fees. The 2-op split IS the settlement here.
	reqs = append(reqs, PaymentRequirement{
		Scheme:            SchemeExact,
		Network:           network,
		Amount:            usdcToAtomic(total),
		MaxAmountRequired: usdcToAtomic(total),
		Asset:             classicAsset,
		PayTo:             cfg.StellarAddress,
		MaxTimeoutSeconds: MaxTimeoutSeconds,
		Extra: map[string]interface{}{
			"areFeesSponsored": false,
			"splitPayments":    split,
		},
	})

	return reqs
}

// withResource stamps the x402 v2 per-entry resource URL + mimeType onto each
// accepts entry, so generic v2 clients see resource/mimeType where the spec
// expects them. Mutates and returns the slice.
func withResource(reqs []PaymentRequirement, resource, mimeType string) []PaymentRequirement {
	for i := range reqs {
		reqs[i].Resource = resource
		reqs[i].MimeType = mimeType
	}
	return reqs
}

// isGenericRequirement reports whether a client-supplied PaymentRequirement lacks
// the Verivyx settlement extras the relayer needs to settle (Soroban paywallContract
// or classic splitPayments). Generic x402 v2 callers omit these; trusted Verivyx
// callers (agent-sdk, /x-payment-settle) include them. Detection is structural —
// never inferred from the User-Agent.
func isGenericRequirement(r PaymentRequirement) bool {
	if r.Extra == nil {
		return true
	}
	if _, ok := r.Extra["paywallContract"]; ok {
		return false
	}
	if _, ok := r.Extra["splitPayments"]; ok {
		return false
	}
	return true
}

// deriveResource extracts (domain, slug) from an inbound payment, in priority order:
// the payload resource URL, the per-entry requirement resource URL (Scope A), then
// the X-Paywall-Domain / X-Paywall-Slug headers (which override). Returns empty
// strings when no source yields a host.
func deriveResource(payload PaymentPayload, clientReq PaymentRequirement, hdrDomain, hdrSlug string) (string, string) {
	domain, slug := "", ""
	urls := []string{}
	if payload.Resource != nil {
		urls = append(urls, payload.Resource.URL)
	}
	urls = append(urls, clientReq.Resource)
	for _, u := range urls {
		if u == "" {
			continue
		}
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "http://")
		parts := strings.SplitN(u, "/", 2)
		if parts[0] != "" {
			domain = parts[0]
			if len(parts) == 2 {
				slug = strings.TrimSuffix(parts[1], "/")
			}
			break
		}
	}
	if hdrDomain != "" {
		domain = hdrDomain
	}
	if hdrSlug != "" {
		slug = hdrSlug
	}
	return domain, slug
}

// pickRequirement selects a requirement by asset. An exact asset match always wins.
// With no asset hint, preferSoroban=true selects the first contract-id (Soroban)
// entry, preferSoroban=false selects the first classic entry (asset contains ':').
// Falls back to the last entry when neither preference matches, mirroring the prior
// /x-payment-settle default. Returns ok=false only for an empty slice.
func pickRequirement(reqs []PaymentRequirement, asset string, preferSoroban bool) (PaymentRequirement, bool) {
	if len(reqs) == 0 {
		return PaymentRequirement{}, false
	}
	if asset != "" {
		for _, r := range reqs {
			if r.Asset == asset {
				return r, true
			}
		}
	}
	for _, r := range reqs {
		isClassic := strings.Contains(r.Asset, ":")
		if preferSoroban && !isClassic {
			return r, true
		}
		if !preferSoroban && isClassic {
			return r, true
		}
	}
	return reqs[len(reqs)-1], true
}

// Sentinel errors for resolveRequirement, mapped to HTTP status by httpStatusForResolveErr.
var (
	errDomainRequired        = fmt.Errorf("domain_required")
	errDomainNotRegistered   = fmt.Errorf("domain_not_registered")
	errNoMatchingRequirement = fmt.Errorf("no_matching_requirement")
)

// lookupDomainFn is the domain-config lookup, indirected through a package var so
// tests can inject a stub without a live auth-service.
var lookupDomainFn = lookupDomain

// lookupTokenFn is the token-config lookup, indirected through a package var so
// tests can inject a stub without a live auth-service. Mirrors lookupDomainFn.
var lookupTokenFn = lookupSiteByToken

// resolveSite resolves a site config by token (primary) with domain as the legacy
// fallback. If token is non-empty and yields a config, that config is used. When
// the token lookup yields nil (not found) — or no token was supplied — it falls
// back to the domain lookup. Returns nil,nil when neither source resolves a site.
// Backward-compatible: domain-only callers behave exactly as before.
func resolveSite(token, domain string) (*DomainConfig, error) {
	if token != "" {
		cfg, err := lookupTokenFn(token)
		if err != nil {
			return nil, err
		}
		if cfg != nil {
			return cfg, nil
		}
	}
	if domain != "" {
		return lookupDomainFn(domain)
	}
	return nil, nil
}

// resolveRequirement returns the canonical PaymentRequirement to forward to the
// facilitator, plus the derived domain/slug. Trusted callers (requirements carrying
// Verivyx settlement extras) pass through unchanged. Generic x402 v2 callers are
// reconstructed server-side from the domain config so the relayer can validate the
// Soroban transfer and run distribute(). Generic callers are steered to the Soroban
// requirement (preferSoroban=true).
func resolveRequirement(payload PaymentPayload, clientReq PaymentRequirement, hdrDomain, hdrSlug string) (PaymentRequirement, string, string, error) {
	domain, slug := deriveResource(payload, clientReq, hdrDomain, hdrSlug)
	if !isGenericRequirement(clientReq) {
		return clientReq, domain, slug, nil
	}
	if domain == "" {
		return PaymentRequirement{}, "", "", errDomainRequired
	}
	cfg, err := lookupDomainFn(domain)
	if err != nil || cfg == nil {
		return PaymentRequirement{}, domain, slug, errDomainNotRegistered
	}
	asset := clientReq.Asset
	if asset == "" {
		asset = payload.Accepted.Asset
	}
	req, ok := pickRequirement(buildRequirements(cfg), asset, true)
	if !ok {
		return PaymentRequirement{}, domain, slug, errNoMatchingRequirement
	}
	return req, domain, slug, nil
}

// httpStatusForResolveErr maps resolveRequirement sentinel errors to HTTP status codes.
func httpStatusForResolveErr(err error) int {
	switch err {
	case errDomainRequired:
		return http.StatusBadRequest
	case errDomainNotRegistered:
		return http.StatusNotFound
	case errNoMatchingRequirement:
		return http.StatusUnprocessableEntity
	default:
		return http.StatusBadGateway
	}
}

// sessionKey scopes a paid session to (domain, slug, payer). Keying on the payer
// is what stops a single payment from unlocking the resource for every other
// (anonymous) caller during the TTL — each account only ever sees its own session.
func sessionKey(domain, slug, payer string) string {
	return fmt.Sprintf("paid:%s:%s:%s", domain, slug, payer)
}

func idempotencyKey(key string) string {
	return "idem:settle:" + key
}

// proofHash returns the SHA-256 hex digest of an XDR/transaction string.
// Used as the Redis key for the consumed-proof binding that stops cross-slug replay.
func proofHash(xdr string) string {
	sum := sha256.Sum256([]byte(xdr))
	return hex.EncodeToString(sum[:])
}

// bindingDecision reports whether a proof may be used for the requested resource.
// Returns "reuse" when the proof was already consumed for a DIFFERENT resource, "ok" otherwise.
func bindingDecision(consumedVal, want string) string {
	if consumedVal != "" && consumedVal != want {
		return "reuse"
	}
	return "ok"
}

// idemRecord is what we cache against an Idempotency-Key.
// Storing the body digest lets us reject a key reuse with a different body
// (RFC draft "Idempotency-Key" §2.4) instead of silently returning the wrong tx.
type idemRecord struct {
	BodyDigest string             `json:"bodyDigest"`
	Status     int                `json:"status"`
	Body       SettlementResponse `json:"body"`
}

func bodyDigest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ----------------------- gin handlers --------------------------------

// setupRouter wires all HTTP routes onto a new gin.Engine and returns it.
// Extracted from main so tests can build the router without starting a server.
func setupRouter(facilitator *Facilitator) *gin.Engine {
	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	// CORS: gateway endpoints dipanggil langsung dari browser creator (embed script).
	// Semua origin diizinkan karena creator bisa pasang script di domain apapun.
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, X-Payment, PAYMENT-SIGNATURE, Idempotency-Key")
		c.Header("Access-Control-Expose-Headers", "X-Payment-Required, Payment-Required, X-Payment-Response, Payment-Response")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})
	// Trust only RFC1918 ranges (docker bridge + private LAN) for X-Forwarded-* headers.
	if err := r.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}); err != nil {
		log.Fatalf("set trusted proxies: %v", err)
	}

	r.GET("/api/v1/payment/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "facilitator_mode": facilitator.mode})
	})

	r.GET("/api/v1/payment/requirements", func(c *gin.Context) {
		domain := strings.TrimSpace(c.Query("domain"))
		slug := strings.TrimSpace(c.Query("slug"))
		token := strings.TrimSpace(c.Query("token"))
		// Token (primary) or domain (legacy) must identify the site.
		if token == "" && domain == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain required"})
			return
		}
		cfg, err := resolveSite(token, domain)
		if err != nil || cfg == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain_not_registered"})
			return
		}

		resourceURL := "https://" + cfg.Domain
		if slug != "" {
			resourceURL = resourceURL + "/" + slug
		}
		body := PaymentRequired{
			X402Version: X402Version,
			Error:       "X-PAYMENT header is required",
			Resource:    ResourceInfo{URL: resourceURL, MimeType: "text/html"},
			Accepts:     withResource(buildRequirements(cfg), resourceURL, "text/html"),
			Extensions: map[string]interface{}{
				// Advertise the hydrate endpoint so standard X402 clients know
				// to retry POST /hydrate with X-PAYMENT header attached.
				"facilitator": map[string]string{
					"url":     apiPublicBase + "/api/v1/content/hydrate",
					"scheme":  "x402-stellar",
					"version": "2",
				},
			},
		}

		raw, _ := json.Marshal(body)
		encoded := base64.StdEncoding.EncodeToString(raw)
		c.Header("X-Payment-Required", encoded)
		c.Header("PAYMENT-REQUIRED", encoded) // backward compat
		c.Header("Cache-Control", "no-store")

		if !cfg.PaywallEnabled {
			c.JSON(http.StatusOK, body)
			return
		}
		c.JSON(http.StatusPaymentRequired, body)
	})

	r.GET("/api/v1/payment/quote", func(c *gin.Context) {
		domain := strings.TrimSpace(c.Query("domain"))
		if domain == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain query required"})
			return
		}
		cfg, err := lookupDomain(domain)
		if err != nil || cfg == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain_not_registered"})
			return
		}
		network, asset := networkAsset()
		c.JSON(http.StatusOK, gin.H{
			"domain":          cfg.Domain,
			"pricePerRequest": cfg.PricePerRequest,
			"amountAtomic":    usdcToAtomic(cfg.PricePerRequest),
			"paywallEnabled":  cfg.PaywallEnabled,
			"asset":           asset,
			"network":         network,
			"destination":     cfg.StellarAddress,
		})
	})

	r.POST("/api/v1/payment/verify", func(c *gin.Context) {
		if c.GetHeader("X-Internal-Token") != internalToken {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		var req facilitatorRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_payload", "detail": err.Error()})
			return
		}
		if req.X402Version != X402Version || req.PaymentPayload.X402Version != X402Version {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":  "unsupported_version",
				"detail": fmt.Sprintf("expected x402Version=%d in both root and paymentPayload, got root=%d payload=%d", X402Version, req.X402Version, req.PaymentPayload.X402Version),
			})
			return
		}
		canonReq, _, _, rerr := resolveRequirement(req.PaymentPayload, req.PaymentRequirements, c.GetHeader("X-Paywall-Domain"), c.GetHeader("X-Paywall-Slug"))
		if rerr != nil {
			c.JSON(httpStatusForResolveErr(rerr), gin.H{"error": rerr.Error()})
			return
		}
		out, err := facilitator.Verify(req.PaymentPayload, canonReq)
		if err != nil {
			log.Printf("facilitator unreachable: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}
		c.JSON(http.StatusOK, out)
	})

	r.POST("/api/v1/payment/settle", func(c *gin.Context) {
		if c.GetHeader("X-Internal-Token") != internalToken {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		bodyBytes, err := io.ReadAll(io.LimitReader(c.Request.Body, 1<<20))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "body_read_failed"})
			return
		}
		var req facilitatorRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_payload", "detail": err.Error()})
			return
		}
		// Optional tenant token (Phase 2): identifies the site directly, so the
		// caller need not embed a domain in the resource URL. Domain stays as the
		// legacy fallback.
		var tok struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(bodyBytes, &tok)
		token := strings.TrimSpace(tok.Token)
		if req.X402Version != X402Version || req.PaymentPayload.X402Version != X402Version {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":  "unsupported_version",
				"detail": fmt.Sprintf("expected x402Version=%d in both root and paymentPayload, got root=%d payload=%d", X402Version, req.X402Version, req.PaymentPayload.X402Version),
			})
			return
		}

		// Idempotency: if the agent retries with the same key, replay the cached
		// response instead of re-submitting to the facilitator (and re-charging).
		idemHeader := strings.TrimSpace(c.GetHeader("Idempotency-Key"))
		if len(idemHeader) > 256 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "idempotency_key_too_long"})
			return
		}
		digest := bodyDigest(bodyBytes)
		var idemRedisKey string
		if idemHeader != "" {
			idemRedisKey = idempotencyKey(idemHeader)
			if cached, err := rdb.Get(ctx, idemRedisKey).Result(); err == nil {
				var rec idemRecord
				if json.Unmarshal([]byte(cached), &rec) == nil {
					if rec.BodyDigest != digest {
						c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "idempotency_key_reuse_with_different_body"})
						return
					}
					raw, _ := json.Marshal(rec.Body)
					c.Header("PAYMENT-RESPONSE", base64.StdEncoding.EncodeToString(raw))
					c.Header("Idempotent-Replayed", "true")
					c.JSON(rec.Status, rec.Body)
					return
				}
			} else if err != redis.Nil {
				log.Printf("idempotency get failed: %v", err)
			}
		}

		canonReq, domain, slug, rerr := resolveRequirement(req.PaymentPayload, req.PaymentRequirements, c.GetHeader("X-Paywall-Domain"), c.GetHeader("X-Paywall-Slug"))
		if rerr != nil {
			c.JSON(httpStatusForResolveErr(rerr), gin.H{"error": rerr.Error()})
			return
		}

		verifyOut, err := facilitator.Verify(req.PaymentPayload, canonReq)
		if err != nil {
			log.Printf("facilitator unreachable: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}
		if !verifyOut.IsValid {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"error":         "invalid_payment",
				"invalidReason": verifyOut.InvalidReason,
			})
			return
		}

		// Resolve payer — prefer the verify response; fall back to the signed payload.
		payer := verifyOut.Payer
		if payer == "" {
			if p, ok := req.PaymentPayload.Payload["payer"].(string); ok {
				payer = strings.TrimSpace(p)
			}
		}
		if payer == "" {
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "invalid_payment", "invalidReason": "payer_required"})
			return
		}

		// Extract the submitted transaction XDR for anti-replay proof hashing.
		txStr, _ := req.PaymentPayload.Payload["transaction"].(string)

		// Resolve the site config so sessions + the consumed binding key on siteId
		// (with a domain fallback for older data). Token is primary; domain is the
		// legacy fallback. When a token resolves a site, domain may be empty — the
		// siteKey comes from cfg.SiteId, so the session/binding logic still runs.
		var cfg *DomainConfig
		if token != "" || domain != "" {
			cfg, _ = resolveSite(token, domain)
		}
		siteKey := siteKeyFor(cfg, domain)

		if siteKey != "" {
			want := siteKey + ":" + slug

			// Session-first: if this (siteId,slug,payer) already has an active paid session,
			// return the cached settlement without re-settling.
			if tx, serr := rdb.Get(ctx, sessionKey(siteKey, slug, payer)).Result(); serr == nil && tx != "" {
				sessResp := &SettlementResponse{Success: true, Transaction: tx, Payer: payer}
				sessRaw, _ := json.Marshal(sessResp)
				c.Header("PAYMENT-RESPONSE", base64.StdEncoding.EncodeToString(sessRaw))
				c.JSON(http.StatusOK, sessResp)
				return
			}

			// Anti-replay binding: reject this proof if it was already consumed for a DIFFERENT resource.
			if txStr != "" {
				ph := proofHash(txStr)
				consumed, cerr := rdb.Get(ctx, "consumed:"+ph).Result()
				if cerr == redis.Nil {
					// fresh — no prior binding, proceed
				} else if cerr != nil {
					c.JSON(http.StatusServiceUnavailable, gin.H{"error": "replay_check_unavailable"})
					return
				} else if bindingDecision(consumed, want) == "reuse" {
					c.JSON(http.StatusPaymentRequired, gin.H{"error": "invalid_payment", "invalidReason": "payment_used_for_other_resource"})
					return
				}
			}
		}

		out, err := facilitator.Settle(req.PaymentPayload, canonReq)
		if err != nil {
			log.Printf("facilitator unreachable: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}

		if out.Success && siteKey != "" {
			key := sessionKey(siteKey, slug, out.Payer)
			// Only open a session when we know who paid; an identity-less session
			// would be a shared key any caller could ride on.
			if out.Payer != "" {
				if err := rdb.Set(ctx, key, out.Transaction, SessionTTL).Err(); err != nil {
					log.Printf("redis set failed: %v", err)
				}
			}
			// Bind the proof to this (siteId,slug) so it cannot be replayed for a different resource.
			if txStr != "" {
				rdb.Set(ctx, "consumed:"+proofHash(txStr), siteKey+":"+slug, ConsumedTTL)
			}
			amt := 0.0
			if cfg != nil {
				amt = cfg.PricePerRequest
			}
			creatorAmt, platformAmt := paymentSplit(cfg)

			agentName, category := classifyAgent(c.GetHeader("User-Agent"))
			go logEvent(EventPayload{
				Domain:                domain,
				SiteId:                siteIdOf(cfg),
				Type:                  "payment_verified",
				Agent:                 agentName,
				Category:              category,
				AmountUsdc:            amt,
				SessionID:             key,
				TxHash:                out.Transaction,
				DistributeTransaction: out.DistributeTransaction,
				CreatorAmountUsdc:     creatorAmt,
				PlatformAmountUsdc:    platformAmt,
				Network:               out.Network,
				Asset:                 canonReq.Asset,
				Payer:                 out.Payer,
				Status:                "confirmed",
			})
		}

		// Cache the response under the idempotency key — only if the caller
		// supplied one. Cache success and explicit failures alike so retries
		// don't double-charge or escape a known-bad transaction.
		if idemRedisKey != "" {
			rec := idemRecord{BodyDigest: digest, Status: http.StatusOK, Body: *out}
			if buf, err := json.Marshal(rec); err == nil {
				if err := rdb.Set(ctx, idemRedisKey, buf, IdempotencyTTL).Err(); err != nil {
					log.Printf("idempotency set failed: %v", err)
				}
			}
		}

		raw, _ := json.Marshal(out)
		c.Header("PAYMENT-RESPONSE", base64.StdEncoding.EncodeToString(raw))
		c.JSON(http.StatusOK, out)
	})

	r.GET("/api/v1/payment/supported", func(c *gin.Context) {
		out, err := facilitator.Supported()
		if err != nil {
			log.Printf("facilitator supported() failed: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}
		c.JSON(http.StatusOK, out)
	})

	// POST /api/v1/payment/internal/x-payment-settle
	// Called by hydration when an agent retries with X-PAYMENT header (standard X402 flow).
	// Verifies + settles the payment and sets the Redis paid session in one call.
	r.POST("/api/v1/payment/internal/x-payment-settle", func(c *gin.Context) {
		if c.GetHeader("X-Internal-Token") != internalToken {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		var body struct {
			Token    string `json:"token"`
			Domain   string `json:"domain"`
			Slug     string `json:"slug"`
			Agent    string `json:"agent,omitempty"`
			Category string `json:"category,omitempty"`
			XPayment struct {
				X402Version int    `json:"x402Version"`
				Scheme      string `json:"scheme"`
				Network     string `json:"network"`
				// x402 v2 spec: scheme/network/asset inside "accepted"
				Accepted *struct {
					Scheme  string `json:"scheme"`
					Network string `json:"network"`
					Asset   string `json:"asset"`
				} `json:"accepted"`
				Payload struct {
					Transaction string `json:"transaction"`
					Payer       string `json:"payer"`
				} `json:"payload"`
			} `json:"xPayment"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_payload"})
			return
		}
		if body.XPayment.X402Version != X402Version {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported_x402_version"})
			return
		}
		// Token (primary) or domain (legacy) must identify the site.
		if (body.Token == "" && body.Domain == "") || body.XPayment.Payload.Transaction == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain_and_transaction_required"})
			return
		}

		cfg, err := resolveSite(body.Token, body.Domain)
		if err != nil || cfg == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain_not_registered"})
			return
		}

		requirements := buildRequirements(cfg)
		if len(requirements) == 0 {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "no_requirements"})
			return
		}
		// Pick requirement that matches the asset the client used (x402 v2 spec puts
		// it in accepted.asset). No hint → classic, preserving legacy behavior.
		clientAsset := ""
		if body.XPayment.Accepted != nil {
			clientAsset = body.XPayment.Accepted.Asset
		}
		req, _ := pickRequirement(requirements, clientAsset, false)

		resourceURL := "https://" + cfg.Domain + "/" + body.Slug
		resource := ResourceInfo{URL: resourceURL, MimeType: "text/html"}
		payload := PaymentPayload{
			X402Version: X402Version,
			Scheme:      req.Scheme,
			Network:     req.Network,
			Resource:    &resource,
			Accepted:    req,
			Payload: map[string]interface{}{
				"transaction": body.XPayment.Payload.Transaction,
				"payer":       body.XPayment.Payload.Payer,
			},
		}

		verifyOut, err := facilitator.Verify(payload, req)
		if err != nil {
			log.Printf("facilitator unreachable: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}
		if !verifyOut.IsValid {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"error":         "invalid_payment",
				"invalidReason": verifyOut.InvalidReason,
			})
			return
		}

		// Resolve payer — prefer the verify response; fall back to the signed payload.
		payer := verifyOut.Payer
		if payer == "" {
			payer = body.XPayment.Payload.Payer
		}
		if payer == "" {
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "invalid_payment", "invalidReason": "payer_required"})
			return
		}

		// Sessions + the consumed binding key on siteId (domain fallback for older data).
		siteKey := siteKeyFor(cfg, body.Domain)
		want := siteKey + ":" + body.Slug

		// Session-first: if this (siteId,slug,payer) already has an active paid session,
		// return success immediately without calling Settle again.
		if tx, err := rdb.Get(ctx, sessionKey(siteKey, body.Slug, payer)).Result(); err == nil && tx != "" {
			c.JSON(http.StatusOK, gin.H{"success": true, "transaction": tx, "payer": payer})
			return
		}

		// Anti-replay binding: reject this proof if it was already consumed for a DIFFERENT resource.
		ph := proofHash(body.XPayment.Payload.Transaction)
		consumed, cerr := rdb.Get(ctx, "consumed:"+ph).Result()
		if cerr == redis.Nil {
			// fresh — no prior binding, proceed
		} else if cerr != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "replay_check_unavailable"})
			return
		} else if bindingDecision(consumed, want) == "reuse" {
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "invalid_payment", "invalidReason": "payment_used_for_other_resource"})
			return
		}

		settleOut, err := facilitator.Settle(payload, req)
		if err != nil {
			log.Printf("facilitator unreachable: %v", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable"})
			return
		}
		if settleOut.Success {
			// payer is guaranteed non-empty by the guard above; use settleOut.Payer if the
			// relayer enriches it (e.g. resolves a federated address), else keep ours.
			if settleOut.Payer != "" {
				payer = settleOut.Payer
			}
			key := sessionKey(siteKey, body.Slug, payer)
			if err := rdb.Set(ctx, key, settleOut.Transaction, SessionTTL).Err(); err != nil {
				log.Printf("redis set failed: %v", err)
			}
			// Bind the proof to this (siteId,slug) so it cannot be replayed for a different resource.
			rdb.Set(ctx, "consumed:"+ph, want, ConsumedTTL)
			agent, cat := body.Agent, body.Category
			if agent == "" {
				agent, cat = classifyAgent("")
			}
			creatorAmt, platformAmt := paymentSplit(cfg)
			go logEvent(EventPayload{
				Domain:                body.Domain,
				SiteId:                siteIdOf(cfg),
				Type:                  "payment_verified",
				Agent:                 agent,
				Category:              cat,
				AmountUsdc:            cfg.PricePerRequest,
				SessionID:             key,
				TxHash:                settleOut.Transaction,
				DistributeTransaction: settleOut.DistributeTransaction,
				CreatorAmountUsdc:     creatorAmt,
				PlatformAmountUsdc:    platformAmt,
				Network:               settleOut.Network,
				Asset:                 req.Asset,
				Payer:                 settleOut.Payer,
				Status:                "confirmed",
			})
		}
		c.JSON(http.StatusOK, settleOut)
	})

	r.GET("/api/v1/payment/internal/check", func(c *gin.Context) {
		if c.GetHeader("X-Internal-Token") != internalToken {
			c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}
		domain := c.Query("domain")
		slug := c.Query("slug")
		payer := c.Query("payer")
		if domain == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain required"})
			return
		}
		// Sessions are payer-scoped: without a payer there is nothing to check, and
		// we must never report a resource "paid" for an identity-less caller.
		if payer == "" {
			c.JSON(http.StatusOK, gin.H{"paid": false})
			return
		}
		// Resolve the site config so the lookup key matches what settle wrote
		// (siteId, with a domain fallback for older data).
		cfg, _ := lookupDomainFn(domain)
		siteKey := siteKeyFor(cfg, domain)
		v, err := rdb.Get(ctx, sessionKey(siteKey, slug, payer)).Result()
		if err == redis.Nil {
			c.JSON(http.StatusOK, gin.H{"paid": false})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"paid": true, "transaction": v})
	})

	return r
}

func main() {
	internalToken = mustEnv("INTERNAL_TOKEN")
	apiPublicBase = strings.TrimRight(mustEnv("API_PUBLIC_URL"), "/")
	// Mainnet guard — USDC_CONTRACT_ID must be set explicitly when running on
	// mainnet. The testnet convenience default must never silently be used where
	// real funds are at stake. requireSorobanUSDC calls mustEnv on mainnet, which
	// calls log.Fatalf if the var is missing/blank.
	if env("STELLAR_NETWORK", "testnet") == "mainnet" {
		mustEnv("USDC_CONTRACT_ID")
	}

	redisOpts := &redis.Options{Addr: env("REDIS_ADDR", "redis:6379")}
	if pw := os.Getenv("REDIS_PASSWORD"); pw != "" {
		redisOpts.Password = pw
	}
	rdb = redis.NewClient(redisOpts)
	facilitator := newFacilitator()

	r := setupRouter(facilitator)
	log.Printf("x402-gateway listening on :8081 (facilitator_mode=%s)", facilitator.mode)
	r.Run(":8081")
}
