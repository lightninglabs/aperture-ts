# Makefile for Go→WASM bridge
# Compiles aperture's L402/macaroon primitives to WebAssembly.

GOROOT := $(shell go env GOROOT)
WASM_EXEC := $(GOROOT)/lib/wasm/wasm_exec.js
OUT_DIR := dist
WASM_OUT := $(OUT_DIR)/aperture.wasm
WASM_EXEC_OUT := $(OUT_DIR)/wasm_exec.js

LDFLAGS := -s -w

.PHONY: all build clean copy-wasm-exec

all: build

build: $(WASM_OUT) copy-wasm-exec

$(WASM_OUT): bridge.go go.mod go.sum
	@mkdir -p $(OUT_DIR)
	GOOS=js GOARCH=wasm go build -ldflags="$(LDFLAGS)" -o $(WASM_OUT) .

copy-wasm-exec: $(WASM_EXEC_OUT)

$(WASM_EXEC_OUT): $(WASM_EXEC)
	@mkdir -p $(OUT_DIR)
	cp $(WASM_EXEC) $(WASM_EXEC_OUT)

clean:
	rm -rf $(OUT_DIR)
