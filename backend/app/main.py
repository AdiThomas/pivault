"""PiVault API."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from . import __version__, jobs, storage
from .config import get_settings
from .db import dispose_engine, get_sessionmaker, init_engine
from .metrics import MetricsMiddleware
from .models import Base, User
from .routers import assets, auth, devices, folders, system
from .security import hash_password

log = logging.getLogger("pivault")


async def ensure_admin() -> None:
    """Create the first account from PIVAULT_ADMIN_EMAIL / _PASSWORD when none exists."""
    settings = get_settings()
    if not settings.admin_email or not settings.admin_password:
        return
    async with get_sessionmaker()() as session:
        if await session.scalar(select(func.count()).select_from(User)):
            return
        session.add(
            User(
                email=settings.admin_email.strip().lower(),
                password_hash=hash_password(settings.admin_password),
            )
        )
        await session.commit()
        log.info("created admin account %s", settings.admin_email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.validate_for_runtime()
    engine = init_engine()
    storage.ensure_dirs()
    if settings.auto_create_tables:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    await ensure_admin()
    try:
        await jobs.init_queue()
    except Exception as exc:  # the API can still serve files while Redis is down
        log.warning("job queue unavailable at startup: %s", exc)
    yield
    await jobs.close_queue()
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="PiVault",
        version=__version__,
        description="Self-hosted photos, videos and files on a Raspberry Pi.",
        lifespan=lifespan,
        docs_url="/docs",
        openapi_url="/openapi.json",
    )
    app.add_middleware(MetricsMiddleware)
    origins = settings.cors_origin_list()
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
        )
    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(assets.router)
    app.include_router(folders.router)
    app.include_router(system.router)
    return app


app = create_app()
