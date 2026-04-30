# -----------------------------------------------------------------------------
# Accidia — top-level Makefile.
#
# Default target (`make`) produces a single-file release binary for the
# current host. Other targets cover development, testing and housekeeping.
#
# Everything here is best-effort tolerant: variables can be overridden on
# the command line (e.g. `make BUILD_TAGS=webkit2_41 WAILS=/tmp/wails build`),
# and missing tools produce actionable errors rather than obscure failures.
# -----------------------------------------------------------------------------

# ---- Tools / paths ----------------------------------------------------------

# Prefer the Wails CLI the user installed via `go install` into their GOBIN.
# Falls back to whatever `wails` is on PATH otherwise. Override with WAILS=...
GOBIN         ?= $(shell go env GOBIN 2>/dev/null)
ifeq ($(GOBIN),)
GOBIN         := $(HOME)/go/bin
endif
WAILS         ?= $(firstword $(wildcard $(GOBIN)/wails) $(shell command -v wails 2>/dev/null))
GO            ?= go
NPM           ?= npm

FRONTEND_DIR  := frontend
BUILD_BIN_DIR := build/bin

# On Arch + WebKitGTK 4.1 we need the webkit2_41 build tag (see AGENTS.md).
# Harmless on other platforms — Wails just ignores unknown tags that don't
# match any source file.
BUILD_TAGS    ?= webkit2_41
TAGS_FLAG     := -tags $(BUILD_TAGS)

# `make build PLATFORM=linux/arm64` → Wails cross-compiles.
PLATFORM      ?=
PLATFORM_FLAG := $(if $(PLATFORM),-platform $(PLATFORM),)

# `make build NSIS=1` → Windows NSIS installer
NSIS          ?=
NSIS_FLAG     := $(if $(NSIS),-nsis,)

# --- Helpers ----------------------------------------------------------------

# Helper that exits loudly if the Wails CLI isn't installed.
define require_wails
	@if [ -z "$(WAILS)" ] || ! command -v "$(WAILS)" >/dev/null 2>&1; then \
		echo "error: 'wails' CLI not found. Install with:"; \
		echo "  go install github.com/wailsapp/wails/v2/cmd/wails@latest"; \
		echo "Then make sure \$$GOBIN (or \$$HOME/go/bin) is on your PATH."; \
		exit 1; \
	fi
endef

