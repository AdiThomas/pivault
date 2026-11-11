"""Runtime settings. Every value can be set with a PIVAULT_* environment variable."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_SECRET = "change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PIVAULT_", env_file=".env", extra="ignore")

    env: str = "dev"  # dev | prod | test
    database_url: str = "postgresql+asyncpg://pivault:pivault@localhost:5432/pivault"
    redis_url: str = "redis://localhost:6379/0"
    storage_root: Path = Path("./data")

    secret_key: str = INSECURE_SECRET
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    # A just-rotated refresh token is still accepted for this long. It covers a phone
    # that lost the response to its refresh request (app killed, network dropped).
    refresh_reuse_grace_s: int = 120

    # The first account is created from these on startup when no user exists yet.
    admin_email: str | None = None
    admin_password: str | None = None

    max_upload_bytes: int = 10 * 1024**3
    trash_days: int = 30

    # Run media jobs inside the API process instead of queueing them (tests, tiny setups).
    jobs_inline: bool = False
    # Create tables on startup instead of relying on Alembic (tests only).
    auto_create_tables: bool = False

    # Comma-separated origins allowed to call the API from a browser. "*" allows any.
    cors_origins: str = ""

    login_rate_limit: int = 5
    login_rate_window_s: int = 60

    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def validate_for_runtime(self) -> None:
        if self.env == "prod" and (self.secret_key == INSECURE_SECRET or len(self.secret_key) < 32):
            raise RuntimeError(
                "PIVAULT_SECRET_KEY must be set to a random value of at least 32 characters "
                "in production (generate one with: openssl rand -hex 32)"
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
