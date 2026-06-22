package main

import "testing"

func TestBuildInternalContentURL(t *testing.T) {
	got := buildInternalContentURL(&DomainConfig{Domain: "web-test.verivyx.com"}, "hello-world")
	want := "https://web-test.verivyx.com/wp-json/verivyx/v1/content?slug=hello-world"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	// slug is query-escaped
	got = buildInternalContentURL(&DomainConfig{Domain: "demo.com"}, "a b/c")
	want = "https://demo.com/wp-json/verivyx/v1/content?slug=a+b%2Fc"
	if got != want {
		t.Errorf("escaped: got %q, want %q", got, want)
	}
}

func TestBuildInternalContentURL_UsesContentUrl(t *testing.T) {
	cfg := &DomainConfig{Domain: "ex.com", ContentUrl: "https://ex.com/api/vx/content"}
	if got := buildInternalContentURL(cfg, "hello"); got != "https://ex.com/api/vx/content?slug=hello" {
		t.Fatalf("got %q", got)
	}
}

func TestBuildInternalContentURL_FallsBackToWP(t *testing.T) {
	cfg := &DomainConfig{Domain: "ex.com"}
	if got := buildInternalContentURL(cfg, "hello"); got != "https://ex.com/wp-json/verivyx/v1/content?slug=hello" {
		t.Fatalf("got %q", got)
	}
}
