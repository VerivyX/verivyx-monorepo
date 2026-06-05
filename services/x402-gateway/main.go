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
	"math/big"
	"net/http"
	"os"
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
	Scheme            string                 `json:"scheme"`
	Network           string                 `json:"network"`
	Amount            string                 `json:"amount"`
	Asset             string                 `json:"asset"`
	PayTo             string                 `json:"payTo"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds"`
	Extra             map[string]interface{} `json:"extra,omitempty"`
}

type PaymentRequired struct {
	X402Version int                    `json:"x402Version"`
	Error       string                 `json:"error,omitempty"`
	Resource    ResourceInfo           `json:"resource"`
	Accepts     []PaymentRequirement   `json:"accepts"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
}

type PaymentPayload struct {
	X402Version int                    `json:"x402Version"`
	Resource    *ResourceInfo          `json:"resource,omitempty"`
	Accepted    PaymentRequirement     `json:"accepted"`
	Payload     map[string]interface{} `json:"payload"`
	Extensions  map[string]interface{} `json:"extensions,omitempty"`
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

// usdcToAtomic converts a float USDC amount to atomic-units string with 7 decimals.
// Uses big.Int for precision (no float rounding past 7 decimals).
func usdcToAtomic(usdc float64) string {
	if usdc <= 0 {
		return "0"
	}
	scaled := new(big.Float).Mul(big.NewFloat(usdc), big.NewFloat(1e7))
	z, _ := scaled.Int(nil)
	return z.String()
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

type EventPayload struct {
	Domain                string  `json:"domain"`
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
		client:        &http.Client{Timeout: 15 * time.Second},
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
	sorobanUSDC := env("USDC_CONTRACT_ID", "")
	paywallContract := env("SOROBAN_PAYWALL_CONTRACT_ID", "")
	if sorobanUSDC != "" && paywallContract != "" {
		reqs = append(reqs, PaymentRequirement{
			Scheme:            SchemeExact,
			Network:           network,
			Amount:            usdcToAtomic(total),
			Asset:             sorobanUSDC,
			PayTo:             paywallContract, // agent transfers full amount to the contract
			MaxTimeoutSeconds: MaxTimeoutSeconds,
			Extra: map[string]interface{}{
				"areFeesSponsored": true, // Verivyx sponsors XLM fees; covered by platform fee
				// Informational only — the on-chain split the contract will perform.
				// Not "splitPayments" so the relayer doesn't expect 2 classic ops here.
				"distribution": split,
				// Settlement hints for the relayer's distribute() call.
				"domain":          cfg.Domain,
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

func sessionKey(domain, slug string) string {
	return fmt.Sprintf("paid:%s:%s", domain, slug)
}

func idempotencyKey(key string) string {
	return "idem:settle:" + key
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

func main() {
	internalToken = mustEnv("INTERNAL_TOKEN")
	apiPublicBase = strings.TrimRight(mustEnv("API_PUBLIC_URL"), "/")

	redisOpts := &redis.Options{Addr: env("REDIS_ADDR", "redis:6379")}
	if pw := os.Getenv("REDIS_PASSWORD"); pw != "" {
		redisOpts.Password = pw
	}
	rdb = redis.NewClient(redisOpts)
	facilitator := newFacilitator()

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
		if domain == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain required"})
			return
		}
		cfg, err := lookupDomain(domain)
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
			Accepts:     buildRequirements(cfg),
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
		out, err := facilitator.Verify(req.PaymentPayload, req.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable", "details": err.Error()})
			return
		}
		c.JSON(http.StatusOK, out)
	})

	r.POST("/api/v1/payment/settle", func(c *gin.Context) {
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

		domain := ""
		slug := ""
		if req.PaymentPayload.Resource != nil {
			u := req.PaymentPayload.Resource.URL
			u = strings.TrimPrefix(u, "https://")
			u = strings.TrimPrefix(u, "http://")
			parts := strings.SplitN(u, "/", 2)
			if len(parts) >= 1 {
				domain = parts[0]
			}
			if len(parts) >= 2 {
				slug = strings.TrimSuffix(parts[1], "/")
			}
		}
		if h := c.GetHeader("X-Paywall-Domain"); h != "" {
			domain = h
		}
		if h := c.GetHeader("X-Paywall-Slug"); h != "" {
			slug = h
		}

		out, err := facilitator.Settle(req.PaymentPayload, req.PaymentRequirements)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable", "details": err.Error()})
			return
		}

		if out.Success && domain != "" {
			key := sessionKey(domain, slug)
			if err := rdb.Set(ctx, key, out.Transaction, SessionTTL).Err(); err != nil {
				log.Printf("redis set failed: %v", err)
			}
			cfg, _ := lookupDomain(domain)
			amt := 0.0
			if cfg != nil {
				amt = cfg.PricePerRequest
			}
			creatorAmt, platformAmt := paymentSplit(cfg)

			agentName, category := classifyAgent(c.GetHeader("User-Agent"))
			go logEvent(EventPayload{
				Domain:                domain,
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
				Asset:                 req.PaymentRequirements.Asset,
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
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
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
		if body.Domain == "" || body.XPayment.Payload.Transaction == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain_and_transaction_required"})
			return
		}

		cfg, err := lookupDomain(body.Domain)
		if err != nil || cfg == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain_not_registered"})
			return
		}

		requirements := buildRequirements(cfg)
		if len(requirements) == 0 {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "no_requirements"})
			return
		}
		// Pick requirement that matches the asset the client used.
		// Client includes accepted.asset in the payload (x402 v2 spec).
		// Fallback: classic USDC (asset with ':') for backward compat with legacy clients.
		req := requirements[len(requirements)-1] // default to last = classic
		clientAsset := ""
		if body.XPayment.Accepted != nil {
			clientAsset = body.XPayment.Accepted.Asset
		}
		for _, r := range requirements {
			if clientAsset != "" && r.Asset == clientAsset {
				req = r
				break
			}
			// No asset hint — prefer classic (contains ':')
			if clientAsset == "" && strings.Contains(r.Asset, ":") {
				req = r
				break
			}
		}

		resourceURL := "https://" + cfg.Domain + "/" + body.Slug
		resource := ResourceInfo{URL: resourceURL, MimeType: "text/html"}
		payload := PaymentPayload{
			X402Version: X402Version,
			Resource:    &resource,
			Accepted:    req,
			Payload: map[string]interface{}{
				"transaction": body.XPayment.Payload.Transaction,
				"payer":       body.XPayment.Payload.Payer,
			},
		}

		verifyOut, err := facilitator.Verify(payload, req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable", "details": err.Error()})
			return
		}
		if !verifyOut.IsValid {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"error":         "invalid_payment",
				"invalidReason": verifyOut.InvalidReason,
			})
			return
		}

		settleOut, err := facilitator.Settle(payload, req)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "facilitator_unreachable", "details": err.Error()})
			return
		}
		if settleOut.Success {
			key := sessionKey(body.Domain, body.Slug)
			if err := rdb.Set(ctx, key, settleOut.Transaction, SessionTTL).Err(); err != nil {
				log.Printf("redis set failed: %v", err)
			}
			agent, cat := body.Agent, body.Category
			if agent == "" {
				agent, cat = classifyAgent("")
			}
			creatorAmt, platformAmt := paymentSplit(cfg)
			go logEvent(EventPayload{
				Domain:                body.Domain,
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
		if domain == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain required"})
			return
		}
		v, err := rdb.Get(ctx, sessionKey(domain, slug)).Result()
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

	log.Printf("x402-gateway listening on :8081 (facilitator_mode=%s)", facilitator.mode)
	r.Run(":8081")
}
