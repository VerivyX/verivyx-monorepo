package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// ----------------- env helpers -----------------

// xPaymentSettleResult is the response from the gateway internal x-payment-settle endpoint.
// Mirrors SettlementResponse from x402-gateway so we can forward it as PAYMENT-RESPONSE header.
type xPaymentSettleResult struct {
	Success     bool   `json:"success"`
	Transaction string `json:"transaction"`
	Network     string `json:"network,omitempty"`
	Payer       string `json:"payer,omitempty"`
	Amount      string `json:"amount,omitempty"`
	ErrorReason string `json:"errorReason,omitempty"`
}

// processXPaymentHeader decodes the PAYMENT-SIGNATURE (or legacy X-PAYMENT) header
// and calls the gateway internal endpoint to verify + settle inline.
// Accepts both x402 v2 standard format (accepted.scheme/network) and our legacy
// format (scheme/network at top level) for backward compatibility.
func processXPaymentHeader(domain, slug, headerValue, agent, category string) (*xPaymentSettleResult, error) {
	// Decode base64 — try standard, then URL-safe, then raw URL-safe.
	var raw []byte
	var err error
	for _, enc := range []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.URLEncoding.DecodeString,
		base64.RawURLEncoding.DecodeString,
	} {
		raw, err = enc(headerValue)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, fmt.Errorf("invalid_base64")
	}

	// Parse payment payload — handle both x402 v2 standard format and legacy format.
	// Spec (v2): { x402Version, accepted: { scheme, network, asset, ... }, payload: { transaction } }
	// Legacy:    { x402Version, scheme, network, payload: { transaction, payer } }
	var xp struct {
		X402Version int `json:"x402Version"`
		// x402 v2 standard: scheme/network/asset inside "accepted"
		Accepted *struct {
			Scheme  string `json:"scheme"`
			Network string `json:"network"`
			Asset   string `json:"asset"` // used to match the correct requirement on the gateway
		} `json:"accepted"`
		// Legacy top-level fields
		Scheme  string `json:"scheme"`
		Network string `json:"network"`
		Payload struct {
			Transaction string `json:"transaction"`
			Payer       string `json:"payer"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &xp); err != nil {
		return nil, fmt.Errorf("invalid_json")
	}
	// Normalize: prefer "accepted" fields if present (spec), fall back to top-level (legacy)
	if xp.Accepted != nil {
		if xp.Accepted.Scheme != "" {
			xp.Scheme = xp.Accepted.Scheme
		}
		if xp.Accepted.Network != "" {
			xp.Network = xp.Accepted.Network
		}
	}

	body, _ := json.Marshal(map[string]interface{}{
		"domain":   domain,
		"slug":     slug,
		"agent":    agent,
		"category": category,
		"xPayment": xp,
	})
	req, _ := http.NewRequest("POST", gwURL()+"/api/v1/payment/internal/x-payment-settle", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", string(internalTok))

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result xPaymentSettleResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return &result, fmt.Errorf("%s", result.ErrorReason)
	}
	return &result, nil
}

// fetchPaymentRequirements fetches the x402 PaymentRequired body from the gateway
// and returns it as a raw map so it can be embedded directly in the 402 response.
func fetchPaymentRequirements(url string) map[string]interface{} {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		log.Printf("fetchPaymentRequirements: %v", err)
		return nil
	}
	defer resp.Body.Close()
	var body map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		log.Printf("fetchPaymentRequirements decode: %v", err)
		return nil
	}
	return body
}

// setPaymentRequiredHeader encodes the PaymentRequired body as base64 and sets
// both X-Payment-Required (x402 standard) and Payment-Required (backward compat).
func setPaymentRequiredHeader(c *gin.Context, body map[string]interface{}) {
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	encoded := base64.StdEncoding.EncodeToString(raw)
	c.Header("X-Payment-Required", encoded)
	c.Header("Payment-Required", encoded)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	internalTok []byte // INTERNAL_TOKEN as bytes
	sessionKey  []byte // SESSION_SECRET or JWT_SECRET+"_session"
)

// domainCache caches auth-service lookups to avoid a round-trip on every /hydrate request.
// TTL of 5 minutes — low enough to pick up creator config changes quickly.
const domainCacheTTL = 5 * time.Minute

type domainCacheEntry struct {
	cfg       *DomainConfig
	expiresAt time.Time
}

var (
	domainCacheMu sync.RWMutex
	domainCacheMap = make(map[string]domainCacheEntry)
)

// ----------------- types -----------------

type HydrateRequest struct {
	Domain string `json:"domain"`
	Slug   string `json:"slug"`
}

type DomainConfig struct {
	Domain          string  `json:"domain"`
	StellarAddress  string  `json:"stellar_address"`
	PricePerRequest float64 `json:"pricePerRequest"`
	PaywallEnabled  bool    `json:"paywallEnabled"`
}

type EventPayload struct {
	Domain     string  `json:"domain"`
	Type       string  `json:"type"`
	Agent      string  `json:"agent,omitempty"`
	Category   string  `json:"category,omitempty"`
	AmountUsdc float64 `json:"amountUsdc,omitempty"`
	SessionID  string  `json:"sessionId,omitempty"`
	IP         string  `json:"ip,omitempty"`
	Ja4        string  `json:"ja4,omitempty"`
}

// ----------------- session JWT verification -----------------

type humanClaims struct {
	Domain string `json:"domain"`
	IP     string `json:"ip"`
	UA     string `json:"ua"`
	jwt.RegisteredClaims
}

func verifyHumanSession(token string) (*humanClaims, error) {
	c := &humanClaims{}
	t, err := jwt.ParseWithClaims(token, c, func(*jwt.Token) (interface{}, error) {
		return sessionKey, nil
	}, jwt.WithAudience("human"))
	if err != nil || !t.Valid {
		return nil, err
	}
	return c, nil
}

// ----------------- HTTP clients -----------------

func authURL() string { return env("AUTH_SERVICE_URL", "http://auth-service:8083") }
func gwURL() string   { return env("GATEWAY_URL", "http://x402-gateway:8081") }

func lookupDomain(domain string) (*DomainConfig, error) {
	// Check cache first (read lock)
	domainCacheMu.RLock()
	if entry, ok := domainCacheMap[domain]; ok && time.Now().Before(entry.expiresAt) {
		domainCacheMu.RUnlock()
		return entry.cfg, nil
	}
	domainCacheMu.RUnlock()

	// Cache miss — fetch from auth-service
	req, _ := http.NewRequest("GET", authURL()+"/api/v1/auth/lookup?domain="+domain, nil)
	req.Header.Set("X-Internal-Token", string(internalTok))
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Do(req)
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

	// Store in cache (write lock)
	domainCacheMu.Lock()
	domainCacheMap[domain] = domainCacheEntry{cfg: &out, expiresAt: time.Now().Add(domainCacheTTL)}
	domainCacheMu.Unlock()

	return &out, nil
}

func gatewayPaid(domain, slug string) (bool, string) {
	req, _ := http.NewRequest("GET", gwURL()+"/api/v1/payment/internal/check?domain="+domain+"&slug="+slug, nil)
	req.Header.Set("X-Internal-Token", string(internalTok))
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, ""
	}
	var out struct {
		Paid        bool   `json:"paid"`
		Transaction string `json:"transaction"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, ""
	}
	return out.Paid, out.Transaction
}

