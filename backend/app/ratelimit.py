"""A small in-memory sliding-window limiter for login attempts.

The API runs as a single process on the Pi, so process memory is enough here.
"""

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, limit: int, window_s: int):
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str, now: float) -> deque[float]:
        hits = self._hits[key]
        while hits and now - hits[0] > self.window_s:
            hits.popleft()
        return hits

    def retry_after(self, key: str) -> int:
        """Seconds until another attempt is allowed, or 0 when allowed now."""
        now = time.monotonic()
        hits = self._prune(key, now)
        if len(hits) < self.limit:
            return 0
        return max(1, int(self.window_s - (now - hits[0])) + 1)

    def record(self, key: str) -> None:
        now = time.monotonic()
        self._prune(key, now).append(now)
        if len(self._hits) > 10_000:  # bound memory under a spray of unique keys
            for stale in [k for k, v in self._hits.items() if not v]:
                del self._hits[stale]

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)

    def clear(self) -> None:
        self._hits.clear()
