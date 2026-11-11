# PiVault API + worker. Builds for linux/arm64 (the Pi) and linux/amd64 (your PC).
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg: video poster frames and metadata. curl: container health check.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt constraints.txt ./
RUN pip install -r requirements.txt -c constraints.txt

# ---- test image: adds dev tools; used by CI and `docker compose run tests` ----
FROM base AS test
COPY requirements-dev.txt ./
RUN pip install -r requirements-dev.txt -c constraints.txt
COPY . .
CMD ["pytest"]

# ---- runtime image ----
FROM base AS runtime
# uid 1000 matches the first user on Raspberry Pi OS, which owns /mnt/storage/pivault.
# /data is created here so a fresh named volume inherits the right owner.
RUN useradd --uid 1000 --create-home pivault \
    && mkdir -p /data && chown pivault:pivault /data
COPY --chown=pivault:pivault . .
RUN chmod +x /app/entrypoint.sh
USER pivault
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["api"]
