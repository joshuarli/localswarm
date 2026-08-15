.PHONY: check fmt fmt-check ensure-omlx run benchmark stop

OMLX_MODEL_ID ?= Laguna-XS-2.1-5bit
OMLX_MODEL_REPO ?= mlx-community/Laguna-XS-2.1-5bit
OMLX_BASE_DIR ?= $(HOME)/.omlx
OMLX_MODEL_DIR ?= $(OMLX_BASE_DIR)/models
OMLX_HOST ?= 127.0.0.1
OMLX_PORT ?= 8000
OMLX_BASE_URL ?= http://$(OMLX_HOST):$(OMLX_PORT)/v1
OMLX_MAX_CONCURRENT_REQUESTS ?= 16
OMLX_MEMORY_GUARD ?= aggressive
OMLX_START_TIMEOUT_SECONDS ?= 300
OMLX_RUNTIME_DIR ?= $(OMLX_BASE_DIR)/localswarm

export OMLX_MODEL_ID OMLX_MODEL_REPO OMLX_BASE_DIR OMLX_MODEL_DIR
export OMLX_BASE_URL OMLX_HOST OMLX_PORT OMLX_MAX_CONCURRENT_REQUESTS OMLX_MEMORY_GUARD
export OMLX_START_TIMEOUT_SECONDS OMLX_RUNTIME_DIR

check:
	cargo check

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

ensure-omlx:
	sh scripts/omlx.sh ensure

run: ensure-omlx
	cargo run --release -- --mode poc --base-url "$(OMLX_BASE_URL)"

benchmark: ensure-omlx
	cargo run --release -- --mode benchmark --base-url "$(OMLX_BASE_URL)"

stop:
	sh scripts/omlx.sh stop