func logEvent(p EventPayload) {
	body, _ := json.Marshal(p)
	reqCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, "POST", authURL()+"/api/v1/auth/events", bytes.NewReader(body))
	if err != nil {
		log.Printf("[warn] logEvent build error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", string(internalTok))
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

// ----------------- agent classifier (for unattributed bot events) -----------------

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

func clientIp(c *gin.Context) string {
	xf := c.GetHeader("X-Forwarded-For")
	if xf != "" {
		return strings.TrimSpace(strings.SplitN(xf, ",", 2)[0])
	}
	return c.ClientIP()
}

// ----------------- main -----------------

func mustEnvBytes(key string) []byte {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("[FATAL] %s env var is required — set it in .env", key)
	}
	return []byte(v)
}

func main() {
	internalTok = mustEnvBytes("INTERNAL_TOKEN")
	if s := os.Getenv("SESSION_SECRET"); s != "" {
		sessionKey = []byte(s)
	} else if j := os.Getenv("JWT_SECRET"); j != "" {
		sessionKey = []byte(j + "_session")
	} else {
		log.Fatal("[FATAL] SESSION_SECRET or JWT_SECRET env var is required — set it in .env")
	}

	if os.Getenv("GIN_MODE") == "" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	// CORS: /hydrate dipanggil dari browser creator (embed script di domain manapun).
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE, Idempotency-Key")
		c.Header("Access-Control-Expose-Headers", "X-Payment-Required, Payment-Required, X-Payment-Response, Payment-Response, X-Paywall-Quote")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})
	if err := r.SetTrustedProxies([]string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}); err != nil {
		log.Fatalf("set trusted proxies: %v", err)
	}

	r.GET("/api/v1/content/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	// /hydrate now requires either:
	//  - Authorization: Bearer <human session JWT>   (issued by /verify-human),  OR
	//  - The (domain, slug) pair has a paid gateway session (set by /payment/settle)
	// If neither, returns 402 + the spec PaymentRequired body via gateway redirect URL.
	r.POST("/api/v1/content/hydrate", func(c *gin.Context) {
		var req HydrateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_payload"})
			return
		}
		req.Domain = strings.TrimSpace(req.Domain)
		req.Slug = strings.TrimSpace(req.Slug)
		if req.Domain == "" || req.Slug == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "domain_and_slug_required"})
			return
		}

		ip := clientIp(c)
		ua := c.GetHeader("User-Agent")
		ja4 := c.GetHeader("X-JA4")
		if len(ja4) > 256 {
			ja4 = ja4[:256]
		}

		cfg, _ := lookupDomain(req.Domain)
		if cfg == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "domain_not_registered"})
			return
		}

		// Step 1: Toggle off → serve to anyone (passthrough)
		if !cfg.PaywallEnabled {
			agent, cat := classifyAgent(ua)
			go logEvent(EventPayload{
				Domain:    req.Domain,
				Type:      "bot_passthrough",
				Agent:     agent,
				Category:  cat,
				SessionID: req.Slug,
				IP:        ip,
				Ja4:       ja4,
			})
			c.JSON(http.StatusOK, gin.H{
				"status": "success",
				"served": "passthrough",
			})
			return
		}

		// Step 2: Human session JWT (domain-scoped)
		// Step 2.5: Standard X402 payment header.
		// Accept PAYMENT-SIGNATURE (x402 v2 spec) and X-PAYMENT (legacy/backward compat).
		// Agent retries the same URL with the header attached after building+signing TX.
		xPayment := c.GetHeader("PAYMENT-SIGNATURE")
		if xPayment == "" {
			xPayment = c.GetHeader("X-PAYMENT")
		}
		if xPayment != "" {
			agentName, agentCat := classifyAgent(ua)
			result, err := processXPaymentHeader(req.Domain, req.Slug, xPayment, agentName, agentCat)
			if err == nil && result.Success {
				go logEvent(EventPayload{
					Domain:    req.Domain,
					Type:      "agent_served",
					Agent:     agentName,
					Category:  agentCat,
					SessionID: req.Slug,
					IP:        ip,
					Ja4:       ja4,
				})
				// Standard X402: include PAYMENT-RESPONSE header with settlement details.
				if respJSON, jsonErr := json.Marshal(result); jsonErr == nil {
					c.Header("PAYMENT-RESPONSE", base64.StdEncoding.EncodeToString(respJSON))
				}
				c.JSON(http.StatusOK, gin.H{
					"status":      "success",
					"served":      "paid_agent",
					"transaction": result.Transaction,
				})
				return
			}
			// Payment invalid — return 402 with requirements + reason.
			reqURL := gwURL() + "/api/v1/payment/requirements?domain=" + req.Domain + "&slug=" + req.Slug
			c.Header("X-Paywall-Quote", reqURL)
			paymentBody := fetchPaymentRequirements(reqURL)
			errMsg := "invalid_payment"
			if err != nil {
				errMsg = err.Error()
			}
			if paymentBody != nil {
				paymentBody["error"] = errMsg
				setPaymentRequiredHeader(c, paymentBody)
				c.JSON(http.StatusPaymentRequired, paymentBody)
			} else {
				c.JSON(http.StatusPaymentRequired, gin.H{"error": errMsg})
			}
			return
		}

		auth := c.GetHeader("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token := strings.TrimPrefix(auth, "Bearer ")
			claims, err := verifyHumanSession(token)
			if err == nil && claims.Domain == req.Domain {
				go logEvent(EventPayload{
					Domain:    req.Domain,
					Type:      "human_served",
					SessionID: req.Slug,
					IP:        ip,
					Ja4:       ja4,
				})
				c.JSON(http.StatusOK, gin.H{
					"status": "success",
					"served": "human",
				})
				return
			}
		}

		// Step 3: Paid x402 session (set by gateway /settle)
		paid, txHash := gatewayPaid(req.Domain, req.Slug)
		if paid {
			go logEvent(EventPayload{
				Domain:    req.Domain,
				Type:      "agent_served",
				SessionID: req.Slug,
				IP:        ip,
				Ja4:       ja4,
			})
			c.JSON(http.StatusOK, gin.H{
				"status":      "success",
				"served":      "paid_agent",
				"transaction": txHash,
			})
			return
		}

		// Step 4: 402, log block
		agent, cat := classifyAgent(ua)
		go logEvent(EventPayload{
			Domain:    req.Domain,
			Type:      "bot_blocked",
			Agent:     agent,
			Category:  cat,
			SessionID: req.Slug,
			IP:        ip,
			Ja4:       ja4,
		})
		// Fetch payment requirements from gateway dan include inline di 402 body
		// agar response langsung X402-compliant tanpa agent perlu extra request.
		reqURL := gwURL() + "/api/v1/payment/requirements?domain=" + req.Domain + "&slug=" + req.Slug
		c.Header("X-Paywall-Quote", reqURL)
		paymentBody := fetchPaymentRequirements(reqURL)
		if paymentBody != nil {
			setPaymentRequiredHeader(c, paymentBody)
			c.JSON(http.StatusPaymentRequired, paymentBody)
		} else {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"error":   "payment_or_human_session_required",
				"message": reqURL,
				"agent":   agent,
			})
		}
	})

	log.Println("Hydration Service running on port 8082")
	r.Run(":8082")
}