# ANSI helpers so targets feel alive.
BLUE  := \033[1;34m
GREEN := \033[1;32m
DIM   := \033[2m
RESET := \033[0m

.DEFAULT_GOAL := build

# ---- Phony list -------------------------------------------------------------

.PHONY: help build build-debug dev \
        frontend frontend-install frontend-stub go-build go-tidy bindings \
        test test-integration test-verbose test-go test-frontend \
        lint vet fmt check \
        clean distclean nuke \
        install-tools doctor version

# ---- Primary targets --------------------------------------------------------

help:  ## Show this help message
	@printf "$(BLUE)Accidia — make targets$(RESET)\n"
	@printf "$(DIM)Override any variable on the command line, e.g. BUILD_TAGS=debug make build$(RESET)\n\n"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*## / { \
	  printf "  $(GREEN)%-22s$(RESET) %s\n", $$1, $$2 \
	}' $(MAKEFILE_LIST)
	@printf "\n$(DIM)Variables (current values shown):$(RESET)\n"
	@printf "  BUILD_TAGS = $(BUILD_TAGS)\n"
	@printf "  PLATFORM   = $(if $(PLATFORM),$(PLATFORM),<native>)\n"
	@printf "  WAILS      = $(if $(WAILS),$(WAILS),<not found>)\n"

build:  ## Production build — single-binary output in build/bin/
	$(call require_wails)
	@printf "$(BLUE)→ Wails production build$(RESET) (tags: $(BUILD_TAGS))\n"
	@$(WAILS) build $(TAGS_FLAG) $(PLATFORM_FLAG) $(NSIS_FLAG)
	@printf "$(GREEN)✓ Built$(RESET) $(BUILD_BIN_DIR)/\n"

build-debug:  ## Debug build with devtools enabled
	$(call require_wails)
	@printf "$(BLUE)→ Wails debug build$(RESET) (tags: $(BUILD_TAGS))\n"
	@$(WAILS) build $(TAGS_FLAG) -debug -devtools

dev:  ## Hot-reload development server (wails dev)
	$(call require_wails)
	@printf "$(BLUE)→ Wails dev server$(RESET) (tags: $(BUILD_TAGS))\n"
	@$(WAILS) dev $(TAGS_FLAG)

# ---- Individual layers ------------------------------------------------------

frontend: frontend-install  ## Build the frontend only (Vite + TypeScript)
	@printf "$(BLUE)→ Frontend build$(RESET)\n"
	@cd $(FRONTEND_DIR) && $(NPM) run build

frontend-install:  ## Install frontend dependencies if needed
	@if [ ! -d "$(FRONTEND_DIR)/node_modules" ]; then \
		printf "$(BLUE)→ Installing frontend dependencies$(RESET)\n"; \
		cd $(FRONTEND_DIR) && $(NPM) install; \
	fi

# main.go //go:embed's frontend/dist, so any `go` command (build, vet,
# generate, test) fails if that directory is absent. This stub creates
# an empty marker so `go` is happy when the user only wants to touch
# the Go side (e.g. `make vet` on a freshly-cloned checkout).
frontend-stub:
	@mkdir -p $(FRONTEND_DIR)/dist
	@touch $(FRONTEND_DIR)/dist/.gitkeep

go-build: frontend-stub  ## Compile the Go backend (no Wails packaging)
	@printf "$(BLUE)→ Go build$(RESET) (tags: $(BUILD_TAGS))\n"
	@$(GO) build $(TAGS_FLAG) ./...

go-tidy:  ## Tidy go.mod / go.sum
	@$(GO) mod tidy

bindings: frontend-stub  ## Regenerate frontend/wailsjs TypeScript bindings from Go
	$(call require_wails)
	@printf "$(BLUE)→ Regenerating Wails bindings$(RESET)\n"
	@$(WAILS) generate module $(TAGS_FLAG) >/dev/null

# ---- Tests ------------------------------------------------------------------

test: test-go  ## Alias: run all Go unit tests

test-go: frontend-stub  ## Run Go unit tests
	@printf "$(BLUE)→ Go tests$(RESET) (tags: $(BUILD_TAGS))\n"
	@$(GO) test $(TAGS_FLAG) -count=1 ./...

test-verbose: frontend-stub  ## Run Go tests with -v
	@$(GO) test $(TAGS_FLAG) -v -count=1 ./...

test-integration: frontend-stub  ## Run integration tests (needs ffmpeg on PATH)
	@printf "$(BLUE)→ Go integration tests$(RESET) (tags: $(BUILD_TAGS),integration)\n"
	@$(GO) test -tags "$(BUILD_TAGS),integration" -count=1 ./tests/...

test-frontend: frontend-install  ## Type-check the frontend
	@printf "$(BLUE)→ Frontend type-check$(RESET)\n"
	@cd $(FRONTEND_DIR) && npx tsc --noEmit

# ---- Static analysis --------------------------------------------------------

vet: frontend-stub  ## Run go vet on all packages
	@$(GO) vet $(TAGS_FLAG) ./...

fmt:  ## gofmt + goimports over the repo
	@gofmt -s -w .
	@command -v goimports >/dev/null 2>&1 && goimports -w . || true

lint: vet  ## Lint Go + frontend (best-effort if tools missing)
	@command -v staticcheck >/dev/null 2>&1 && staticcheck $(TAGS_FLAG) ./... || \
		printf "$(DIM)(staticcheck not installed; skipping)$(RESET)\n"

check: lint test test-frontend  ## Run all quality gates (lint + unit tests + TS typecheck)

# ---- Housekeeping -----------------------------------------------------------

clean:  ## Remove build artefacts (bin, dist, wailsjs)
	@rm -rf $(BUILD_BIN_DIR) $(FRONTEND_DIR)/dist $(FRONTEND_DIR)/wailsjs
	@printf "$(GREEN)✓ Cleaned$(RESET)\n"

distclean: clean  ## Clean + remove node_modules and Go build cache
	@rm -rf $(FRONTEND_DIR)/node_modules
	@$(GO) clean -cache >/dev/null 2>&1 || true
	@printf "$(GREEN)✓ Everything removed$(RESET)\n"

nuke: distclean  ## Alias for distclean

# ---- Environment ------------------------------------------------------------

install-tools:  ## Install the Go CLI tools this repo uses (wails, staticcheck)
	$(GO) install github.com/wailsapp/wails/v2/cmd/wails@latest
	$(GO) install honnef.co/go/tools/cmd/staticcheck@latest

doctor:  ## Verify that required tooling is present
	@printf "Go:          "; $(GO) version || exit 1
	@printf "Node:        "; node --version || (echo "not installed"; exit 1)
	@printf "npm:         "; $(NPM) --version || (echo "not installed"; exit 1)
	@printf "Wails:       "; $(WAILS) version 2>/dev/null || echo "not installed (make install-tools)"
	@printf "ffmpeg:      "; command -v ffmpeg >/dev/null && ffmpeg -version | head -1 || echo "not installed (optional at build time)"

version:  ## Print the version info Wails compiles into the binary
	@grep -R 'Version: *".*"' app.go || true
