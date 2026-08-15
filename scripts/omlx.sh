#!/bin/sh
set -eu

MODEL_ID=${OMLX_MODEL_ID:-Laguna-XS-2.1-5bit}
MODEL_REPO=${OMLX_MODEL_REPO:-mlx-community/Laguna-XS-2.1-5bit}
BASE_DIR=${OMLX_BASE_DIR:-"${HOME}/.omlx"}
MODEL_DIR=${OMLX_MODEL_DIR:-"${BASE_DIR}/models"}
MODEL_PATH="${MODEL_DIR}/${MODEL_ID}"
HOST=${OMLX_HOST:-127.0.0.1}
PORT=${OMLX_PORT:-8000}
BASE_URL=${OMLX_BASE_URL:-"http://${HOST}:${PORT}/v1"}
MAX_CONCURRENT_REQUESTS=${OMLX_MAX_CONCURRENT_REQUESTS:-16}
MEMORY_GUARD=${OMLX_MEMORY_GUARD:-aggressive}
START_TIMEOUT_SECONDS=${OMLX_START_TIMEOUT_SECONDS:-300}
RUNTIME_DIR=${OMLX_RUNTIME_DIR:-"${BASE_DIR}/localswarm"}
PID_FILE="${RUNTIME_DIR}/omlx.pid"
LOG_FILE="${RUNTIME_DIR}/omlx.log"
CONFIG_FILE="${RUNTIME_DIR}/omlx.config"

die() {
    printf '%s\n' "omlx: $*" >&2
    exit 1
}

model_ready() {
    [ -f "${MODEL_PATH}/config.json" ] &&
        find "${MODEL_PATH}" -type f -name '*.safetensors' -print -quit 2>/dev/null |
        grep -q .
}

ensure_model() {
    if model_ready; then
        printf '%s\n' "omlx: using ${MODEL_PATH}"
        return
    fi

    command -v uvx >/dev/null 2>&1 ||
        die "uvx is required to download ${MODEL_REPO}"
    mkdir -p "${MODEL_PATH}"
    printf '%s\n' "omlx: downloading/resuming ${MODEL_REPO} into ${MODEL_PATH}"
    uvx --from huggingface-hub hf download "${MODEL_REPO}" \
        --local-dir "${MODEL_PATH}"
    model_ready || die "download completed without config.json and safetensors in ${MODEL_PATH}"
}

models_response() {
    curl --fail --silent --show-error --max-time 5 "${BASE_URL}/models"
}

server_has_model() {
    response=$(models_response 2>/dev/null) || return 1
    printf '%s' "${response}" | grep -F -q "\"${MODEL_ID}\""
}

desired_config() {
    printf '%s\n' \
        "model_dir=${MODEL_DIR}" \
        "host=${HOST}" \
        "port=${PORT}" \
        "max_concurrent_requests=${MAX_CONCURRENT_REQUESTS}" \
        "memory_guard=${MEMORY_GUARD}"
}

config_matches() {
    [ -f "${CONFIG_FILE}" ] || return 1
    [ "$(cat "${CONFIG_FILE}")" = "$(desired_config)" ]
}

managed_server_running() {
    [ -f "${PID_FILE}" ] || return 1
    pid=$(cat "${PID_FILE}")
    kill -0 "${pid}" 2>/dev/null || return 1
    command=$(ps -p "${pid}" -o command= 2>/dev/null || true)
    case "${command}" in
        *omlx-server*|*"omlx serve"*) return 0 ;;
        *) return 1 ;;
    esac
}

wait_for_server() {
    pid=$1
    deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        if server_has_model; then
            printf '%s\n' "omlx: serving ${MODEL_ID} at ${BASE_URL}"
            return
        fi
        if ! kill -0 "${pid}" 2>/dev/null; then
            printf '%s\n' "omlx: server exited during startup" >&2
            tail -80 "${LOG_FILE}" >&2 || true
            rm -f "${PID_FILE}"
            exit 1
        fi
        sleep 1
    done
    printf '%s\n' "omlx: timed out waiting for ${BASE_URL}/models" >&2
    tail -80 "${LOG_FILE}" >&2 || true
    exit 1
}

ensure_server() {
    if server_has_model; then
        if managed_server_running && ! config_matches; then
            printf '%s\n' "omlx: restarting localswarm-owned server to apply its configuration"
            stop_server
        else
            printf '%s\n' "omlx: reusing server at ${BASE_URL}"
            return
        fi
    fi

    if models_response >/dev/null 2>&1; then
        die "${BASE_URL}/models is already serving a different model"
    fi

    command -v omlx >/dev/null 2>&1 || die "oMLX is not installed"
    mkdir -p "${RUNTIME_DIR}"
    nohup omlx serve \
        --model-dir "${MODEL_DIR}" \
        --host "${HOST}" \
        --port "${PORT}" \
        --max-concurrent-requests "${MAX_CONCURRENT_REQUESTS}" \
        --memory-guard "${MEMORY_GUARD}" \
        >"${LOG_FILE}" 2>&1 < /dev/null &
    pid=$!
    printf '%s\n' "${pid}" > "${PID_FILE}"
    printf '%s\n' "omlx: started pid ${pid}; log ${LOG_FILE}"
    wait_for_server "${pid}"
    desired_config > "${CONFIG_FILE}"
}

stop_server() {
    if [ ! -f "${PID_FILE}" ]; then
        printf '%s\n' "omlx: no localswarm-owned server is recorded"
        rm -f "${CONFIG_FILE}"
        return
    fi
    pid=$(cat "${PID_FILE}")
    if managed_server_running; then
        kill "${pid}" 2>/dev/null || true
        deadline=$(( $(date +%s) + 15 ))
        while kill -0 "${pid}" 2>/dev/null && [ "$(date +%s)" -lt "${deadline}" ]; do
            sleep 1
        done
        if kill -0 "${pid}" 2>/dev/null; then
            kill -KILL "${pid}" 2>/dev/null || true
        fi
        printf '%s\n' "omlx: stopped pid ${pid}"
    else
        printf '%s\n' "omlx: removed stale or non-oMLX pid ${pid}"
    fi
    rm -f "${PID_FILE}" "${CONFIG_FILE}"
}

case "${1:-ensure}" in
    ensure)
        ensure_model
        ensure_server
        ;;
    stop)
        stop_server
        ;;
    *)
        die "usage: scripts/omlx.sh [ensure|stop]"
        ;;
esac
