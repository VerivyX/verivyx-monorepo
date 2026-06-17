package main

import "testing"

func TestBuildInternalContentURL(t *testing.T) {
	got := buildInternalContentURL("web-test.verivyx.com", "hello-world")
	want := "https://web-test.verivyx.com/wp-json/verivyx/v1/content?slug=hello-world"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	// slug is query-escaped
	got = buildInternalContentURL("demo.com", "a b/c")
	want = "https://demo.com/wp-json/verivyx/v1/content?slug=a+b%2Fc"
	if got != want {
		t.Errorf("escaped: got %q, want %q", got, want)
	}
}
