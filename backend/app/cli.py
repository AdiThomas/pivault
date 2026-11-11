"""Admin commands. Run inside the api container, for example:

    docker compose exec api python -m app.cli create-user you@example.com
    docker compose exec api python -m app.cli set-password you@example.com
    docker compose exec api python -m app.cli reprocess --failed
    docker compose exec api python -m app.cli verify
"""

import argparse
import asyncio
import getpass
import hashlib
import sys

from sqlalchemy import select

from . import jobs, storage
from .db import dispose_engine, get_sessionmaker, init_engine
from .models import Asset, User
from .security import hash_password


def _read_password(args) -> str:
    if args.password:
        return args.password
    first = getpass.getpass("Password: ")
    if first != getpass.getpass("Again: "):
        sys.exit("Passwords do not match")
    if len(first) < 8:
        sys.exit("Use at least 8 characters")
    return first


async def create_user(args) -> None:
    email = args.email.strip().lower()
    async with get_sessionmaker()() as session:
        if await session.scalar(select(User).where(User.email == email)):
            sys.exit(f"{email} already exists")
        session.add(User(email=email, password_hash=hash_password(_read_password(args))))
        await session.commit()
    print(f"created {email}")


async def set_password(args) -> None:
    email = args.email.strip().lower()
    async with get_sessionmaker()() as session:
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            sys.exit(f"{email} not found")
        user.password_hash = hash_password(_read_password(args))
        await session.commit()
    print(f"password updated for {email}")


async def reprocess(args) -> None:
    """Queue thumbnail and metadata jobs again."""
    await jobs.init_queue()
    async with get_sessionmaker()() as session:
        stmt = select(Asset.id).where(Asset.kind.in_(("photo", "video")))
        if args.failed:
            stmt = stmt.where(Asset.status.in_(("failed", "processing")))
        ids = (await session.scalars(stmt)).all()
    for asset_id in ids:
        await jobs.enqueue_process(asset_id, keep_taken_at=True)
    await jobs.close_queue()
    print(f"queued {len(ids)} assets")


def _sha256(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def verify(args) -> None:
    """Check every stored file against the hash recorded at upload."""
    missing = corrupt = ok = 0
    async with get_sessionmaker()() as session:
        rows = (await session.execute(select(Asset.id, Asset.storage_path, Asset.sha256))).all()
    for asset_id, rel, expected in rows:
        path = storage.abs_path(rel)
        if not path.is_file():
            missing += 1
            print(f"MISSING {asset_id} {rel}")
        elif await asyncio.to_thread(_sha256, path) != expected:
            corrupt += 1
            print(f"CORRUPT {asset_id} {rel}")
        else:
            ok += 1
    print(f"ok={ok} missing={missing} corrupt={corrupt}")
    if missing or corrupt:
        sys.exit(1)


async def _main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, func in (("create-user", create_user), ("set-password", set_password)):
        cmd = sub.add_parser(name)
        cmd.add_argument("email")
        cmd.add_argument("--password", help="omit to be prompted")
        cmd.set_defaults(func=func)
    cmd = sub.add_parser("reprocess")
    cmd.add_argument("--failed", action="store_true", help="only failed or stuck assets")
    cmd.set_defaults(func=reprocess)
    cmd = sub.add_parser("verify")
    cmd.set_defaults(func=verify)

    args = parser.parse_args()
    init_engine()
    try:
        await args.func(args)
    finally:
        await dispose_engine()


if __name__ == "__main__":
    asyncio.run(_main())
