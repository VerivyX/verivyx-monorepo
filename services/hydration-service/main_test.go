package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

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
