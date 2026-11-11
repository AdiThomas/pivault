"""ARQ worker. Run with: arq app.worker.WorkerSettings"""

import logging
import uuid

from arq import cron
from arq.connections import RedisSettings

from . import jobs, storage
from .config import get_settings
from .db import dispose_engine, init_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def process_asset_job(ctx, asset_id: str, keep_taken_at: bool = True) -> str:
    return await jobs.process_asset(uuid.UUID(asset_id), keep_taken_at)


async def purge_trash_job(ctx) -> int:
    return await jobs.purge_trash()


async def requeue_stuck_job(ctx) -> int:
    return await jobs.requeue_stuck()


async def cleanup_tmp_job(ctx) -> int:
    return await jobs.cleanup_tmp()


async def startup(ctx) -> None:
    get_settings().validate_for_runtime()
    init_engine()
    storage.ensure_dirs()
    await jobs.init_queue()


async def shutdown(ctx) -> None:
    await jobs.close_queue()
    await dispose_engine()


class WorkerSettings:
    functions = [process_asset_job]
    cron_jobs = [
        cron(purge_trash_job, hour=4, minute=15),
        cron(requeue_stuck_job, minute={5, 20, 35, 50}),
        cron(cleanup_tmp_job, minute=40),
    ]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    on_startup = startup
    on_shutdown = shutdown
    # A Pi 5 has four cores; two concurrent ffmpeg/Pillow jobs leave room for the API.
    max_jobs = 2
    job_timeout = 900
    max_tries = 3
    keep_result = 60
