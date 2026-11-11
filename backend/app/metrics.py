"""Prometheus metrics."""

import time

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

REGISTRY = CollectorRegistry()

HTTP_REQUESTS = Counter(
    "pivault_http_requests_total",
    "HTTP requests by method, route and status",
    ["method", "route", "status"],
    registry=REGISTRY,
)
HTTP_LATENCY = Histogram(
    "pivault_http_request_duration_seconds",
    "HTTP request latency by route",
    ["method", "route"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300),
    registry=REGISTRY,
)
UPLOADS = Counter(
    "pivault_uploads_total",
    "Uploads by kind and result (new or duplicate)",
    ["kind", "result"],
    registry=REGISTRY,
)
UPLOAD_BYTES = Counter(
    "pivault_upload_bytes_total", "Bytes received in new uploads", registry=REGISTRY
)
LOGIN_ATTEMPTS = Counter(
    "pivault_login_attempts_total", "Login attempts by result", ["result"], registry=REGISTRY
)

ASSETS = Gauge("pivault_assets", "Stored assets by kind", ["kind"], registry=REGISTRY)
ASSETS_BY_STATUS = Gauge(
    "pivault_assets_by_status", "Stored assets by processing status", ["status"], registry=REGISTRY
)
ASSETS_TRASHED = Gauge("pivault_assets_trashed", "Assets in the trash", registry=REGISTRY)
STORAGE_USED = Gauge(
    "pivault_storage_used_bytes", "Bytes of original files stored", registry=REGISTRY
)
DISK_TOTAL = Gauge("pivault_disk_total_bytes", "Size of the storage filesystem", registry=REGISTRY)
DISK_FREE = Gauge("pivault_disk_free_bytes", "Free space on the storage filesystem",
                  registry=REGISTRY)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            route = request.scope.get("route")
            # Use the route template, never the raw path, to keep label cardinality low.
            label = getattr(route, "path", None) or "unmatched"
            if label != "/metrics":
                HTTP_REQUESTS.labels(request.method, label, str(status)).inc()
                HTTP_LATENCY.labels(request.method, label).observe(time.perf_counter() - start)
